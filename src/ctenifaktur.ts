#!/usr/bin/env node
/**
 * Čtení Faktur CLI — tenká slupka nad veřejným API `/api/v1`.
 *
 * Záměrně bez jediné závislosti: tenhle soubor je celý balíček. Když bude
 * potřeba sáhnout po něčem z aplikace, znamená to, že to chybí ve veřejném API,
 * a doplnit se to má tam, ne sem.
 *
 * Klíč se bere z `ctenifaktur login`, nebo z `CF_API_KEY`, když má přednost mít
 * prostředí (CI, kontejner). Adresu API mění `CF_API_URL`, výchozí je
 * https://ctenifaktur.cz.
 */

import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";

const API_URL = (process.env.CF_API_URL ?? "https://ctenifaktur.cz").replace(/\/+$/, "");

/**
 * Klíč z `login`. Nedrží se v konstantě jako dřív, protože se čte ze souboru, a
 * příkaz `login` musí projít i tehdy, když ještě žádný uložený není.
 */
let apiKey: string | undefined;

/**
 * Uložené klíče jdou do konfiguračního adresáře podle XDG, což je i na macOS
 * zvyk, na který uživatelé CLI koukají.
 */
function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "ctenifaktur", "credentials.json");
}

/**
 * Klíče se drží podle adresy API, aby si přihlášení k produkci a k vývojovému
 * serveru nepřepisovala jedno druhé. Kdo se přihlásí na obojí, přepíná mezi
 * nimi pouhým `CF_API_URL` a nemusí se přihlašovat znovu.
 */
type Credentials = Record<string, string>;

async function readCredentials(): Promise<Credentials> {
  const raw = await readFile(configPath(), "utf8").catch(() => "");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    // Ručně upravený nebo poškozený soubor nesmí shodit každý příkaz. Tváříme
    // se, že přihlášení není, což uživatele pošle na `login`.
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/**
 * Zapisuje se s právy 0600 a adresář s 0700. Bez toho by klíč na sdíleném
 * stroji přečetl kdokoli, a to je heslo do cizího účetnictví.
 */
async function writeCredentials(credentials: Credentials): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  // `writeFile` respektuje `mode` jen když soubor zakládá. U existujícího
  // souboru s volnějšími právy by se tiše nic nezměnilo.
  await chmod(path, 0o600);
}

/** Kolik čekat na odpověď API a kolik na dokončení jednoho `PUT`. */
const API_TIMEOUT_MS = 60_000;
const PUT_TIMEOUT_MS = 10 * 60_000;

/**
 * Kolikátý pokus po `429` je poslední. Limit je na klíč a minutu, takže ho
 * vyčerpá druhý běh vedle toho našeho, ne my sami: čekání na dávku se ptá
 * jednou za pět sekund. Vzdát se hned by znamenalo shodit běh nad dávkou,
 * která je už zaplacená a na serveru běží dál.
 */
const RATE_LIMIT_ATTEMPTS = 5;

/**
 * Strop na jedno čekání. Okno limitu je minuta, takže delší čekání by znamenalo
 * jen to, že server poslal nesmyslné `Retry-After`.
 */
const RATE_LIMIT_MAX_WAIT_MS = 90_000;

/**
 * Klíč jde v hlavičce `Authorization`, takže `http://` by ho poslalo v čitelné
 * podobě komukoli na trase. Povolujeme ho jen na localhostu, kde se s CLI dělá
 * vývoj a kde po drátě nic neteče.
 */
function assertSecureApiUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`CF_API_URL není platná adresa: ${url}`);
  }
  if (parsed.protocol === "https:") return;
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol === "http:" && local) return;
  fail(`CF_API_URL musí být https (mimo localhost), je ${parsed.protocol}//${parsed.host}`);
}

/**
 * `fetch` s časovým limitem. Bez něj zaseknuté spojení drží CLI navždy: strop
 * 30 minut v `pollUntilDone` se počítá mezi dotazy, takže se během visícího
 * požadavku nikdy nevyhodnotí.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Neúspěch = nenulový exit kód, jinak by se chyba ve skriptu ztratila. */
function fail(message: string): never {
  console.error(`Chyba: ${message}`);
  process.exit(1);
}

interface ApiError {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * Chybu z API hlásíme kódem i větou. Kód je stabilní kontrakt, na který se dá
 * navěsit větvení; věta je pro člověka a měnit se může.
 */
async function describeFailure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as ApiError;

  // Náš 429 kód v těle nese, ale 429 od brány před aplikací ne. Bez tohohle by
  // jediná chyba, u které dokumentace slibuje strojově čitelný kód před
  // dvojtečkou, byla zrovna ta, kde ho volající nenajde.
  if (response.status === 429 && !body.error?.code) {
    const retry = response.headers.get("retry-after");
    return `rate_limited: překročen limit požadavků${retry ? `, zkuste to za ${retry} s` : ""}`;
  }

  const code = body.error?.code ?? `http_${response.status}`;
  const detail = body.error?.message ?? response.statusText;
  return `${code}: ${detail}${formatDetails(body.error?.details)}`;
}

/**
 * Detaily z chybové odpovědi jako řádky pod hlášku.
 *
 * Dokumentace na ně u odmítnutí přímo posílá: smíšenou dávku má volající
 * rozdělit podle `details.documents[]`, export výpisů podle
 * `details.statements[]`. Zahodit je tedy znamená, že tu radu přes CLI nejde
 * uposlechnout, i když ji server poslal.
 */
function formatDetails(details: unknown): string {
  if (details === null || details === undefined) return "";

  const lines = Array.isArray(details)
    ? details.map((item) => `  - ${describeDetail(item)}`)
    : typeof details === "object"
      ? Object.entries(details as Record<string, unknown>).flatMap(([key, value]) =>
          Array.isArray(value)
            ? [`  ${key}:`, ...value.map((item) => `    - ${describeDetail(item)}`)]
            : [`  ${key}: ${describeDetail(value)}`],
        )
      : [`  ${describeDetail(details)}`];

  return lines.length > 0 ? `\n${lines.join("\n")}` : "";
}

/**
 * Jeden údaj na řádek. Objekt se rozepíše na `klíč=hodnota`, ne jako JSON: tyhle
 * řádky se čtou okem a grepují ve skriptu, a `id=… ico=…` je na obojí lepší než
 * uvozovky a složené závorky.
 */
function describeDetail(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(describeDetail).join(", ");
  return Object.entries(value as Record<string, unknown>)
    .map(([key, inner]) => `${key}=${inner === null || typeof inner !== "object" ? String(inner) : JSON.stringify(inner)}`)
    .join(" ");
}

/**
 * Jak dlouho čekat po `429`. Přednost má `Retry-After` od serveru, ten ví, kdy
 * se okno limitu překlopí; bez něj se čeká exponenciálně. Vteřina dole drží
 * `Retry-After: 0` od toho, aby se z opakování stala smyčka bez čekání.
 */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const clamp = (ms: number) => Math.min(Math.max(ms, 1000), RATE_LIMIT_MAX_WAIT_MS);
  if (!header) return clamp(2 ** attempt * 1000);

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);

  // RFC dovoluje i datum. Přijde od brány, naše API posílá vteřiny.
  const at = Date.parse(header);
  if (Number.isFinite(at)) return clamp(at - Date.now());

  return clamp(2 ** attempt * 1000);
}

/**
 * Jedno volání API: autorizace, kontrola chyby, syrová odpověď. Export si ji
 * bere takhle, protože nevrací JSON, ale bajty souboru.
 *
 * `429` se přečká a volání zopakuje. Limit je dočasný stav, ne chyba požadavku,
 * a opakovat je bezpečné: čtení jsou idempotentní ze své podstaty a zakládání
 * dávky drží `Idempotency-Key`, který se mezi pokusy nemění.
 *
 * @param hint Věta navíc, když ani opakování nepomůže. Slouží k tomu, aby po
 *   vyčerpaném limitu uprostřed čekání na dávku uživatel věděl, že zaplacená
 *   dávka běží dál, a čím si pro výsledek dojít.
 */
async function apiRequest(
  path: string,
  init: RequestInit = {},
  hint?: string,
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetchWithTimeout(
      `${API_URL}/api/v1${path}`,
      {
        ...init,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      },
      API_TIMEOUT_MS,
    );

    if (response.ok) return response;

    if (response.status === 429 && attempt < RATE_LIMIT_ATTEMPTS) {
      const wait = retryAfterMs(response, attempt);
      // Na chybový výstup, aby na stdout zůstaly jen řádky s id.
      console.error(
        `Limit požadavků vyčerpán, čekám ${Math.ceil(wait / 1000)} s (pokus ${attempt} z ${RATE_LIMIT_ATTEMPTS - 1}).`,
      );
      await sleep(wait);
      continue;
    }

    const message = await describeFailure(response);
    fail(hint ? `${message}\n${hint}` : message);
  }
}

async function api<T>(path: string, init: RequestInit = {}, hint?: string): Promise<T> {
  const response = await apiRequest(path, init, hint);
  return response.json() as Promise<T>;
}

interface AccountingUnit {
  id: string;
  name: string;
  ico: string;
  dic: string | null;
  vatPayer: string;
  accountingSystem: string | null;
}

/**
 * Načte klíč z terminálu, aniž by ho vypsal. Výzva jde na chybový výstup, aby
 * `login` fungoval i s přesměrovaným stdoutem.
 */
function readSecretFromTty(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const { stdin, stderr } = process;
    stderr.write(prompt);
    let value = "";

    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x0d || byte === 0x0a) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          stderr.write("\n");
          return resolve(value);
        }
        // Ctrl-C v raw režimu nedojde k výchozímu obslužníku, přerušení se
        // musí udělat ručně, jinak by šlo z výzvy odejít jen zabitím procesu.
        if (byte === 0x03) {
          stdin.setRawMode(false);
          stderr.write("\n");
          process.exit(130);
        }
        if (byte === 0x7f || byte === 0x08) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };

    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

/** Klíč z roury, aby šlo `echo "$KLIC" | ctenifaktur login` ze skriptu. */
async function readSecretFromPipe(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Klíč se schválně nedá předat přepínačem. Skončil by v historii shellu a v
 * seznamu procesů, což je přesně to, čemu se `login` vyhýbá; pro automatizaci
 * je tu `CF_API_KEY` a roura.
 */
async function cmdLogin(): Promise<void> {
  const key = process.stdin.isTTY
    ? await readSecretFromTty(`Klíč pro ${API_URL} (nevypisuje se): `)
    : await readSecretFromPipe();

  if (!key) fail("klíč je prázdný");
  if (!key.startsWith("cf_")) {
    // Typicky se sem vloží něco jiného, třeba id jednotky. Ověření níž by to
    // odhalilo taky, ale až chybou ze serveru, která to neřekne tak jasně.
    fail("tohle nevypadá jako API klíč, ten začíná na cf_");
  }

  // Ověřit dřív, než se uloží: uložený nefunkční klíč je horší než žádný,
  // protože se pak chyba objeví až u prvního nahrávání.
  apiKey = key;
  const { accountingUnits } = await api<{ accountingUnits: AccountingUnit[] }>("/accounting-units");

  const credentials = await readCredentials();
  credentials[API_URL] = key;
  await writeCredentials(credentials);

  console.log(`Přihlášeno k ${API_URL}, klíč uložen do ${configPath()}.`);
  console.log(`Účetní jednotky vypíše ctenifaktur units, klíč jich teď vidí ${accountingUnits.length}.`);
}

async function cmdLogout(): Promise<void> {
  const credentials = await readCredentials();
  if (!(API_URL in credentials)) {
    console.log(`K ${API_URL} nejste přihlášeni.`);
    return;
  }

  delete credentials[API_URL];
  if (Object.keys(credentials).length === 0) {
    await rm(configPath(), { force: true });
  } else {
    await writeCredentials(credentials);
  }
  console.log(`Odhlášeno od ${API_URL}. Klíč zneplatníte v aplikaci.`);
}

interface Credits {
  remaining: number;
  planRemaining: number;
  credits: number;
  plan: string;
  periodEnd: string;
}

/**
 * Čeština chce tvar podle počtu. Zvlášť od `filesLabel`, protože tady jde
 * o doklady, ne o soubory, a z jednoho souboru jich vzniká víc.
 */
function documentsLabel(count: number): string {
  if (count === 1) return "1 doklad";
  if (count > 1 && count < 5) return `${count} doklady`;
  return `${count} dokladů`;
}

/**
 * Kolik toho kancelář ještě zpracuje.
 *
 * Rozpad na tarif a kredity není kosmetika: tarifní část se k datu obnoví,
 * kreditová ne. Kdo plánuje velkou dávku na začátku měsíce, počítá s něčím
 * jiným než ten, kdo ji posílá poslední den období.
 */
async function cmdCredits(): Promise<void> {
  const state = await api<Credits>("/credits");
  const renews = new Date(state.periodEnd).toLocaleDateString("cs-CZ");

  console.log(`Zbývá ${documentsLabel(state.remaining)}.`);
  console.log(`Z toho tarif ${state.plan}: ${state.planRemaining} (obnoví se ${renews}), kredity: ${state.credits}.`);
  // U výpisů je to odhad: cena je za každé započaté tři strany a počet stran
  // zjistí server až při zpracování. Bez téhle věty by pětistránkový výpis
  // vypadal jako jeden doklad.
  console.log("U bankovních výpisů je to odhad, jejich cena se počítá po třech stranách.");
}

async function cmdUnits(): Promise<void> {
  const { accountingUnits } = await api<{ accountingUnits: AccountingUnit[] }>("/accounting-units");

  if (accountingUnits.length === 0) {
    console.log("Žádné účetní jednotky.");
    return;
  }

  for (const unit of accountingUnits) {
    const system = unit.accountingSystem ? `, ${unit.accountingSystem}` : "";
    console.log(`${unit.id}  ${unit.name} (IČO ${unit.ico}${system})`);
  }
}

interface CreateUploadResponse {
  batchId: string;
  uploads: Array<{ uploadId: string; fileName: string; uploadUrl: string; expiresAt: string }>;
}

interface BatchStatus {
  id: string;
  /**
   * Který endpoint dávku založil, a tím i ke kterému zdroji patří
   * `uploads[].documentIds`. Volitelné, protože starší server ho neposílá.
   */
  kind?: "documents" | "bank-statements";
  status: "pending" | "processing" | "completed" | "completed_with_failures" | "failed";
  counts: Record<string, number>;
  uploads: Array<{
    uploadId: string;
    fileName: string;
    status: string;
    documentIds: string[];
    /** Přítomné, jen když z nahrání vzniklo méně, než soubor obsahoval. */
    incomplete?: { discarded: number; unparsed: number };
    errorCode?: string;
  }>;
}

const TERMINAL = new Set(["completed", "completed_with_failures", "failed"]);

/** Stavy jednoho nahrání, u kterých se ještě čeká na výsledek. */
const RUNNING = new Set(["pending", "processing"]);

/** Kolikrát zkusit `PUT` do úložiště, než soubor prohlásíme za nenahraný. */
const PUT_ATTEMPTS = 3;

/**
 * Kolik souborů posílat najednou. Dávka může mít až 300 souborů po 25 MB a
 * každý se před odesláním načte celý do paměti, takže bez tohohle stropu by
 * špička byla jednotky gigabajtů a stovky souběžných spojení. Se čtyřmi
 * pracovníky je špička daná velikostí souborů, ne velikostí dávky.
 */
const PUT_CONCURRENCY = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Čeština chce tvar podle počtu, jinak CLI hlásí „1 souborů". Nula sem nedojde:
 * `cmdUpload` na ní končí přes `fail` ještě před výpisem.
 */
function filesLabel(count: number): string {
  if (count === 1) return "1 soubor";
  if (count < 5) return `${count} soubory`;
  return `${count} souborů`;
}

/**
 * Přípona → MIME. Typ se deklaruje podle přípony a nehádá se z obsahu, aby
 * soubor dorazil pod tím, čím se jmenuje.
 */
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  tiff: "image/tiff",
  tif: "image/tiff",
  isdoc: "application/xml",
  xml: "application/xml",
  // Jen pro výpisy: CSV report z platební brány. Na `/documents` ho server
  // odmítne s `unsupported_file_type`, což je správná odpověď — fakturou CSV
  // report není.
  csv: "text/csv",
};

/**
 * Soubor bez přípony hlásíme jako PDF, protože to je typický případ (doklad
 * stažený z internetového bankovnictví). Neznámá přípona jde stejnou cestou a
 * server ji odmítne s `unsupported_file_type`, což je srozumitelnější než
 * hádání typu tady.
 */
function contentTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return "application/pdf";
  return CONTENT_TYPES[lower.slice(dot + 1)] ?? "application/pdf";
}

/**
 * Pošle jeden soubor na předpodepsanou adresu. Vrací, jestli se to povedlo.
 *
 * Opakování je na nás, protože veřejné API nemá kam selhání nahlásit. Adresa
 * platí 15 minut, takže na pár pokusů je prostor, a úspěšný druhý pokus je pro
 * server nerozeznatelný od pomalého prvního.
 */
async function putFile(
  uploadUrl: string,
  source: { path: string; fileName: string },
): Promise<boolean> {
  const bytes = await readFile(source.path);

  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt++) {
    try {
      const put = await fetchWithTimeout(
        uploadUrl,
        { method: "PUT", body: bytes },
        PUT_TIMEOUT_MS,
      );
      if (put.ok) return true;
      // 4xx od úložiště je odmítnutí, ne výpadek; opakování ho nespraví.
      if (put.status < 500) {
        console.error(`Nahrání selhalo: ${source.fileName} (HTTP ${put.status})`);
        return false;
      }
    } catch {
      // Síťová chyba, zkusíme znovu.
    }
    if (attempt === PUT_ATTEMPTS) {
      console.error(`Nahrání selhalo: ${source.fileName} (pokusů: ${PUT_ATTEMPTS})`);
    } else {
      await sleep(attempt * 1000);
    }
  }
  return false;
}

/** Druh dokumentu, který se nahrává. Určuje endpoint, nic se nehádá z obsahu. */
type UploadKind = "document" | "statement";

const UPLOAD_ENDPOINT: Record<UploadKind, string> = {
  document: "/documents",
  statement: "/bank-statements",
};

/**
 * Nahraje soubory a počká na dokončení.
 *
 * Dva kroky veřejného API (POST → PUT) schováváme schválně: z pohledu uživatele
 * je nahrání jedna operace. Presigned PUT je bez hlaviček, takže se posílají
 * holé bajty.
 *
 * `kind` je vlastní příkaz, ne přepínač: kdyby se druh dokumentu zadával
 * volitelným `--statement`, znamenalo by zapomenout ho stejně jako dnes
 * „tohle je faktura", a výpis vytěžený jako faktura projde, zaplatí se a
 * exportuje se jako faktura od banky s nulovými částkami.
 */
async function cmdUpload(
  files: string[],
  kind: UploadKind,
  unitId?: string,
  idempotencyKey?: string,
): Promise<void> {
  if (files.length === 0) fail("zadejte alespoň jeden soubor");

  const descriptors = await Promise.all(
    files.map(async (path) => {
      const info = await stat(path).catch(() => fail(`soubor neexistuje: ${path}`));
      // Adresář projde `stat` bez potíží, takže bez téhle kontroly se za něj
      // stihne rezervovat kredit a teprve `readFile` spadne na EISDIR.
      if (!info.isFile()) fail(`není to soubor: ${path}`);
      const fileName = basename(path);
      return {
        path,
        fileName,
        contentType: contentTypeFor(fileName),
        sizeBytes: info.size,
      };
    }),
  );

  // Náhodný klíč chrání jen proti opakovanému doručení TOHOTO volání, ne proti
  // ručnímu spuštění znovu: to by dostalo nový klíč a strhlo kredity podruhé.
  // Kdo spouští CLI ze skriptu nebo z cronu a chce, aby byl opakovaný běh
  // bezpečný, musí klíč dodat sám přes --idempotency-key a při opakování ho
  // použít stejný.
  const key = idempotencyKey ?? crypto.randomUUID();

  const prepared = await api<CreateUploadResponse>(UPLOAD_ENDPOINT[kind], {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify({
      ...(unitId ? { accountingUnitId: unitId } : {}),
      files: descriptors.map(({ fileName, contentType, sizeBytes }) => ({
        fileName,
        contentType,
        sizeBytes,
      })),
    }),
  });

  // Párování je poziční, tak ať se to pozná, kdyby to server někdy přestal
  // dodržovat: jinak by CLI tiše poslalo obsah jednoho souboru na adresu
  // vydanou pro jiný a uživatel by dostal doklad pod cizím jménem.
  if (prepared.uploads.length !== descriptors.length) {
    fail(
      `server vrátil ${prepared.uploads.length} adres na ${descriptors.length} souborů`,
    );
  }
  const mismatch = prepared.uploads.findIndex(
    (upload, i) => upload.fileName !== descriptors[i].fileName,
  );
  if (mismatch !== -1) {
    fail(
      `adresa č. ${mismatch + 1} patří souboru ${prepared.uploads[mismatch].fileName}, ne ${descriptors[mismatch].fileName}`,
    );
  }

  // Klíčem je `uploadId`, ne jméno souboru: `doklady/leden/faktura.pdf` a
  // `doklady/unor/faktura.pdf` mají stejný `basename`, takže podle jména by se
  // neúspěch jednoho přilepil i tomu druhému a množina by je navíc sloučila do
  // jednoho prvku, čímž by přestal sedět počet.
  const failed = new Set<string>();
  let nextUpload = 0;
  const sendNextUploads = async () => {
    for (;;) {
      // Bezpečné bez zámku: mezi čtením a zvýšením není `await`, takže si dva
      // pracovníci nemůžou sáhnout na stejný index.
      const index = nextUpload++;
      if (index >= prepared.uploads.length) return;
      const source = descriptors[index];
      if (!(await putFile(prepared.uploads[index].uploadUrl, source))) {
        failed.add(prepared.uploads[index].uploadId);
      }
    }
  };
  await Promise.all(Array.from({ length: PUT_CONCURRENCY }, sendNextUploads));

  const uploaded = prepared.uploads.length - failed.size;
  if (uploaded === 0) {
    // Čekat na dávku, o které víme, že do ní nic nedorazilo, by znamenalo
    // sledovat ukazatel až do úklidu po 30 minutách. Kredit se vrátí sám.
    fail("nenahrál se ani jeden soubor, kredity se vrátí automaticky");
  }

  console.log(`Dávka ${prepared.batchId}, zpracovávám ${filesLabel(uploaded)}…`);
  await pollUntilDone(prepared.batchId, failed);
}

/**
 * @param notUploaded `uploadId` nahrání, která se vůbec nedostala do úložiště.
 *
 * Bez nich by CLI po jednom neúspěšném `PUT` čekalo skoro půl hodiny: dávka se
 * do konečného stavu dostane až poté, co takové nahrání zahodí úklid po
 * vypršení lhůty. My ale víme hned tady, že už nedorazí, takže se čeká jen na
 * soubory, které opravdu odešly, a ve výpisu se nehlásí jako rozpracované.
 */
async function pollUntilDone(
  batchId: string,
  notUploaded: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Zpracování jednoho dokladu trvá desítky sekund, takže vteřinový polling by
  // jen pálil rate limit. Strop drží CLI použitelné i u velkých dávek.
  const started = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000;

  // Dávka je v tuhle chvíli zaplacená a běží na serveru, takže každý konec
  // tady je konec čekání, ne konec zpracování. Bez téhle věty vypadá vyčerpaný
  // limit jako ztracená dávka a uživatel ji nahraje a zaplatí podruhé.
  const hint = `Dávka běží na serveru dál, výsledek zjistíte příkazem: ctenifaktur status ${batchId}`;

  for (;;) {
    const batch = await api<BatchStatus>(`/batches/${batchId}`, {}, hint);
    if (TERMINAL.has(batch.status)) {
      printBatch(batch, notUploaded);
      // `completed_with_failures` je taky neúspěch, jen částečný. Vracet 0 by
      // znamenalo, že cron nebo import kolem CLI považuje dávku, ve které se
      // část dokladů nezpracovala, za vyřízenou, a nikdo se o chybějící doklady
      // nedozví. Výpis výš říká, který soubor to byl.
      if (batch.status !== "completed") process.exit(1);
      return;
    }

    if (notUploaded.size > 0) {
      const settled = batch.uploads.filter(
        (upload) => upload.status === "completed" || upload.status === "failed",
      ).length;
      if (settled >= batch.uploads.length - notUploaded.size) {
        printBatch(batch, notUploaded);
        process.exit(1);
      }
    }

    if (Date.now() - started > TIMEOUT_MS) {
      fail(`dávka ${batchId} se nedokončila do 30 minut, stav: ${batch.status}`);
    }
    await sleep(5000);
  }
}

/**
 * @param notUploaded `uploadId` nahrání, u kterých `PUT` selhal a server o nich
 *   ještě neví. Visí na `pending`, dokud je nezahodí úklid, takže bez téhle
 *   množiny by se hlásila jako rozpracovaná, přestože už nedorazí.
 */
function printBatch(batch: BatchStatus, notUploaded: ReadonlySet<string> = new Set()): void {
  for (const upload of batch.uploads) {
    if (upload.status === "completed") {
      console.log(`${upload.fileName}: ${upload.documentIds.join(", ")}`);
    } else if (RUNNING.has(upload.status) && !notUploaded.has(upload.uploadId)) {
      // `status` se volá i na rozpracovanou dávku, na to je ten příkaz. Hlásit
      // u nedokončeného souboru „selhalo" by poslalo uživatele nahrávat znovu
      // něco, co se zrovna zpracovává, a zaplatit to podruhé. Jde to na chybový
      // výstup, aby na stdout zůstaly jen řádky s id, které jdou rourou dál.
      console.error(`${upload.fileName}: zpracovává se`);
    } else if (notUploaded.has(upload.uploadId)) {
      console.error(`${upload.fileName}: selhalo (upload_not_received)`);
    } else {
      console.error(`${upload.fileName}: selhalo (${upload.errorCode ?? upload.status})`);
    }
    // Na chybový výstup, aby se `status` dal rourou poslat rovnou do exportu a
    // upozornění přitom neuteklo. Bez něj vypadá useknutá dávka jako hotová.
    if (upload.incomplete) {
      const { discarded, unparsed } = upload.incomplete;
      const parts = [
        discarded > 0 ? `nezpracováno: ${discarded}` : "",
        unparsed > 0 ? `bez vytěžených dat: ${unparsed}` : "",
      ].filter(Boolean);
      console.error(`${upload.fileName}: neúplné (${parts.join(", ")})`);
    }
  }
  // Druh se vypisuje jen u výpisů: ta id patří do `export-statement`, ne do
  // `export`, a bez téhle věty to z výpisu id nepozná ani člověk, ani skript
  // kolem CLI. U dokladů je druh výchozí a řádek navíc by jen šuměl.
  console.log(
    batch.kind === "bank-statements"
      ? `Stav dávky: ${batch.status} (bankovní výpisy)`
      : `Stav dávky: ${batch.status}`,
  );
}

async function cmdStatus(batchId?: string): Promise<void> {
  if (!batchId) fail("zadejte id dávky");
  const batch = await api<BatchStatus>(`/batches/${batchId}`);
  printBatch(batch);
  // Stejná úmluva jako u `upload`: hotová dávka, ve které něco selhalo, nesmí
  // skriptu kolem CLI vyjít jako v pořádku. Rozpracovaná dávka selhání není,
  // proto se nula vrací i pro `pending` a `processing`.
  if (TERMINAL.has(batch.status) && batch.status !== "completed") process.exit(1);
}

async function cmdExport(
  ids: string[],
  kind: UploadKind,
  format: string,
  output?: string,
): Promise<void> {
  const isStatement = kind === "statement";
  if (ids.length === 0) {
    fail(isStatement ? "zadejte alespoň jedno id výpisu" : "zadejte alespoň jedno id dokladu");
  }

  // Doklady i výpisy mají vlastní endpoint a vlastní jméno pole. Poslat id
  // výpisů do exportu dokladů by skončilo na `not_found`, protože jsou to dvě
  // oddělené sady id.
  const response = await apiRequest(
    isStatement ? "/bank-statements/export" : "/documents/export",
    {
      method: "POST",
      body: JSON.stringify(
        isStatement ? { statementIds: ids, format } : { documentIds: ids, format },
      ),
    },
  );

  // Jméno bere z Content-Disposition, aby se soubor jmenoval stejně jako při
  // stažení z aplikace. Přes `basename`, protože je to hodnota z hlavičky:
  // `filename="../../.bashrc"` by jinak zapsalo mimo pracovní adresář. `--out`
  // se nechává tak, jak ho zadal uživatel, ten cestu volí schválně.
  const disposition = response.headers.get("content-disposition") ?? "";
  const suggested = /filename="([^"]+)"/.exec(disposition)?.[1];
  const target = output ?? (suggested ? basename(suggested) : `export-${format}`);

  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  console.log(target);
}

function usage(): void {
  console.log(`Čtení Faktur CLI
Nahrání dokladů a stažení exportů z příkazové řádky.

Příkazy:
  login
    Zeptá se na API klíč, ověří ho a uloží. Při psaní se klíč nevypisuje a
    nezůstane v historii shellu. Ze skriptu jde poslat rourou:
    echo "$KLIC" | ctenifaktur login

  logout
    Smaže uložený klíč pro aktuální adresu API. Samotný klíč tím nezaniká,
    zneplatnit se dá jen v aplikaci.

  units
    Vypíše účetní jednotky. Z prvního sloupce vezmete id pro --unit.

  credits
    Kolik dokladů kancelář ještě zpracuje, rozpadlé na tarifní kvótu a
    kredity. Kvóta se obnovuje k uvedenému datu, kredity ne. U výpisů je to
    odhad, jejich cena se počítá za každé započaté tři strany.

  upload <soubor...> [--unit <id>] [--idempotency-key <klíč>]
    Nahraje soubory a počká na vytěžení. U každého vypíše id vzniklých
    dokladů; z jednoho souboru jich může vzniknout víc. Bez --unit zůstanou
    doklady nezařazené a jednotku jim přiřadíte v aplikaci.
    Nahrání stojí kredit za každý vytěžený doklad.

  upload-statement <soubor...> [--unit <id>] [--idempotency-key <klíč>]
    Nahraje bankovní výpisy a počká na vytěžení. Bere PDF, obrázek nebo CSV
    report z platební brány; z jednoho souboru může vzniknout víc výpisů.
    Zpracování stojí kredit za každé započaté 3 strany, CSV report 1 kredit.
    Vlastní příkaz schválně: kdyby to byl přepínač u upload, zapomenout ho by
    znamenalo nechat výpis vytěžit jako fakturu.

  status <id-dávky>
    Zopakuje výpis dávky. Hodí se, když upload skončil dřív než zpracování;
    dávka běží dál na serveru a doklady se neztratí. U dávky výpisů to řekne,
    ať se id nepošlou do špatného exportu.

  export <id-dokladu...> --format <isdoc|pohoda|money-s3> [--out <soubor>]
    Uloží hotový soubor a vypíše jeho jméno. Bez --out se jmenuje stejně jako
    při stažení z aplikace, s --out se existující soubor přepíše. Všechny
    doklady musí patřit jedné účetní jednotce. Pohoda a Money S3 vracejí vždy
    jedno XML, ISDOC u jednoho dokladu soubor .isdoc a u více dokladů ZIP.

  export-statement <id-výpisu...> --format <gpc|sepa-xml> [--out <soubor>]
    Uloží hotový soubor s bankovními výpisy. Víc výpisů dá jeden soubor v obou
    formátech. Na rozdíl od dokladů se výpisy nemusí shodovat v účetní
    jednotce. Formát čísla účtu se bere z nastavení v aplikaci.
    Oba formáty vyžadují číslo účtu. Sestava z platební brány ho na sobě nemá,
    takže u ní export projde teprve po doplnění účtu v aplikaci.

Příklad:
  ctenifaktur upload doklady/*.pdf --unit 6a5b41d8e7c204f93a1b8e62
  ctenifaktur export e48428a7-52af-4dc2-981f-dfba661a71ae \\
      af668802-4304-4623-9ec4-fd89293e69e0 --format pohoda --out import.xml
  ctenifaktur upload-statement vypis-07.pdf
  ctenifaktur export-statement 0f9c1d64-1f2f-4d0e-9a1c-6b1d2b7e5a11 \\
      --format gpc --out vypis.gpc

Přihlášení:
  Klíč vydáte v aplikaci v sekci Tým a nastavení, část API klíče, a předáte ho
  příkazem ctenifaktur login. Uloží se s právy 0600 do
  ~/.config/ctenifaktur/credentials.json, zvlášť pro každou adresu API.

Proměnné prostředí:
  CF_API_KEY   klíč; má přednost před uloženým, hodí se v CI a v kontejneru
  CF_API_URL   adresa API, výchozí https://ctenifaktur.cz

Návratové kódy:
  0   dávka doběhla celá, u status i dávka, která ještě běží
  1   chyba, nebo dávka doběhla jen zčásti (stav completed_with_failures);
      úspěšné doklady z výpisu výš platí a jdou exportovat

Limity:
  25 MB na soubor, 300 souborů na dávku, 500 dokladů na jeden export dokladů,
  100 výpisů na jeden export výpisů.

Limit požadavků:
  Počítá se na klíč a minutu. Když se vyčerpá, CLI počká podle hlavičky
  Retry-After a zkusí to znovu. Když ani opakování nestačí, běh skončí chybou,
  ale zaplacená dávka běží na serveru dál a dojdete si pro ni příkazem
  ctenifaktur status <id-dávky>.

Opakované spuštění:
  Ze skriptu nebo z cronu předejte vlastní --idempotency-key a při opakování
  použijte tentýž. Jinak se doklady zpracují a zaplatí podruhé.

Dokumentace:
  https://ctenifaktur.cz/napoveda/api/pripojeni-pres-api
  https://ctenifaktur.cz/api/v1/openapi.json`);
}

/** Odloupne `--jméno hodnota` z argumentů a vrátí zbytek jako poziční. */
function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  // Bez téhle kontroly by `--unit --idempotency-key klic` nastavilo jednotku na
  // řetězec `--idempotency-key` a klíč zahodilo, obojí tiše.
  if (value === undefined || value.startsWith("--")) {
    fail(`chybí hodnota pro --${name}`);
  }
  args.splice(index, 2);
  return value;
}

/**
 * Po odloupnutí známých přepínačů nesmí zbýt žádný další.
 *
 * Jen je vyfiltrovat a jet dál je horší než se zastavit: přepínač zmizí, ale
 * hodnota za ním propadne mezi poziční argumenty. `upload faktura.pdf --out
 * export.xml`, tedy záměna s exportem, by tak nahrálo a zaplatilo i
 * `export.xml`; u exportu by se z hodnoty stalo id navíc.
 */
function rejectUnknownFlags(args: string[]): void {
  const unknown = args.find((arg) => arg.startsWith("--"));
  if (unknown) fail(`neznámý přepínač: ${unknown}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === "help" || command === "--help") {
    usage();
    return;
  }
  // Před `login` taky: klíč se nemá poslat na `http://` vzdálený server ani
  // tehdy, když ho uživatel teprve zadává.
  assertSecureApiUrl(API_URL);

  if (command === "login") return cmdLogin();
  if (command === "logout") return cmdLogout();

  // Prostředí má přednost před uloženým klíčem, aby si CI a kontejnery mohly
  // vnutit svůj, aniž by se v nich muselo přihlašovat.
  apiKey = process.env.CF_API_KEY || (await readCredentials())[API_URL];
  if (!apiKey) {
    fail(`nejste přihlášeni k ${API_URL}, spusťte ctenifaktur login`);
  }

  switch (command) {
    case "units":
      return cmdUnits();
    case "credits":
      return cmdCredits();
    case "upload":
    case "upload-statement": {
      // `takeFlag` mutuje `rest`, takže po něm v něm zbývají jen poziční
      // argumenty a případný přepínač, který neznáme.
      const unit = takeFlag(rest, "unit");
      const key = takeFlag(rest, "idempotency-key");
      rejectUnknownFlags(rest);
      return cmdUpload(
        rest,
        command === "upload-statement" ? "statement" : "document",
        unit,
        key,
      );
    }
    case "status":
      return cmdStatus(rest[0]);
    case "export":
    case "export-statement": {
      const format = takeFlag(rest, "format");
      const output = takeFlag(rest, "out");
      // Dřív než hlášení o chybějícím --format: u překlepu (`--frmat gpc`) je
      // jméno toho přepínače užitečnější odpověď než „chybí --format".
      rejectUnknownFlags(rest);
      if (!format) fail("chybí --format");
      return cmdExport(
        rest,
        command === "export-statement" ? "statement" : "document",
        format,
        output,
      );
    }
    default:
      fail(`neznámý příkaz: ${command}`);
  }
}

/**
 * Nedostupný server, vypnutá síť, špatné DNS nebo vypršený časový limit skončí
 * odmítnutým příslibem. Bez tohohle by z toho Node udělal neodchycenou výjimku
 * a vypsal `TypeError: fetch failed` se zásobníkem z undici, což vypadá jako
 * pád nástroje, ne jako nedostupná protistrana.
 */
main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError") {
    fail(`server neodpověděl včas: ${API_URL}`);
  }
  // `fetch` hlásí každý výpadek spojení jako `TypeError: fetch failed` a to
  // konkrétní (ECONNREFUSED, ENOTFOUND) schová do `cause`. Bez ní by hláška
  // neřekla, jestli je vypnutá síť, nebo jen překlep v adrese.
  if (error instanceof TypeError && error.message === "fetch failed") {
    const detail = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    fail(`spojení se serverem selhalo${detail} (${API_URL})`);
  }
  // Všechno ostatní je chyba na naší straně, třeba nezapsatelný cílový soubor.
  // Tvrdit i u ní, že selhalo spojení, by poslalo hledání úplně jinam.
  fail(`neočekávaná chyba: ${error instanceof Error ? error.message : String(error)}`);
});

/**
 * `ctenifaktur login` — getting a key without transcribing one.
 *
 * The command used to have exactly one job: read a secret somebody had already
 * minted in the browser and store it. Now it has two, and the tests are about
 * the seam between them. Which path a run takes is decided from the
 * environment, and getting that wrong is expensive in both directions: a
 * pipeline that suddenly waits on a browser hangs a build, and a person at a
 * terminal who is asked to paste a key is back to the ten-step round trip the
 * flow exists to remove.
 *
 * The browser half is driven with `--no-browser`, which asks for the flow
 * without opening anything. Nothing here may actually spawn a browser: a test
 * suite that opens tabs on the machine running it is a test suite people stop
 * running.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub } from "./helpers.mjs";

const UNITS = [
  { id: "unit-1", name: "Tichá linka", ico: "12345678", dic: null, vatPayer: "no", accountingSystem: null },
];

const APPROVED = {
  status: "approved",
  apiKey: "cf_live_vydany-klic",
  keyName: "CLI 0.5.0 na testovacim-stroji",
  workspace: { id: "ws-1", name: "Tichá linka" },
  scopes: ["documents:read", "documents:write"],
};

describe("login přes prohlížeč", () => {
  test("vypíše kód, počká na potvrzení a uloží vydaný klíč", async () => {
    const stub = await startStub({
      accountingUnits: UNITS,
      device: { polls: [{ status: "pending" }, APPROVED] },
    });

    try {
      const result = await runCli(["login", "--no-browser"], {
        base: stub.base,
        // Prázdný, aby se ověřilo, že klíč opravdu přinesl tenhle běh, a ne
        // proměnná z prostředí testu.
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 0);
      // Bez `--json` jde věta pro člověka na standardní výstup, jak to dělá
      // `note()` u každého jiného příkazu. Že se to pod `--json` překlopí na
      // chybový, hlídá test níž.
      assert.match(result.stdout, /U B Y 7 - Y Q R 2/);
      assert.match(result.stdout, /pripojeni-cli\?kod=UBY7-YQR2/);
      assert.match(result.stdout, /Tichá linka/);
      assert.equal(stub.received.devicePolls, 2);
    } finally {
      await stub.close();
    }
  });

  test("řekne terminálu jméno, pod kterým klíč v aplikaci najdou", async () => {
    const stub = await startStub({
      accountingUnits: UNITS,
      device: { polls: [APPROVED] },
    });

    try {
      const result = await runCli(["login", "--no-browser"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /CLI 0\.5\.0 na testovacim-stroji/);
      // Zneplatnění je jinde než vydání, a to je jediná věta, která to řekne.
      assert.match(result.stdout, /Tým a nastavení/);
      // Terminál o sobě něco poví, jinak by klíč v seznamu neměl jméno.
      assert.match(stub.received.deviceStarts[0].clientLabel, /^CLI .* na /);
    } finally {
      await stub.close();
    }
  });

  /**
   * Odmítnutí musí skončit nenulovým kódem. Nula by ve skriptu znamenala
   * „přihlášeno" a další příkaz by spadl až na chybějícím klíči, což je o dva
   * kroky dál, než kde se to rozhodlo.
   */
  test("nepovolené přihlášení skončí chybou, ne tichou nulou", async () => {
    const stub = await startStub({ device: { polls: [{ status: "denied" }] } });

    try {
      const result = await runCli(["login", "--no-browser"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /nepovolili/);
    } finally {
      await stub.close();
    }
  });

  test("vypršený kód pošle člověka zpátky na login, ne do nekonečné smyčky", async () => {
    const stub = await startStub({ device: { polls: [{ status: "expired" }] } });

    try {
      const result = await runCli(["login", "--no-browser"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /vypršela/);
      assert.match(result.stderr, /ctenifaktur login/);
    } finally {
      await stub.close();
    }
  });

  /**
   * `slow_down` není chyba, jen pokyn ubrat. Kdyby na něm běh skončil,
   * přihlášení by padalo na tom, že se CLI zeptalo o milisekundu dřív.
   */
  test("na slow_down přidá a ptá se dál", async () => {
    const stub = await startStub({
      accountingUnits: UNITS,
      device: { polls: [{ status: "slow_down" }, APPROVED] },
    });

    try {
      const result = await runCli(["login", "--no-browser"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 0);
      assert.equal(stub.received.devicePolls, 2);
    } finally {
      await stub.close();
    }
  });

  test("pod --json je to jeden dokument a kód je na chybovém výstupu", async () => {
    const stub = await startStub({
      accountingUnits: UNITS,
      device: { polls: [APPROVED] },
    });

    try {
      const result = await runCli(["--json", "login", "--no-browser"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
      });

      assert.equal(result.code, 0);
      assert.deepEqual(JSON.parse(result.stdout), {
        apiUrl: stub.base,
        loggedIn: true,
        accountingUnitCount: 1,
        workspace: { id: "ws-1", name: "Tichá linka" },
      });
      assert.equal(result.stdout.trimEnd().split("\n").length, 1);
      assert.match(result.stderr, /U B Y 7 - Y Q R 2/);
    } finally {
      await stub.close();
    }
  });
});

describe("login s ručním klíčem", () => {
  /**
   * Roura je to, čím se přihlašuje CI, a ta nemá prohlížeč ani terminál. Že se
   * po ní nesáhne po device flow, je celý důvod, proč se cesta rozhoduje podle
   * prostředí a ne podle přepínače.
   */
  test("klíč z roury se uloží, aniž by se cokoli otevíralo", async () => {
    const stub = await startStub({ accountingUnits: UNITS });

    try {
      const result = await runCli(["login"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
        stdin: "cf_live_rucne-vydany\n",
      });

      assert.equal(result.code, 0);
      assert.match(result.stdout, /klíč uložen|Klíč uložen/i);
      // Nic z device flow se nespustilo.
      assert.equal(stub.received.devicePolls, 0);
      assert.equal(stub.received.deviceStarts.length, 0);
    } finally {
      await stub.close();
    }
  });

  test("vložený nesmysl se odmítne dřív, než se na něj někdo zeptá serveru", async () => {
    const stub = await startStub({ accountingUnits: UNITS });

    try {
      const result = await runCli(["login"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
        stdin: "unit-1\n",
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /cf_/);
    } finally {
      await stub.close();
    }
  });

  test("login nepřijímá poziční argumenty", async () => {
    const stub = await startStub({});

    try {
      const result = await runCli(["login", "cf_live_neco"], {
        base: stub.base,
        env: { CF_API_KEY: "" },
        stdin: "",
      });

      assert.equal(result.code, 1);
      assert.match(result.stderr, /poziční/);
    } finally {
      await stub.close();
    }
  });
});

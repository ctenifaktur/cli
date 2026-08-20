/**
 * `--json` — the machine-readable mode.
 *
 * Both promises of the flag break silently, so both are asserted here rather
 * than eyeballed: standard output carries exactly one valid JSON document and
 * nothing else, and that document is the public `/api/v1` response passed
 * through rather than a shape invented here. A stray progress line on stdout
 * does not look wrong in a terminal, it only breaks `jq` in somebody's
 * pipeline. The third promise is negative and lives at the bottom: without the
 * flag not one byte of the output changed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runCli, startStub, tempDir, writeFixture } from "./helpers.mjs";

const DOC_A = "e48428a7-52af-4dc2-981f-dfba661a71ae";
const DOC_B = "af668802-4304-4623-9ec4-fd89293e69e0";
const TIMEOUT = 30_000;

/**
 * Parses stdout and asserts it holds exactly one document. Split into lines
 * first, because `JSON.parse` alone would not tell a truncated document apart
 * from two of them, and two is the regression this mode invites.
 */
function onlyDocument(stdout) {
  const lines = stdout.split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, `stdout není jeden dokument:\n${stdout}`);
  return JSON.parse(lines[0]);
}

/** A batch as the API sends it, with every field the contract requires. */
function batch(status, uploads, extra = {}) {
  return {
    id: "batch-1",
    kind: "documents",
    status,
    accountingUnitId: "6a5b41d8e7c204f93a1b8e62",
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:04:00.000Z",
    completedAt: "2026-08-20T09:04:00.000Z",
    // Derived from the uploads rather than hardcoded, because that is the one
    // property a real batch always has: `counts` and `uploads[]` agree.
    counts: {
      total: uploads.length,
      pending: uploads.filter((u) => u.status === "pending").length,
      processing: uploads.filter((u) => u.status === "processing").length,
      completed: uploads.filter((u) => u.status === "completed").length,
      failed: uploads.filter((u) => u.status === "failed").length,
    },
    uploads,
    ...extra,
  };
}

function upload(fileName, status, extra = {}) {
  return { uploadId: `up-${fileName}`, fileName, status, documentIds: [], ...extra };
}

describe("--json: reading data", () => {
  test("units answers with the endpoint's envelope, not a bare array", async () => {
    // Unwrapping the envelope would hand back a different shape than the
    // endpoint the caller is reading in the OpenAPI document.
    const units = [
      {
        id: "6a5b41d8e7c204f93a1b8e62",
        name: "Ukázková firma s.r.o.",
        ico: "12345679",
        dic: "CZ12345679",
        vatPayer: "yes",
        accountingSystem: "pohoda",
      },
    ];
    const stub = await startStub({ accountingUnits: units });

    const result = await runCli(["--json", "units"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(onlyDocument(result.stdout), { accountingUnits: units });
  });

  test("credits answers with the balance object unchanged", async () => {
    const credits = {
      remaining: 72,
      planRemaining: 60,
      credits: 12,
      plan: "business",
      periodEnd: "2026-09-01T00:00:00.000Z",
    };
    const stub = await startStub({ credits });

    const result = await runCli(["--json", "credits"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(onlyDocument(result.stdout), credits);
    // The estimate caveat is a sentence for a human; it must not end up as a
    // field nobody asked for, nor on stdout next to the document.
    assert.doesNotMatch(result.stdout, /odhad/);
  });

  test("status passes the batch through whole, fields the CLI never reads included", async () => {
    // The CLI's own `BatchStatus` names only what the text output needs.
    // Rebuilt from that interface rather than passed through, the document
    // would silently lose every other field the server sent.
    const snapshot = batch("completed", [
      upload("faktura-01.pdf", "completed", { documentIds: [DOC_A] }),
      upload("faktura-02.pdf", "completed", { documentIds: [DOC_B] }),
    ]);
    const stub = await startStub({ batches: [snapshot] });

    const result = await runCli(["--json", "status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(onlyDocument(result.stdout), snapshot);
    assert.equal(result.stderr, "");
  });

  test("a partial batch keeps its per-file reasons and still exits 1", async () => {
    const stub = await startStub({
      batches: [
        batch("completed_with_failures", [
          upload("ok.pdf", "completed", { documentIds: [DOC_A] }),
          upload("scan.pdf", "completed", {
            documentIds: [DOC_B],
            incomplete: { discarded: 1, unparsed: 2 },
          }),
          upload("rozbite.pdf", "failed", { errorCode: "source_rejected" }),
        ]),
      ],
    });

    const result = await runCli(["--json", "status", "batch-1"], stub);
    await stub.close();

    // Unchanged from the text mode: a finished batch with failures is not
    // a clean run, whatever the output format.
    assert.equal(result.code, 1);
    const document = onlyDocument(result.stdout);
    assert.equal(document.status, "completed_with_failures");
    assert.deepEqual(
      document.uploads.filter((u) => u.errorCode).map((u) => [u.fileName, u.errorCode]),
      [["rozbite.pdf", "source_rejected"]],
    );
    assert.deepEqual(document.uploads[1].incomplete, { discarded: 1, unparsed: 2 });
  });

  test("an unfinished batch is a document too, and still exits 0", async () => {
    const stub = await startStub({
      batches: [batch("processing", [upload("faktura.pdf", "processing")])],
    });

    const result = await runCli(["--json", "status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.equal(onlyDocument(result.stdout).uploads[0].status, "processing");
  });
});

describe("--json: upload", () => {
  test("ends with one document, and it is the same shape status returns", async () => {
    const dir = await tempDir();
    await writeFixture(dir, "faktura.pdf");

    const finished = batch("completed", [
      { uploadId: "u1", fileName: "faktura.pdf", status: "completed", documentIds: [DOC_A] },
    ]);
    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [finished],
    });

    const result = await runCli(["--json", "upload", "faktura.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 0);
    // Identical to `status --json` on the same batch, so a run that was killed
    // and one that finished are read by the same parser.
    assert.deepEqual(onlyDocument(result.stdout), finished);
  });

  test("the batch id moves to stderr, where a killed run can still be recovered from", async () => {
    // In text mode this line is on stdout. Left there it would be a second
    // document; dropped altogether, an upload killed by a tool timeout would
    // lose the only reference to a batch that is already paid for.
    const dir = await tempDir();
    await writeFixture(dir, "faktura.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [
        batch("completed", [
          { uploadId: "u1", fileName: "faktura.pdf", status: "completed", documentIds: [DOC_A] },
        ]),
      ],
    });

    const result = await runCli(["--json", "upload", "faktura.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.match(result.stderr, /Dávka batch-1, zpracovávám 1 soubor…/);
    // Through `onlyDocument`, so this also fails if the line lands on stdout
    // as a second document rather than merely being absent from the first.
    assert.equal(onlyDocument(result.stdout).id, "batch-1");
  });

  test("a file whose PUT never landed is reported with the code the API defines", { timeout: TIMEOUT }, async () => {
    // The server still has it at `pending` and will write `upload_not_received`
    // itself once the cleanup runs. Writing it half an hour early is the same
    // value from the same enum, not a shape of our own.
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");
    await writeFixture(dir, "b.pdf");

    const stub = await startStub({
      documents: {
        batchId: "batch-1",
        uploads: [
          { uploadId: "up-a", fileName: "a.pdf" },
          { uploadId: "up-b", fileName: "b.pdf" },
        ],
      },
      putStatus: { "up-a": 403 },
      batches: [
        batch("processing", [
          { uploadId: "up-a", fileName: "a.pdf", status: "pending", documentIds: [] },
          { uploadId: "up-b", fileName: "b.pdf", status: "completed", documentIds: [DOC_A] },
        ]),
      ],
    });

    const result = await runCli(["--json", "upload", "a.pdf", "b.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 1);
    const document = onlyDocument(result.stdout);
    assert.deepEqual(
      document.uploads.map((u) => [u.fileName, u.status, u.errorCode]),
      [
        ["a.pdf", "failed", "upload_not_received"],
        ["b.pdf", "completed", undefined],
      ],
    );
    // `counts` has to move with it: `failed: 0` next to an upload with status
    // `failed` contradicts itself, and the server never sends that pairing.
    assert.equal(document.counts.failed, 1);
    assert.equal(document.counts.pending, 0);
    // Still `processing`, and deliberately so: the batch-level status is the
    // server's, and the server has not closed the batch — it will not until
    // its cleanup drops the upload that never arrived. The CLI corrects the
    // two things it genuinely knows (that upload, and the counts) and declines
    // to invent a verdict for the batch. A caller reads `uploads[]`, which is
    // complete here, and `status` tells them the server is not finished.
    assert.equal(document.status, "processing");
  });

  test("it keeps waiting for a file that did arrive, even after the other is written off", { timeout: TIMEOUT }, async () => {
    // The server settles a never-arrived upload as `failed` itself once its
    // cleanup runs — that is the normal end state, not an edge case. The stop
    // condition used to count that upload twice, once into `settled` and once
    // by shrinking the target, so the run ended while the file that genuinely
    // arrived was still being extracted and billed. The document said
    // `processing` and the exit code said 1, which is a run a script cannot
    // make sense of.
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");
    await writeFixture(dir, "b.pdf");

    const uploads = (bStatus, extra = {}) => [
      { uploadId: "up-a", fileName: "a.pdf", status: "failed", documentIds: [], errorCode: "upload_not_received" },
      { uploadId: "up-b", fileName: "b.pdf", status: bStatus, documentIds: [], ...extra },
    ];
    const stub = await startStub({
      documents: {
        batchId: "batch-1",
        uploads: [
          { uploadId: "up-a", fileName: "a.pdf" },
          { uploadId: "up-b", fileName: "b.pdf" },
        ],
      },
      putStatus: { "up-a": 403 },
      batches: [
        batch("processing", uploads("processing")),
        batch("completed_with_failures", uploads("completed", { documentIds: [DOC_A] })),
      ],
    });

    const result = await runCli(["--json", "upload", "a.pdf", "b.pdf"], { ...stub, cwd: dir });
    await stub.close();

    // It polled again instead of giving up on the first snapshot.
    assert.equal(stub.received.batchPolls, 2);
    const document = onlyDocument(result.stdout);
    assert.equal(document.status, "completed_with_failures");
    assert.deepEqual(document.uploads[1].documentIds, [DOC_A]);
    assert.equal(result.code, 1);
  });

  test("a file the server did complete keeps its ids, whatever the PUT thought", { timeout: TIMEOUT }, async () => {
    // The two can disagree: a PUT whose response was lost still landed, and the
    // server then extracts and bills a file the CLI has written off. Its
    // verdict wins, or the document throws away ids that exist and are paid
    // for. Two files, because a batch nothing reached is never opened at all.
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");
    await writeFixture(dir, "b.pdf");

    const stub = await startStub({
      documents: {
        batchId: "batch-1",
        uploads: [
          { uploadId: "up-a", fileName: "a.pdf" },
          { uploadId: "up-b", fileName: "b.pdf" },
        ],
      },
      putStatus: { "up-a": 403 },
      batches: [
        batch("completed", [
          { uploadId: "up-a", fileName: "a.pdf", status: "completed", documentIds: [DOC_A] },
          { uploadId: "up-b", fileName: "b.pdf", status: "completed", documentIds: [DOC_B] },
        ]),
      ],
    });

    const result = await runCli(["--json", "upload", "a.pdf", "b.pdf"], { ...stub, cwd: dir });
    await stub.close();

    const document = onlyDocument(result.stdout);
    assert.deepEqual(document.uploads[0].documentIds, [DOC_A]);
    assert.equal(document.uploads[0].status, "completed");
    assert.equal(document.uploads[0].errorCode, undefined);
    // And the counts stay the server's, because nothing moved.
    assert.equal(document.counts.completed, 2);
    assert.equal(document.counts.failed, 0);
    assert.equal(result.code, 0);
  });
});

describe("--json: bank statements", () => {
  test("a statement batch says so in kind, where the prose says it in a parenthesis", async () => {
    // `kind` is what tells a caller whether those ids belong to `export` or to
    // `export-statement`, and sending them to the wrong one answers
    // `not_found`. In prose that fact is a parenthesis on the last line; here
    // it has to be a field, or the whole point is lost.
    const dir = await tempDir();
    await writeFixture(dir, "vypis.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "vypis.pdf" }] },
      batches: [
        batch(
          "completed",
          [{ uploadId: "u1", fileName: "vypis.pdf", status: "completed", documentIds: ["s1"] }],
          { kind: "bank-statements" },
        ),
      ],
    });

    const result = await runCli(["--json", "upload-statement", "vypis.pdf"], {
      ...stub,
      cwd: dir,
    });
    await stub.close();

    assert.equal(result.code, 0);
    assert.equal(onlyDocument(result.stdout).kind, "bank-statements");
    assert.deepEqual(stub.received.preparedPaths, ["/api/v1/bank-statements"]);
  });

  test("export-statement reports the file it wrote, like export does", async () => {
    const stub = await startStub({
      exportFile: { filename: "vypisy_20260731.gpc", content: "074…" },
    });
    const dir = await tempDir();

    const result = await runCli(["--json", "export-statement", "s1", "--format", "gpc"], {
      ...stub,
      cwd: dir,
    });
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(onlyDocument(result.stdout), { file: "vypisy_20260731.gpc" });
    assert.equal(stub.received.exports[0].path, "/api/v1/bank-statements/export");
  });
});

describe("--json: export", () => {
  test("says where it wrote, and nothing the caller already knows", async () => {
    // The endpoint answers with the bytes of a file, not with JSON, so there is
    // no response to pass through: the path is the one fact the run produced,
    // and `format` and the ids would only hand back the arguments.
    const stub = await startStub({ exportFile: { filename: "export.xml", content: "<x/>" } });
    const dir = await tempDir();

    const result = await runCli(
      ["--json", "export", DOC_A, "--format", "pohoda", "--out", join(dir, "import.xml")],
      stub,
    );
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(onlyDocument(result.stdout), { file: join(dir, "import.xml") });
    assert.equal(await readFile(join(dir, "import.xml"), "utf8"), "<x/>");
  });
});

describe("--json: failures", () => {
  test("a refusal keeps the details the caller is told to split the batch by", async () => {
    // In text mode these are `key=value` lines on stderr. That was the best a
    // human-readable output could do; parsing them back into a structure is
    // exactly the work this mode exists to remove.
    const details = {
      documents: [
        { id: DOC_A, accountingUnitId: "6a5b41d8e7c204f93a1b8e62", ico: "12345679" },
        { id: DOC_B, accountingUnitId: null, ico: "87654321" },
      ],
    };
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents/export",
        status: 422,
        body: {
          error: {
            code: "mixed_accounting_units",
            message: "Doklady patří k různým účetním jednotkám.",
            details,
          },
        },
      },
    });

    const result = await runCli(
      ["--json", "export", DOC_A, DOC_B, "--format", "pohoda"],
      stub,
    );
    await stub.close();

    assert.equal(result.code, 1);
    assert.deepEqual(onlyDocument(result.stdout), {
      error: {
        code: "mixed_accounting_units",
        message: "Doklady patří k různým účetním jednotkám.",
        details,
      },
    });
  });

  test("a refusal too big for one pipe buffer arrives whole", { timeout: TIMEOUT }, async () => {
    // Writing to a pipe is asynchronous and `process.exit` does not wait for
    // it, so a document past 64 KiB used to be cut off mid-string: not a
    // shorter answer but invalid JSON delivered with exit 1. This is the path
    // that carries the biggest ones — `mixed_accounting_units` lists every
    // document in the export. At ~110 B per entry, 600 would land just under
    // one buffer and pass by accident.
    const documents = Array.from({ length: 900 }, (_, i) => ({
      id: `${i}`.padStart(8, "0") + "-52af-4dc2-981f-dfba661a71ae",
      accountingUnitId: "6a5b41d8e7c204f93a1b8e62",
      ico: "12345679",
    }));
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents/export",
        status: 422,
        body: {
          error: {
            code: "mixed_accounting_units",
            message: "Doklady patří k různým účetním jednotkám.",
            details: { documents },
          },
        },
      },
    });

    const result = await runCli(["--json", "export", DOC_A, "--format", "pohoda"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.ok(result.stdout.length > 65_536, `dokument má jen ${result.stdout.length} B`);
    // Parsing is the assertion: a truncated document throws right here.
    assert.equal(onlyDocument(result.stdout).error.details.documents.length, 900);
  });

  test("a failure with no details does not grow a null one", async () => {
    // `"details": null` claims the server sent an empty set. It sent nothing,
    // and the two are different answers to "is there anything to split by".
    const stub = await startStub({
      apiError: {
        path: "/api/v1/accounting-units",
        status: 403,
        body: { error: { code: "insufficient_scope", message: "Klíč nemá oprávnění." } },
      },
    });

    const result = await runCli(["--json", "units"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    const document = onlyDocument(result.stdout);
    assert.deepEqual(document, {
      error: { code: "insufficient_scope", message: "Klíč nemá oprávnění." },
    });
    assert.equal("details" in document.error, false);
  });

  test("an exhausted rate limit is a document, and the way back is on stderr", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "faktura.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [batch("completed", [])],
      throttle: { batches: Infinity },
    });

    const result = await runCli(["--json", "upload", "faktura.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 1);
    assert.equal(onlyDocument(result.stdout).error.code, "rate_limited");
    // The advice stays a sentence on stderr rather than a field: the error
    // envelope has to keep being the one the API sent, and the batch id is
    // already on stderr from the line above it.
    assert.match(result.stderr, /ctenifaktur status batch-1/);
  });

  test("a mistake made here, not on the server, carries a cli_ code", async () => {
    // Separate namespace on purpose. The API's codes are a published contract;
    // slipping our own in among them would have callers branch on a code the
    // server can never send.
    const stub = await startStub();

    const missingId = await runCli(["--json", "status"], stub);
    const missingFile = await runCli(["--json", "upload", "chybi.pdf"], stub);
    const unknownFlag = await runCli(["--json", "upload", "faktura.pdf", "--nope"], stub);
    const noKey = await runCli(["--json", "units"], { ...stub, env: { CF_API_KEY: "" } });
    await stub.close();

    assert.deepEqual(onlyDocument(missingId.stdout), {
      error: { code: "cli_usage", message: "zadejte id dávky" },
    });
    assert.equal(onlyDocument(missingFile.stdout).error.code, "cli_file_not_found");
    assert.equal(onlyDocument(unknownFlag.stdout).error.code, "cli_usage");
    assert.equal(onlyDocument(noKey.stdout).error.code, "cli_not_logged_in");
    for (const result of [missingId, missingFile, unknownFlag, noKey]) {
      assert.equal(result.code, 1);
      // The Czech line belongs to the human mode. Printing both would put the
      // error on stderr as well, where a caller might parse the wrong one.
      assert.doesNotMatch(result.stderr, /^Chyba:/m);
    }
  });
});

describe("--json: the flag itself", () => {
  test("is never swallowed as another flag's value", { timeout: TIMEOUT }, async () => {
    // The switch is stripped from the whole argument list before the per
    // command flags are read, which put it inside `takeFlag`'s blind spot:
    // `--idempotency-key --json a.pdf b.pdf` took `a.pdf` as the key — a
    // perfectly valid one, so nothing rejected it — uploaded only `b.pdf`,
    // and exited 0 with a document saying the batch completed. One file
    // silently missing from a command that charges per document.
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");
    await writeFixture(dir, "b.pdf");

    for (const flag of ["--idempotency-key", "--unit"]) {
      const stub = await startStub({
        documents: { batchId: "batch-1", uploads: [{ uploadId: "up-b", fileName: "b.pdf" }] },
        batches: [batch("completed", [])],
      });

      const result = await runCli(["upload", flag, "--json", "a.pdf", "b.pdf"], {
        ...stub,
        cwd: dir,
      });
      await stub.close();

      assert.equal(result.code, 1, `${flag}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`chybí hodnota pro ${flag}`));
      // Nothing was uploaded and nothing was charged.
      assert.equal(stub.received.prepared.length, 0);
    }
  });

  test("is taken before the command and after the arguments alike", async () => {
    // `takeFlag` runs per command on what is left of the arguments, so a
    // global switch has to come off the whole list first — otherwise
    // `ctenifaktur --json status <id>` looks for a command called `--json`.
    const snapshot = batch("completed", [upload("a.pdf", "completed", { documentIds: [DOC_A] })]);

    const first = await startStub({ batches: [snapshot] });
    const before = await runCli(["--json", "status", "batch-1"], first);
    await first.close();

    const second = await startStub({ batches: [snapshot] });
    const after = await runCli(["status", "batch-1", "--json"], second);
    await second.close();

    assert.deepEqual(onlyDocument(before.stdout), snapshot);
    assert.deepEqual(onlyDocument(after.stdout), snapshot);
  });

  test("covers login and logout too, so a wrapper can set it blindly", async () => {
    // Neither has an API response to pass through, but a script that turns the
    // flag on for every call must not get a Czech sentence back from two of
    // them.
    const stub = await startStub({ accountingUnits: [{ id: "u1" }] });
    const dir = await tempDir();
    const config = join(dir, "config");

    const login = await runCli(["--json", "login"], {
      ...stub,
      stdin: "cf_live_test\n",
      env: { XDG_CONFIG_HOME: config },
    });
    const logout = await runCli(["--json", "logout"], {
      ...stub,
      env: { XDG_CONFIG_HOME: config },
    });
    await stub.close();

    assert.equal(login.code, 0);
    // `accountingUnitCount`, not `accountingUnits`: the API uses that name for
    // an array of units, and one key cannot mean both.
    assert.deepEqual(onlyDocument(login.stdout), {
      apiUrl: stub.base,
      loggedIn: true,
      accountingUnitCount: 1,
    });
    assert.equal(logout.code, 0);
    assert.deepEqual(onlyDocument(logout.stdout), { apiUrl: stub.base, loggedIn: false });
    // The path to the key file is in the sentence for a human, not in output
    // that ends up in a CI log.
    assert.doesNotMatch(login.stdout, /credentials\.json/);
  });

  test("keeps the help as prose, but off stdout", async () => {
    // A wrapper that appends `--json` to whatever it was given runs
    // `ctenifaktur --json` with no command sooner or later, and the whole Czech
    // help text on stdout would break the one promise the flag makes.
    const stub = await startStub();

    const help = await runCli(["--json", "--help"], stub);
    const bare = await runCli(["--json"], stub);
    const human = await runCli(["--help"], stub);
    await stub.close();

    for (const result of [help, bare]) {
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /^Čtení Faktur CLI/);
    }
    // Without the flag it is on stdout exactly as it always was.
    assert.equal(human.code, 0);
    assert.match(human.stdout, /^Čtení Faktur CLI/);
    assert.equal(human.stderr, "");
  });
});

describe("without --json", () => {
  test("a batch listing is what it was, to the byte", async () => {
    // The flag is additive or it is a breaking change. Everything downstream of
    // this CLI — `status | xargs export`, the agent skill, people's scripts —
    // reads the text mode, and none of it was asked to change. The sibling
    // suites pin the other commands' prose; this pins the one the flag
    // rewrote most.
    const stub = await startStub({
      batches: [
        batch("completed_with_failures", [
          upload("ok.pdf", "completed", { documentIds: [DOC_A] }),
          upload("rozbite.pdf", "failed", { errorCode: "parse_failed" }),
          upload("scan.pdf", "completed", {
            documentIds: [DOC_B],
            incomplete: { discarded: 3, unparsed: 0 },
          }),
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.equal(
      result.stdout,
      `ok.pdf: ${DOC_A}\nscan.pdf: ${DOC_B}\nStav dávky: completed_with_failures\n`,
    );
    assert.equal(
      result.stderr,
      "rozbite.pdf: selhalo (parse_failed)\nscan.pdf: neúplné (nezpracováno: 3)\n",
    );
  });

  test("both logout sentences survived being merged into one path", async () => {
    // The two branches were folded into one exit with a ternary, and no test
    // covered either sentence before — `logout` writes no id anyone pipes, so
    // it had never earned one. It has now: the wording is the only thing a
    // person gets back from the command.
    const stub = await startStub({ accountingUnits: [{ id: "u1" }] });
    const dir = await tempDir();
    const config = join(dir, "config");

    const never = await runCli(["logout"], { ...stub, env: { XDG_CONFIG_HOME: config } });
    await runCli(["login"], { ...stub, stdin: "cf_live_test\n", env: { XDG_CONFIG_HOME: config } });
    const after = await runCli(["logout"], { ...stub, env: { XDG_CONFIG_HOME: config } });
    await stub.close();

    assert.equal(never.code, 0);
    assert.equal(never.stdout, `K ${stub.base} nejste přihlášeni.\n`);
    assert.equal(after.code, 0);
    assert.equal(after.stdout, `Odhlášeno od ${stub.base}. Klíč zneplatníte v aplikaci.\n`);
    for (const result of [never, after]) assert.equal(result.stderr, "");
  });

  test("a long refusal reaches the end of stderr too", { timeout: TIMEOUT }, async () => {
    // Same asynchronous-pipe hazard as the document, on the other stream: the
    // detail lines are what the caller is told to split the batch by, and past
    // one pipe buffer `process.exit` was dropping the tail of them — 253 of
    // 900 documents, cut mid-token.
    const documents = Array.from({ length: 900 }, (_, i) => ({
      id: `${i}`.padStart(8, "0") + "-52af-4dc2-981f-dfba661a71ae",
      accountingUnitId: "6a5b41d8e7c204f93a1b8e62",
      ico: "12345679",
    }));
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents/export",
        status: 422,
        body: {
          error: {
            code: "mixed_accounting_units",
            message: "Doklady patří k různým účetním jednotkám.",
            details: { documents },
          },
        },
      },
    });

    const result = await runCli(["export", DOC_A, "--format", "pohoda"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.ok(result.stderr.length > 65_536, `stderr má jen ${result.stderr.length} B`);
    // The last line has to be whole, not cut off somewhere inside an id.
    assert.match(
      result.stderr,
      /- id=00000899-52af-4dc2-981f-dfba661a71ae accountingUnitId=6a5b41d8e7c204f93a1b8e62 ico=12345679\n$/,
    );
  });

  test("an error still reads exactly as before, with no code bolted on", async () => {
    // The `cli_` codes exist for the document. Letting one leak into the Czech
    // line would change `Chyba: zadejte id dávky` for everybody.
    const stub = await startStub();

    const result = await runCli(["status"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.equal(result.stderr, "Chyba: zadejte id dávky\n");
    assert.equal(result.stdout, "");
  });

  test("a refusal from the server keeps its line and its detail lines", async () => {
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents/export",
        status: 422,
        body: {
          error: {
            code: "mixed_accounting_units",
            message: "Doklady patří k různým účetním jednotkám.",
            details: { documents: [{ id: DOC_A, ico: "12345679" }] },
          },
        },
      },
    });

    const result = await runCli(["export", DOC_A, "--format", "pohoda"], stub);
    await stub.close();

    assert.equal(
      result.stderr,
      "Chyba: mixed_accounting_units: Doklady patří k různým účetním jednotkám.\n" +
        "  documents:\n" +
        `    - id=${DOC_A} ico=12345679\n`,
    );
  });
});

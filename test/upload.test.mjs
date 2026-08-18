/**
 * `ctenifaktur upload` — what happens when a file never reaches storage.
 *
 * Every test here has a timeout on purpose. The bug this guards against does
 * not produce a wrong line, it produces a thirty minute wait: an upload whose
 * PUT failed sits at `pending` until the server-side cleanup drops it, and the
 * CLI has to stop waiting for it on its own.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub, tempDir, writeFixture } from "./helpers.mjs";

const DOC_A = "e48428a7-52af-4dc2-981f-dfba661a71ae";
const TIMEOUT = 30_000;

describe("upload", () => {
  test("an unknown flag stops the run instead of billing the file behind it", async () => {
    // `--out` patří k exportu, ne k nahrávání. Dřív se přepínač odfiltroval a
    // `export.xml` za ním se nahrálo a zaplatilo jako doklad.
    const dir = await tempDir();
    const file = await writeFixture(dir, "faktura.pdf");
    const stray = await writeFixture(dir, "export.xml");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [{ id: "batch-1", status: "completed", counts: {}, uploads: [] }],
    });

    const result = await runCli(["upload", file, "--out", stray], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /neznámý přepínač: --out/);
    assert.equal(stub.received.prepared.length, 0);
  });

  test("a failed file does not drag down a namesake in another directory", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "doklady/leden/faktura.pdf");
    await writeFixture(dir, "doklady/unor/faktura.pdf");

    const stub = await startStub({
      documents: {
        batchId: "batch-1",
        uploads: [
          { uploadId: "up-leden", fileName: "faktura.pdf" },
          { uploadId: "up-unor", fileName: "faktura.pdf" },
        ],
      },
      // 403 is a refusal, not an outage, so it fails on the first attempt and
      // the test does not sit through the retry backoff.
      putStatus: { "up-leden": 403 },
      batches: [
        {
          id: "batch-1",
          status: "processing",
          counts: {},
          uploads: [
            { uploadId: "up-leden", fileName: "faktura.pdf", status: "pending", documentIds: [] },
            { uploadId: "up-unor", fileName: "faktura.pdf", status: "completed", documentIds: [DOC_A] },
          ],
        },
      ],
    });

    const result = await runCli(
      ["upload", "doklady/leden/faktura.pdf", "doklady/unor/faktura.pdf"],
      { ...stub, cwd: dir },
    );
    await stub.close();

    // The two files share a basename, so anything keyed on the file name marks
    // both. The one that did arrive has to keep its id line.
    assert.match(result.stdout, new RegExp(`faktura\\.pdf: ${DOC_A}`));
    assert.equal(result.stderr.match(/selhalo \(upload_not_received\)/g).length, 1);
    assert.equal(result.code, 1);
  });

  test("two failed namesakes count as two, not one", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "doklady/leden/faktura.pdf");
    await writeFixture(dir, "doklady/unor/faktura.pdf");

    const stub = await startStub({
      documents: {
        batchId: "batch-1",
        uploads: [
          { uploadId: "up-leden", fileName: "faktura.pdf" },
          { uploadId: "up-unor", fileName: "faktura.pdf" },
        ],
      },
      putStatus: { "up-leden": 403, "up-unor": 403 },
      batches: [
        {
          id: "batch-1",
          status: "processing",
          counts: {},
          uploads: [
            { uploadId: "up-leden", fileName: "faktura.pdf", status: "pending", documentIds: [] },
            { uploadId: "up-unor", fileName: "faktura.pdf", status: "pending", documentIds: [] },
          ],
        },
      ],
    });

    const result = await runCli(
      ["upload", "doklady/leden/faktura.pdf", "doklady/unor/faktura.pdf"],
      { ...stub, cwd: dir },
    );
    await stub.close();

    assert.equal(result.timedOut, false, "CLI did not finish, it kept polling");
    // A set of file names would hold a single "faktura.pdf" for two failures,
    // so the CLI would think one file made it, announce "1 soubor" and then
    // wait out the full thirty minutes for a batch nothing ever reached.
    assert.match(result.stderr, /nenahrál se ani jeden soubor/);
    assert.doesNotMatch(result.stdout, /zpracovávám/);
    assert.equal(stub.received.batchPolls, 0);
    assert.equal(result.code, 1);
  });

  test("it stops waiting once everything that arrived has settled", { timeout: TIMEOUT }, async () => {
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
      // The batch never reaches a terminal status, exactly like the real one
      // would until the cleanup runs. Finishing at all is the assertion.
      batches: [
        {
          id: "batch-1",
          status: "processing",
          counts: {},
          uploads: [
            { uploadId: "up-a", fileName: "a.pdf", status: "pending", documentIds: [] },
            { uploadId: "up-b", fileName: "b.pdf", status: "completed", documentIds: [DOC_A] },
          ],
        },
      ],
    });

    const result = await runCli(["upload", "a.pdf", "b.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.timedOut, false, "CLI did not finish, it kept polling");
    assert.equal(result.code, 1);
    assert.equal(stub.received.batchPolls, 1);
  });

  test("when nothing reaches storage it never opens the batch", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "up-a", fileName: "a.pdf" }] },
      putStatus: { "up-a": 403 },
    });

    const result = await runCli(["upload", "a.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /nenahrál se ani jeden soubor/);
    assert.equal(stub.received.batchPolls, 0);
  });

  test("--idempotency-key is passed through, otherwise one is generated", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");

    const documents = { batchId: "batch-1", uploads: [{ uploadId: "up-a", fileName: "a.pdf" }] };
    const batches = [
      {
        id: "batch-1",
        status: "completed",
        counts: {},
        uploads: [{ uploadId: "up-a", fileName: "a.pdf", status: "completed", documentIds: [DOC_A] }],
      },
    ];

    const withKey = await startStub({ documents, batches });
    await runCli(["upload", "a.pdf", "--idempotency-key", "muj-klic-42"], { ...withKey, cwd: dir });
    await withKey.close();
    assert.deepEqual(withKey.received.idempotencyKeys, ["muj-klic-42"]);

    const without = await startStub({ documents, batches });
    await runCli(["upload", "a.pdf"], { ...without, cwd: dir });
    await without.close();
    assert.match(without.received.idempotencyKeys[0], /^[0-9a-f-]{36}$/);
  });

  test("a flag value is not mistaken for a file name", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "a.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "up-a", fileName: "a.pdf" }] },
      batches: [
        {
          id: "batch-1",
          status: "completed",
          counts: {},
          uploads: [{ uploadId: "up-a", fileName: "a.pdf", status: "completed", documentIds: [DOC_A] }],
        },
      ],
    });

    const result = await runCli(
      ["upload", "a.pdf", "--unit", "6a5b41d8e7c204f93a1b8e62"],
      { ...stub, cwd: dir },
    );
    await stub.close();

    assert.equal(result.code, 0);
    assert.deepEqual(stub.received.prepared[0].files.map((f) => f.fileName), ["a.pdf"]);
    assert.equal(stub.received.prepared[0].accountingUnitId, "6a5b41d8e7c204f93a1b8e62");
  });

  test("a directory is refused before any credit is spent", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    await writeFixture(dir, "doklady/a.pdf");

    const stub = await startStub();
    const result = await runCli(["upload", "doklady"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /není to soubor: doklady/);
    assert.equal(stub.received.prepared.length, 0);
  });

  test("a missing file is refused before any credit is spent", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();

    const stub = await startStub();
    const result = await runCli(["upload", "chybi.pdf"], { ...stub, cwd: dir });
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /soubor neexistuje: chybi\.pdf/);
    assert.equal(stub.received.prepared.length, 0);
  });

  test("the progress line uses the Czech plural for the file count", { timeout: TIMEOUT }, async () => {
    for (const [count, label] of [[1, "1 soubor"], [2, "2 soubory"], [5, "5 souborů"]]) {
      const dir = await tempDir();
      const names = Array.from({ length: count }, (_, i) => `f${i}.pdf`);
      for (const name of names) await writeFixture(dir, name);

      const uploads = names.map((fileName, i) => ({ uploadId: `up-${i}`, fileName }));
      const stub = await startStub({
        documents: { batchId: "batch-1", uploads },
        batches: [
          {
            id: "batch-1",
            status: "completed",
            counts: {},
            uploads: uploads.map((u) => ({ ...u, status: "completed", documentIds: [DOC_A] })),
          },
        ],
      });

      const result = await runCli(["upload", ...names], { ...stub, cwd: dir });
      await stub.close();

      assert.equal(result.code, 0, `${count}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`zpracovávám ${label}…`));
    }
  });
});

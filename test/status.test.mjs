/**
 * `ctenifaktur status` — how a batch is reported and what it exits with.
 *
 * Two shipped regressions lived here, so both have a test: a batch still being
 * processed used to be reported as failed (which told the user to upload and
 * pay for it a second time), and the warning lines used to go to stdout, which
 * broke `ctenifaktur status <id> | xargs ctenifaktur export`.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub } from "./helpers.mjs";

const DOC_A = "e48428a7-52af-4dc2-981f-dfba661a71ae";
const DOC_B = "af668802-4304-4623-9ec4-fd89293e69e0";

function batch(status, uploads) {
  return { id: "batch-1", status, counts: {}, uploads };
}

function upload(fileName, status, extra = {}) {
  return { uploadId: `up-${fileName}`, fileName, status, documentIds: [], ...extra };
}

describe("status", () => {
  test("completed batch prints one id line per file and exits 0", async () => {
    const stub = await startStub({
      batches: [
        batch("completed", [
          upload("faktura-01.pdf", "completed", { documentIds: [DOC_A] }),
          upload("faktura-02.pdf", "completed", { documentIds: [DOC_B] }),
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.equal(result.stdout, `faktura-01.pdf: ${DOC_A}\nfaktura-02.pdf: ${DOC_B}\nStav dávky: completed\n`);
    assert.equal(result.stderr, "");
  });

  test("a file still being processed is not reported as failed", async () => {
    const stub = await startStub({
      batches: [batch("processing", [upload("faktura.pdf", "processing")])],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    // Exit 0: an unfinished batch is not a failure, only a finished one with
    // failures in it is. Anything else makes a retry loop give up too early.
    assert.equal(result.code, 0);
    assert.match(result.stderr, /faktura\.pdf: zpracovává se/);
    assert.doesNotMatch(result.stderr, /selhalo/);
  });

  test("only id lines reach stdout, so it stays pipeable", async () => {
    const stub = await startStub({
      batches: [
        batch("completed_with_failures", [
          upload("ok.pdf", "completed", { documentIds: [DOC_A] }),
          upload("rozbite.pdf", "failed", { errorCode: "parse_failed" }),
          upload("ceka.pdf", "pending"),
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    const ids = result.stdout.split("\n").filter((line) => line && !line.startsWith("Stav dávky"));
    assert.deepEqual(ids, [`ok.pdf: ${DOC_A}`]);
    assert.match(result.stderr, /rozbite\.pdf: selhalo \(parse_failed\)/);
    assert.match(result.stderr, /ceka\.pdf: zpracovává se/);
  });

  test("a finished batch with failures exits 1", async () => {
    const stub = await startStub({
      batches: [
        batch("completed_with_failures", [
          upload("ok.pdf", "completed", { documentIds: [DOC_A] }),
          upload("rozbite.pdf", "failed", { errorCode: "parse_failed" }),
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 1);
  });

  test("a failure without an error code falls back to the upload status", async () => {
    const stub = await startStub({
      batches: [batch("failed", [upload("rozbite.pdf", "rejected")])],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /rozbite\.pdf: selhalo \(rejected\)/);
  });

  test("a partially parsed file is flagged as incomplete", async () => {
    const stub = await startStub({
      batches: [
        batch("completed", [
          upload("scan.pdf", "completed", {
            documentIds: [DOC_A],
            incomplete: { discarded: 1, unparsed: 2 },
          }),
          upload("scan2.pdf", "completed", {
            documentIds: [DOC_B],
            incomplete: { discarded: 3, unparsed: 0 },
          }),
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], stub);
    await stub.close();

    assert.match(result.stderr, /scan\.pdf: neúplné \(nezpracováno: 1, bez vytěžených dat: 2\)/);
    // A zero half is left out rather than printed as "bez vytěžených dat: 0".
    assert.match(result.stderr, /scan2\.pdf: neúplné \(nezpracováno: 3\)\n/);
  });

  test("a missing batch id fails before any request", async () => {
    const stub = await startStub();

    const result = await runCli(["status"], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Chyba: zadejte id dávky/);
    assert.equal(stub.received.batchPolls, 0);
  });
});

/**
 * How the CLI answers the two things the server says about a failure: the rate
 * limit, and the `details` it attaches to a refusal.
 *
 * Both were found by a cold run against the real API. Neither produces a wrong
 * line — they produce a run that stops on a batch which is already paid for and
 * still running, and advice from the documentation that cannot be followed
 * because the CLI never printed what to follow it with.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub, tempDir, writeFixture } from "./helpers.mjs";

const DOC_A = "e48428a7-52af-4dc2-981f-dfba661a71ae";
const TIMEOUT = 30_000;

const COMPLETED = {
  id: "batch-1",
  status: "completed",
  counts: {},
  uploads: [
    { uploadId: "u1", fileName: "faktura.pdf", status: "completed", documentIds: [DOC_A] },
  ],
};

describe("rate limit", () => {
  test("is waited out instead of dropping a paid batch", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    const file = await writeFixture(dir, "faktura.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [COMPLETED],
      throttle: { batches: 2 },
    });

    const result = await runCli(["upload", file], stub);
    await stub.close();

    assert.equal(stub.received.throttled, 2);
    assert.match(result.stderr, /Limit požadavků vyčerpán/);
    // Ne jen „nespadlo": dávka musí doběhnout a id dokladu vyjít na stdout,
    // odkud si ho bere export.
    assert.equal(result.code, 0);
    assert.match(result.stdout, new RegExp(DOC_A));
  });

  test("says the batch keeps running when it never lets up", { timeout: TIMEOUT }, async () => {
    const dir = await tempDir();
    const file = await writeFixture(dir, "faktura.pdf");

    const stub = await startStub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [COMPLETED],
      throttle: { batches: Infinity },
    });

    const result = await runCli(["upload", file], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /rate_limited/);
    // Bez tohohle řádku vypadá vyčerpaný limit jako ztracená dávka a uživatel
    // ji nahraje a zaplatí podruhé.
    assert.match(result.stderr, /ctenifaktur status batch-1/);
  });
});

describe("error details", () => {
  test("are printed, so the advice to split the batch can be followed", async () => {
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents/export",
        status: 422,
        body: {
          error: {
            code: "mixed_accounting_units",
            message: "Doklady patří k různým účetním jednotkám.",
            details: {
              documents: [
                { id: DOC_A, accountingUnitId: "6a5b41d8e7c204f93a1b8e62", ico: "12345679" },
                { id: "af668802-4304-4623-9ec4-fd89293e69e0", accountingUnitId: null, ico: "87654321" },
              ],
            },
          },
        },
      },
    });

    const result = await runCli(
      ["export", DOC_A, "af668802-4304-4623-9ec4-fd89293e69e0", "--format", "pohoda"],
      stub,
    );
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /mixed_accounting_units/);
    // Obě jednotky, jinak není podle čeho dávku rozdělit.
    assert.match(result.stderr, /accountingUnitId=6a5b41d8e7c204f93a1b8e62/);
    assert.match(result.stderr, /ico=87654321/);
  });

  test("survive a validation error, where they are a bare array", async () => {
    const stub = await startStub({
      apiError: {
        path: "/api/v1/documents",
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            message: "Požadavek neodpovídá očekávanému tvaru.",
            details: [{ path: "files.0.sizeBytes", message: "Očekávalo se číslo." }],
          },
        },
      },
    });

    const dir = await tempDir();
    const file = await writeFixture(dir, "faktura.pdf");
    const result = await runCli(["upload", file], stub);
    await stub.close();

    assert.equal(result.code, 1);
    assert.match(result.stderr, /path=files\.0\.sizeBytes/);
  });
});

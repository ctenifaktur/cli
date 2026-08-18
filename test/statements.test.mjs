/**
 * Bank statements: `upload-statement` and `export-statement`.
 *
 * The point of both being their own commands rather than a `--statement` flag
 * is that the declaration cannot be forgotten, so what is worth asserting is
 * exactly that: which endpoint each command talks to, and which field name it
 * puts the ids in. Everything else — polling, partial failures, exit codes — is
 * the shared machinery already covered by the upload and status suites.
 */

import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { runCli, startStub, tempDir, writeFixture } from "./helpers.mjs";

const stubs = [];
async function stub(options) {
  const created = await startStub(options);
  stubs.push(created);
  return created;
}
after(async () => {
  for (const created of stubs) await created.close();
});

const doneBatch = (kind, uploads) => ({
  id: "batch-1",
  kind,
  status: "completed",
  counts: { total: uploads.length, completed: uploads.length },
  uploads,
});

describe("upload-statement", () => {
  it("declares the kind by calling the statement endpoint", async () => {
    const server = await stub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "vypis.pdf" }] },
      batches: [
        doneBatch("bank-statements", [
          { uploadId: "u1", fileName: "vypis.pdf", status: "completed", documentIds: ["s1"] },
        ]),
      ],
    });
    const dir = await tempDir();
    const file = await writeFixture(dir, "vypis.pdf");

    const result = await runCli(["upload-statement", file], { base: server.base });

    assert.equal(result.code, 0);
    assert.deepEqual(server.received.preparedPaths, ["/api/v1/bank-statements"]);
    assert.match(result.stdout, /vypis\.pdf: s1/);
  });

  it("keeps plain upload on the documents endpoint", async () => {
    const server = await stub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "faktura.pdf" }] },
      batches: [
        doneBatch("documents", [
          { uploadId: "u1", fileName: "faktura.pdf", status: "completed", documentIds: ["d1"] },
        ]),
      ],
    });
    const dir = await tempDir();
    const file = await writeFixture(dir, "faktura.pdf");

    await runCli(["upload", file], { base: server.base });

    assert.deepEqual(server.received.preparedPaths, ["/api/v1/documents"]);
  });

  it("announces a gateway CSV as text/csv, not as a PDF", async () => {
    const server = await stub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "report.csv" }] },
      batches: [
        doneBatch("bank-statements", [
          { uploadId: "u1", fileName: "report.csv", status: "completed", documentIds: ["s1"] },
        ]),
      ],
    });
    const dir = await tempDir();
    const file = await writeFixture(dir, "report.csv", "datum;castka\n");

    await runCli(["upload-statement", file], { base: server.base });

    assert.equal(server.received.prepared[0].files[0].contentType, "text/csv");
  });

  it("takes --unit and --idempotency-key like upload does", async () => {
    const server = await stub({
      documents: { batchId: "batch-1", uploads: [{ uploadId: "u1", fileName: "vypis.pdf" }] },
      batches: [
        doneBatch("bank-statements", [
          { uploadId: "u1", fileName: "vypis.pdf", status: "completed", documentIds: ["s1"] },
        ]),
      ],
    });
    const dir = await tempDir();
    const file = await writeFixture(dir, "vypis.pdf");

    await runCli(
      ["upload-statement", file, "--unit", "unit-1", "--idempotency-key", "my-key"],
      { base: server.base },
    );

    assert.equal(server.received.prepared[0].accountingUnitId, "unit-1");
    assert.deepEqual(server.received.idempotencyKeys, ["my-key"]);
  });

  it("refuses to spend a credit on a missing file", async () => {
    const server = await stub({
      documents: { batchId: "batch-1", uploads: [] },
      batches: [doneBatch("bank-statements", [])],
    });

    const result = await runCli(["upload-statement", "/nope/vypis.pdf"], { base: server.base });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /soubor neexistuje/);
    assert.equal(server.received.prepared.length, 0);
  });
});

describe("status", () => {
  it("says when a batch holds statements, so the ids go to the right export", async () => {
    const server = await stub({
      batches: [
        doneBatch("bank-statements", [
          { uploadId: "u1", fileName: "vypis.pdf", status: "completed", documentIds: ["s1"] },
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], { base: server.base });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Stav dávky: completed \(bankovní výpisy\)/);
  });

  it("stays quiet about the kind for an ordinary document batch", async () => {
    const server = await stub({
      batches: [
        doneBatch("documents", [
          { uploadId: "u1", fileName: "faktura.pdf", status: "completed", documentIds: ["d1"] },
        ]),
      ],
    });

    const result = await runCli(["status", "batch-1"], { base: server.base });

    assert.match(result.stdout, /Stav dávky: completed$/m);
  });
});

describe("export-statement", () => {
  it("posts statementIds to the statement export endpoint", async () => {
    const server = await stub({
      exportFile: { filename: "vypisy_20260731.gpc", content: "074…" },
    });
    const dir = await tempDir();

    const result = await runCli(
      ["export-statement", "s1", "s2", "--format", "gpc", "--out", join(dir, "out.gpc")],
      { base: server.base },
    );

    assert.equal(result.code, 0);
    assert.equal(server.received.exports[0].path, "/api/v1/bank-statements/export");
    assert.deepEqual(server.received.exports[0].body, {
      statementIds: ["s1", "s2"],
      format: "gpc",
    });
    assert.equal(await readFile(join(dir, "out.gpc"), "utf8"), "074…");
  });

  it("keeps plain export on documentIds", async () => {
    const server = await stub({ exportFile: { filename: "export.xml", content: "<x/>" } });
    const dir = await tempDir();

    await runCli(["export", "d1", "--format", "pohoda", "--out", join(dir, "out.xml")], {
      base: server.base,
    });

    assert.equal(server.received.exports[0].path, "/api/v1/documents/export");
    assert.deepEqual(server.received.exports[0].body, {
      documentIds: ["d1"],
      format: "pohoda",
    });
  });

  it("names the file from Content-Disposition when --out is absent", async () => {
    const server = await stub({
      exportFile: { filename: "vypisy_20260731.gpc", content: "074…" },
    });
    const dir = await tempDir();

    const result = await runCli(["export-statement", "s1", "--format", "gpc"], {
      base: server.base,
      cwd: dir,
    });

    assert.equal(result.stdout.trim(), "vypisy_20260731.gpc");
    assert.equal(await readFile(join(dir, "vypisy_20260731.gpc"), "utf8"), "074…");
  });

  it("asks for an id before it asks the server anything", async () => {
    const server = await stub({ exportFile: { filename: "x.gpc", content: "" } });

    const result = await runCli(["export-statement", "--format", "gpc"], { base: server.base });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /zadejte alespoň jedno id výpisu/);
    assert.equal(server.received.exports.length, 0);
  });

  it("still requires --format", async () => {
    const server = await stub({ exportFile: { filename: "x.gpc", content: "" } });

    const result = await runCli(["export-statement", "s1"], { base: server.base });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /chybí --format/);
  });
});

/**
 * `ctenifaktur documents` — persistent metadata listing and filter forwarding.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub } from "./helpers.mjs";

const DOCUMENTS = {
  documents: [
    {
      id: "doc-archived",
      fileName: "starsi-faktura.pdf",
      status: "completed",
      archived: true,
      accountingUnitId: "6a5b41d8e7c204f93a1b8e62",
      createdAt: "2026-08-20T12:00:00.000Z",
    },
    {
      id: "doc-failed",
      fileName: "necitelny-sken.jpg",
      status: "failed",
      archived: true,
      accountingUnitId: null,
      createdAt: "2026-08-19T12:00:00.000Z",
    },
  ],
  total: 55,
  page: 2,
  limit: 2,
};

describe("documents", () => {
  test("lists stored documents without a batch id and forwards filters", async () => {
    const stub = await startStub({ documentList: DOCUMENTS });

    const result = await runCli(
      [
        "documents",
        "--unit",
        "6a5b41d8e7c204f93a1b8e62",
        "--page",
        "2",
        "--limit",
        "2",
      ],
      stub,
    );
    await stub.close();

    assert.equal(result.code, 0);
    assert.match(result.stdout, /doc-archived.*hotovo.*archiv.*starsi-faktura\.pdf/);
    assert.match(result.stdout, /doc-failed.*selhalo.*archiv.*necitelny-sken\.jpg.*nezařazeno/);
    assert.match(result.stdout, /Strana 2 z 28, celkem 55\./);
    assert.deepEqual(stub.received.documentListQueries, [
      "accountingUnitId=6a5b41d8e7c204f93a1b8e62&page=2&limit=2",
    ]);
  });

  test("passes the public API response through unchanged under --json", async () => {
    const stub = await startStub({ documentList: DOCUMENTS });

    const result = await runCli(["--json", "documents", "--page", "2"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), DOCUMENTS);
  });
});

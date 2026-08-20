/**
 * `ctenifaktur credits` — the balance a batch is measured against.
 *
 * Until the API grew this endpoint there was no way to learn the balance
 * except by spending it, so an integration could neither check a batch before
 * paying for it nor reconcile what a run consumed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { runCli, startStub } from "./helpers.mjs";

describe("credits", () => {
  test("splits the balance into the half that resets and the half that does not", async () => {
    const stub = await startStub({
      credits: {
        remaining: 72,
        planRemaining: 60,
        credits: 12,
        plan: "business",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
    });

    const result = await runCli(["credits"], stub);
    await stub.close();

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Zbývá 72 dokladů/);
    // Obojí zvlášť: tarifní kvóta se k datu obnoví, kredity ne, takže velkou
    // dávku plánuje uživatel podle jiného čísla na začátku období než na konci.
    assert.match(result.stdout, /tarif business: 60/);
    assert.match(result.stdout, /kredity: 12/);
  });
});

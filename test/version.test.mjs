/**
 * `ctenifaktur version` — which build is actually installed.
 *
 * The number has to come from `package.json`, not from a constant somebody has
 * to remember to bump: a version the CLI prints and a version npm installed
 * that disagree turn every bug report into a guess about which build produced
 * it. The tests therefore compare against the manifest rather than a literal.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./helpers.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));

describe("version", () => {
  for (const argv of [["version"], ["--version"]]) {
    test(`\`${argv.join(" ")}\` prints the version from package.json`, async () => {
      const result = await runCli(argv, {});

      assert.equal(result.code, 0);
      assert.equal(result.stdout, `${manifest.version}\n`);
    });
  }

  test("under --json it is a document, not a bare line", async () => {
    const result = await runCli(["--json", "version"], {});

    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { version: manifest.version });
    assert.equal(result.stdout.trimEnd().split("\n").length, 1);
  });

  test("answers with no key and an unusable CF_API_URL", async () => {
    // Nothing here talks to the API, so neither the guard that refuses a
    // non-https address nor the login check may run first. Both are reasons
    // somebody asks which build they are on in the first place, and the empty
    // key matters because `runCli` otherwise supplies one.
    const result = await runCli(["--version"], {
      env: { CF_API_URL: "ne-adresa", CF_API_KEY: "" },
    });

    assert.equal(result.code, 0);
    assert.equal(result.stdout, `${manifest.version}\n`);
  });
});

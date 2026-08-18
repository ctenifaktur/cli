/**
 * Test helpers: a stub of the public API and a runner for the built CLI.
 *
 * The tests drive `dist/ctenifaktur.js` as a subprocess rather than importing
 * its internals. Everything worth asserting here is observable from outside:
 * which line lands on stdout versus stderr (stdout has to stay pipeable into
 * `export`), and the exit code (a partially failed batch must not read as
 * success to a cron job). Driving the real binary also covers the argument
 * parsing and the top-level error handling that an import would skip.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const CLI = join(here, "..", "dist", "ctenifaktur.js");

/**
 * Minimal stand-in for `/api/v1` plus the presigned storage endpoint.
 *
 * @param options.batches Snapshots returned by `GET /batches/:id`, one per
 *   call; the last one repeats, so a single-element array is a batch that
 *   never changes.
 * @param options.documents Response for `POST /documents` and
 *   `POST /bank-statements`. `uploadUrl` is filled in by the stub, so callers
 *   only give `uploadId` and `fileName`.
 * @param options.putStatus HTTP status per `uploadId` for the storage PUT,
 *   default 200. Use a 4xx to make an upload fail without any retry wait.
 * @param options.exportFile Bytes returned by either export endpoint, with the
 *   file name the CLI is supposed to take from `Content-Disposition`.
 */
export async function startStub({ batches = [], documents, putStatus = {}, exportFile } = {}) {
  const received = {
    batchPolls: 0,
    puts: [],
    idempotencyKeys: [],
    prepared: [],
    /** Which upload endpoint each prepare call hit — the declaration under test. */
    preparedPaths: [],
    /** `{ path, body }` per export call, so a test can assert the field name. */
    exports: [],
  };
  let base = "";

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.method === "GET" && url.pathname.startsWith("/api/v1/batches/")) {
      req.resume();
      const snapshot = batches[Math.min(received.batchPolls, batches.length - 1)];
      received.batchPolls++;
      return json(200, snapshot);
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/api/v1/documents/export" ||
        url.pathname === "/api/v1/bank-statements/export")
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.exports.push({
        path: url.pathname,
        body: JSON.parse(Buffer.concat(chunks).toString()),
      });
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${exportFile?.filename ?? "export.bin"}"`,
      });
      return res.end(exportFile?.content ?? "");
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/api/v1/documents" || url.pathname === "/api/v1/bank-statements")
    ) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.idempotencyKeys.push(req.headers["idempotency-key"]);
      received.preparedPaths.push(url.pathname);
      received.prepared.push(JSON.parse(Buffer.concat(chunks).toString()));
      return json(200, {
        batchId: documents.batchId,
        uploads: documents.uploads.map((upload) => ({
          ...upload,
          uploadUrl: `${base}/storage/${upload.uploadId}`,
          expiresAt: "2030-01-01T00:00:00.000Z",
        })),
      });
    }

    if (req.method === "PUT" && url.pathname.startsWith("/storage/")) {
      req.resume();
      const uploadId = url.pathname.slice("/storage/".length);
      received.puts.push(uploadId);
      res.writeHead(putStatus[uploadId] ?? 200);
      return res.end();
    }

    req.resume();
    return json(404, { error: { code: "not_found", message: url.pathname } });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs the built CLI against a stub and collects both streams separately.
 *
 * HOME and XDG_CONFIG_HOME point at a throwaway directory so a test can never
 * read or overwrite the developer's real `credentials.json`.
 *
 * A run that overruns `killAfterMs` is killed and reported as `timedOut`. The
 * failure mode being tested is a CLI that waits half an hour for a batch, so
 * without this the suite would hang instead of going red.
 */
export async function runCli(args, { base, env = {}, cwd, killAfterMs = 12_000 } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ctenifaktur-test-"));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CF_API_URL: base,
        CF_API_KEY: "cf_live_test",
        ...env,
      },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, killAfterMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Writes `content` to `dir/relative`, creating the parent directories. */
export async function writeFixture(dir, relative, content = "%PDF-1.4 test") {
  const path = join(dir, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

export function tempDir() {
  return mkdtemp(join(tmpdir(), "ctenifaktur-fixtures-"));
}

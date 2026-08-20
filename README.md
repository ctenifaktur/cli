# Čtení Faktur CLI

[![npm](https://img.shields.io/npm/v/ctenifaktur)](https://www.npmjs.com/package/ctenifaktur)
[![license](https://img.shields.io/npm/l/ctenifaktur)](./LICENSE)

Upload invoices, receipts and bank statements, wait for the data to be extracted, and download a file your accounting software can import. A dependency-free client for the [Čtení Faktur](https://ctenifaktur.cz) API, the Czech invoice digitization service.

![Demo](docs/demo.gif)

## Install

```bash
npm install -g ctenifaktur
```

Or without installing:

```bash
npx ctenifaktur units
```

Needs Node 20 or newer. Works through `bunx`, `pnpm dlx` and `yarn dlx` too.

## Log in

```console
$ ctenifaktur login
Klíč pro https://ctenifaktur.cz (nevypisuje se):
Přihlášeno k https://ctenifaktur.cz, klíč uložen do /Users/you/.config/ctenifaktur/credentials.json.
```

Issue a key in the app under **Tým a nastavení → API klíče** (team settings → API keys). The secret is shown once, at creation. The API is part of the paid plans.

`login` does not echo the key and takes no `--key` flag, so it stays out of your shell history and out of `ps`. It verifies the key against the API before writing anything, then stores it with mode `0600`, keyed by API host so a production and a local login can coexist. `ctenifaktur logout` forgets it again, which does not revoke the key itself; that happens in the app.

For CI and containers, `CF_API_KEY` takes precedence over the stored key and needs no login:

```bash
CF_API_KEY=cf_live_... ctenifaktur upload invoice.pdf
echo "$CF_API_KEY" | ctenifaktur login    # or store it once, from a pipe
```

`CF_API_URL` points the client at a different host and defaults to `https://ctenifaktur.cz`. Plain `http://` is refused for anything but localhost, because the key travels in the `Authorization` header.

## Usage

```bash
ctenifaktur login
ctenifaktur logout
ctenifaktur units
ctenifaktur upload <file...> [--unit <id>] [--idempotency-key <key>]
ctenifaktur upload-statement <file...> [--unit <id>] [--idempotency-key <key>]
ctenifaktur status <batch-id>
ctenifaktur export <document-id...> --format <isdoc|pohoda|money-s3> [--out <file>]
ctenifaktur export-statement <statement-id...> --format <gpc|sepa-xml> [--out <file>]
```

From a folder of PDFs to a file you can import:

```console
$ ctenifaktur units
6a5b41d8e7c204f93a1b8e62  Ukázková firma s.r.o. (IČO 12345679, pohoda)

$ ctenifaktur upload doklady/*.pdf --unit 6a5b41d8e7c204f93a1b8e62
Dávka 7da58615-dcac-4a15-9443-d836b7d8cec7, zpracovávám 2 soubory…
faktura-01.pdf: e48428a7-52af-4dc2-981f-dfba661a71ae
faktura-02.pdf: af668802-4304-4623-9ec4-fd89293e69e0
Stav dávky: completed

$ ctenifaktur export e48428a7-52af-4dc2-981f-dfba661a71ae \
    af668802-4304-4623-9ec4-fd89293e69e0 --format pohoda --out import.xml
import.xml
```

`upload` blocks until extraction finishes and prints the document ids for each file. One file can produce several documents when it holds several invoices. Every extracted document costs a credit.

Bank statements are a separate pair of commands, not a flag:

![Bank statement demo](docs/demo-statements.gif)

They take PDFs, images and payment-gateway CSV reports, and export to GPC or SEPA XML (camt.053). A statement costs one credit per three pages started, a CSV report one credit; the page count is only known during processing, so the final price is not settled at upload time.

One caveat for gateway reports: a gateway does not print an account number, and both export formats require one. Such a statement uploads and bills fine, then `export-statement` fails with `invalid_request` on `header.accountNumber` — the account has to be filled in in the web app first, which no command here can do.

Separate commands rather than `upload --statement` on purpose: forgetting the flag would send a statement down the invoice pipeline, where it is accepted, billed, and exported as an invoice from the bank with every amount zero. A command you have to name cannot be forgotten.

The key needs the matching permissions. Statement commands want a key issued with **Číst bankovní výpisy** / **Nahrávat bankovní výpisy** ticked; a key issued only for documents answers `insufficient_scope`. Permissions cannot be changed on an existing key, so widen it by issuing a new one.

The exit code is `0` only when the whole batch succeeded. A partial run exits `1`, so a script or a cron job cannot mistake it for a clean one, and `status` follows the same rule once the batch is finished.

If `upload` is interrupted, the batch keeps running on the server. Pick it back up with `ctenifaktur status <batch-id>` rather than uploading again, which would extract and bill everything a second time.

`ctenifaktur --help` documents every flag, the limits and the exit codes.

The rate limit is counted per key per minute. When it runs out the CLI waits for `Retry-After` and retries, and if the limit still holds, the run ends by printing the `ctenifaktur status <batch-id>` command to pick the batch up with, because the batch is already paid for and keeps running on the server. A refusal that carries `details`, such as a mixed-unit export or a validation error, prints them line by line, so the advice to split the batch by unit can actually be followed.

> The CLI speaks Czech, like the rest of the product and its users. Error codes are the exception: the `code` before the colon is English and stable enough to branch on, the prose after it is not.

## AI agent skill

The repo ships a skill that teaches coding agents to drive this CLI:

```bash
# Asks which agents to install it for.
npx skills@latest add ctenifaktur/cli

# Or name them, for a scripted setup.
npx skills@latest add ctenifaktur/cli -g -a claude-code -a codex -a cursor -y
```

That covers Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI and the rest of the agents [`skills`](https://github.com/vercel-labs/skills) knows about. A running session does not pick the skill up on its own; in Claude Code, `/reload-skills` does it without a restart. Source: [`skills/ctenifaktur`](./skills/ctenifaktur/SKILL.md).

## Development

The source is a single TypeScript file with no runtime dependencies, compiled with `tsc`, so Node alone is enough to build it.

```bash
npm install
npm run typecheck
npm run build      # dist/ctenifaktur.js
```

Comments in `src/` are Czech, like the rest of the codebase this was extracted from.

## Documentation

- [API guide](https://ctenifaktur.cz/napoveda/api/pripojeni-pres-api) in the help center (Czech)
- [API reference](https://ctenifaktur.cz/api-dokumentace) with a try-it panel ([English](https://ctenifaktur.cz/api-dokumentace?lang=en))
- [OpenAPI document](https://ctenifaktur.cz/api/v1/openapi.json), public, no key required

## License

MIT

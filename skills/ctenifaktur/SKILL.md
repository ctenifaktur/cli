---
name: ctenifaktur
description: Turn Czech invoices, receipts and bank statements into accounting-ready files from the command line via the Čtení Faktur API. Use when the user wants data extracted from invoice PDFs or scans, a batch of documents turned into ISDOC, Pohoda XML or Money S3 XML, bank statements turned into GPC or SEPA XML, or any of it fed into Czech accounting software, and when they mention ctenifaktur, ISDOC, GPC or Czech invoice digitization. Uploading spends the user's credits.
---

# Čtení Faktur CLI

```bash
npm install -g ctenifaktur      # or: npx ctenifaktur <command>
ctenifaktur login               # prompts for the key, verifies it, stores it 0600
```

Never run `login` yourself with a key you invented or found in a file. If the
user is not logged in, ask them to run it. In CI, `CF_API_KEY` wins over the
stored key, so a pipeline needs no login at all.

```bash
ctenifaktur login                                            # store an API key
ctenifaktur logout                                           # forget it again
ctenifaktur units                                            # accounting units
ctenifaktur credits                                          # what the office can still process
ctenifaktur upload <file...> [--unit <id>]                   # upload, wait, print document ids
ctenifaktur upload-statement <file...> [--unit <id>]         # same, for bank statements
ctenifaktur status <batch-id>                                # check a batch, running or finished
ctenifaktur export <ids...> --format pohoda [--out file]     # write the export file
ctenifaktur export-statement <ids...> --format gpc [--out file]

ctenifaktur --json <command...>                              # parse this, not the prose
```

**`ctenifaktur --help` documents every flag, the limits and the exit codes.**
Read it before guessing. Output is Czech; the error `code` before the colon is
English and stable, the prose after it is not.

**Use `--json` whenever you are going to read the output yourself.** It is a
global switch, it works on every command, and with it standard output is exactly
one JSON document and nothing else — progress and warnings go to stderr. Read
the prose mode only when you are showing the output to the user.

For `units`, `credits`, `status` and `upload` the document is the `/api/v1`
response passed through unchanged, so it is the shape the OpenAPI document
specifies. `export`, `login` and `logout` have no API response to pass through —
those three documents are the CLI's own and are described below. `--help` is the
one command with no document at all: it stays prose and goes to stderr.

## Rules

**Confirm before uploading.** Each extracted document costs a credit, and one
PDF can hold several invoices, so a 30-file batch can cost more than 30 credits.
List the files for the user and wait for a yes. Never upload a directory you
have not enumerated. `ctenifaktur credits` says what is left before you spend
it: the plan half of that number resets at the date it prints, the credit half
does not. For bank statements it is an estimate, because they cost one credit
per three pages started and the page count is known only during processing.

**Never re-upload to recover.** `upload` can block for up to 30 minutes, so a
tool timeout or a dropped connection kills it more often than any other
command. The batch keeps running on the server regardless. Recover
with `ctenifaktur status <batch-id>`, using the batch id from the `Dávka …`
line — which is on stdout normally and on stderr under `--json`. Re-running
`upload` extracts and bills everything a second time, unless you reuse the
exact same `--idempotency-key`. A rate limit mid-batch is not one of these
cases: the CLI waits out `Retry-After` and retries, and if the limit still
holds it ends by printing the `status` command to recover with.

**Exit `1` does not mean nothing worked.** A batch that ends
`completed_with_failures` also exits `1`, on purpose, so scripts cannot mistake
a partial run for a clean one. Read the per-file lines — or `uploads[]` under
`--json`: the documents that came back are real and exportable.

**A bank statement is never an invoice.** The two have separate commands, and
the command IS the declaration — nothing sniffs the file. `upload` on a bank
statement is accepted, billed, and exports as an invoice from the bank with
every amount zero, so check what the file actually is before choosing.
Statements take PDFs, images and payment-gateway CSV reports. A PDF or an image
costs one credit per three pages started, so a 30-page statement is 10 credits,
and that price is only settled during processing; a CSV report is a flat one
credit, because it is parsed without the AI. A gateway report carries no account
number and both export formats need one, so `export-statement` on one fails with
`invalid_request` until someone fills the account in in the web app; the upload
is billed either way, so say so before uploading one. Their ids belong to
`export-statement` (`gpc`, `sepa-xml`) and are refused by `export` as
`not_found`; `status` marks such a batch `(bankovní výpisy)`. Statement commands
need a key issued with the bank-statement permissions ticked, otherwise
`insufficient_scope` — a key issued for documents alone cannot be widened, the
user has to issue a new one.

**One accounting unit per export.** Applies to documents, not to statements.
The file carries one IČO. Mixing units is
rejected with `mixed_accounting_units`, and the refusal lists every document
with its `accountingUnitId` and `ico` on its own line underneath — split by
those lines and run `export` once per unit. `--format isdoc` returns a `.isdoc` file for a single document
but a ZIP for several, so do not hand `--out` an `.isdoc` name for a
multi-document export.

**Idempotency.** Each run generates a fresh key, which covers a retried network
call but not you running the command twice. If the upload is scheduled or you
may retry it, pass `--idempotency-key` yourself and reuse the same value.

**No key.** Send the user to **Tým a nastavení → API klíče** in the app, then
have them run `ctenifaktur login`. The secret is shown once, at creation, and
the API needs a paid plan (`plan_required` means the free plan). Never put a key
in a command line, a file you write, or a commit: `login` exists so it stays out
of shell history and process listings.

## Reading the output

```
faktura-01.pdf: e48428a7-52af-4dc2-981f-dfba661a71ae, af668802-4304-4623-9ec4-fd89293e69e0
sken.jpg: zpracovává se                 not done yet, only ever seen via status
uctenka.pdf: selhalo (source_rejected)  this file failed, the rest ran on
Stav dávky: completed_with_failures
```

The code in brackets says what to do next. `source_rejected` means the same file
will fail the same way, so do not re-send it. `insufficient_credits` is bank
statements only: their price is per page and is settled during processing, so
nothing was charged for that file, and it goes through once the office tops up.

A `neúplné` line on stderr means the upload worked but the file held more
invoices than came out, and the two counts want opposite responses:
`nezpracováno` (discarded) are invoices that were recognised but never
processed, usually because credits ran out, and re-uploading gets them. `bez
vytěžených dat` (unparsed) are ones nothing could be read from, where
re-uploading the same file burns credits for the same result. Either way say so,
because the batch otherwise reads as finished.

### The same batch under `--json`

```jsonc
{
  "id": "7da58615-…", "kind": "documents", "status": "completed_with_failures",
  "counts": { "total": 3, "pending": 0, "processing": 0, "completed": 2, "failed": 1 },
  "uploads": [
    { "fileName": "faktura-01.pdf", "status": "completed", "documentIds": ["e48428a7-…"] },
    { "fileName": "sken.jpg", "status": "completed", "documentIds": ["af668802-…"],
      "incomplete": { "discarded": 2, "unparsed": 1 } },   // same warning as the `neúplné` line
    { "fileName": "uctenka.pdf", "status": "failed", "documentIds": [],
      "errorCode": "source_rejected" }                     // same code as the brackets
  ]
}
```

Everything above applies unchanged; it is the same information as a structure.
Ids for an export are `[.uploads[].documentIds[]]`, what failed and why is
`.uploads[] | select(.errorCode)`, and `kind` says whether those ids belong to
`export` or to `export-statement` — in prose mode that fact is a parenthesis on
one line, here it is a field.

`upload --json` prints this same document once, when the batch finishes, so a
run you had to recover with `status` parses identically to one that completed.
The `Dávka <id>` line you recover with is on stderr in this mode — capture it
too, or you lose the batch id if the run is killed.

An error is a document as well, and it is the API's own envelope:

```json
{ "error": { "code": "mixed_accounting_units", "message": "…",
             "details": { "documents": [{ "id": "…", "accountingUnitId": "…", "ico": "…" }] } } }
```

Branch on `error.code`, never on `message`. `details` is what the refusal tells
you to split the batch by, so a mixed-unit export is now a `group_by` rather
than a parse of Czech.

`error.code` comes from one of three namespaces. The API's own codes are in the
OpenAPI document. `http_<status>` means the response carried no error envelope
at all, almost always a gateway `502`/`503` in front of the app — treat it as a
transient outage, not as a rejected request. Codes prefixed `cli_` come from the
CLI itself: `cli_usage` (you called it wrong), `cli_not_logged_in`,
`cli_file_not_found`, `cli_upload_failed` (nothing reached storage, nothing was
charged), `cli_timeout` and `cli_network`, `cli_unexpected`.

`cli_timeout` and `cli_network` on an `upload` mean the batch may well still be
running: recover it with `status`, using the batch id from the `Dávka` line on
stderr — capture stderr, because the document carries the id only inside the
Czech `message`. On any other command they just mean the request did not get
through, and there is no batch id to recover with; retry the command.

There is no JSON export format, and asking for one is a dead end: extracted
document data leaves the service only as ISDOC, Pohoda or Money S3. If the user
wants an analysis over the invoice contents, export the documents and read that
file. `--json` tells you what happened to a batch, not what is on an invoice.

## Beyond the CLI

The OpenAPI document is public and needs no key:
`https://ctenifaktur.cz/api/v1/openapi.json?lang=en`

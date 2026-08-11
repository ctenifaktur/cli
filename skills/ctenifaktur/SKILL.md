---
name: ctenifaktur
description: Turn Czech invoices and receipts into accounting-ready files from the command line via the Čtení Faktur API. Use when the user wants data extracted from invoice PDFs or scans, a batch of documents turned into ISDOC, Pohoda XML or Money S3 XML, or invoices fed into Czech accounting software, and when they mention ctenifaktur, ISDOC or Czech invoice digitization. Uploading spends the user's credits.
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
ctenifaktur upload <file...> [--unit <id>]                   # upload, wait, print document ids
ctenifaktur status <batch-id>                                # check a batch, running or finished
ctenifaktur export <ids...> --format pohoda [--out file]     # write the export file
```

**`ctenifaktur --help` documents every flag, the limits and the exit codes.**
Read it before guessing. Output is Czech; the error `code` before the colon is
English and stable, the prose after it is not.

## Rules

**Confirm before uploading.** Each extracted document costs a credit, and one
PDF can hold several invoices, so a 30-file batch can cost more than 30 credits.
List the files for the user and wait for a yes. Never upload a directory you
have not enumerated.

**Never re-upload to recover.** `upload` can block for up to 30 minutes, so a
tool timeout or a dropped connection kills it more often than any other
command. The batch keeps running on the server regardless. Recover
with `ctenifaktur status <batch-id>`, using the batch id from the `Dávka …`
line. Re-running `upload` extracts and bills everything a second time, unless
you reuse the exact same `--idempotency-key`.

**Exit `1` does not mean nothing worked.** A batch that ends
`completed_with_failures` also exits `1`, on purpose, so scripts cannot mistake
a partial run for a clean one. Read the per-file lines: the documents that were
printed are real and exportable.

**One accounting unit per export.** The file carries one IČO. Mixing units is
rejected with `mixed_accounting_units`; split the ids by unit and run `export`
once per unit. `--format isdoc` returns a `.isdoc` file for a single document
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

A `neúplné` line on stderr means the upload worked but the file held more
invoices than came out, and the two counts want opposite responses:
`nezpracováno` (discarded) are invoices that were recognised but never
processed, usually because credits ran out, and re-uploading gets them. `bez
vytěžených dat` (unparsed) are ones nothing could be read from, where
re-uploading the same file burns credits for the same result. Either way say so,
because the batch otherwise reads as finished.

## Beyond the CLI

The OpenAPI document is public and needs no key:
`https://ctenifaktur.cz/api/v1/openapi.json?lang=en`

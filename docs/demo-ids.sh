#!/bin/sh
# Companion to docs/demo.tape. Start it just before `vhs docs/demo.tape`.
#
# The tape has to type the document ids into the `export` line, but the upload
# only prints them while the recording runs. This watches the session log the
# tape's hidden `script` writes, and as soon as the upload has printed its ids
# it puts them on the clipboard for the tape's `Paste`.
#
# The first uuid in the log is the batch, the ones after it are the documents
# (or the statement).
set -eu

LOG=${1:-/tmp/ctenifaktur-demo.log}
# How many ids to hand over: two documents for demo.tape, one statement for
# demo-statements.tape.
WANT=${2:-2}
UUID='[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}'

rm -f "$LOG"
i=0
while [ "$i" -lt 6000 ]; do
  if [ -f "$LOG" ]; then
    ids=$(LC_ALL=C grep -o "$UUID" "$LOG" | tail -n +2 | head -"$WANT" | tr '\n' ' ')
    if [ "$(printf '%s' "$ids" | wc -w | tr -d ' ')" = "$WANT" ]; then
      printf '%s' "$ids" | pbcopy
      echo "clipboard: $ids"
      exit 0
    fi
  fi
  i=$((i + 1))
  sleep 0.2
done

echo "demo-ids: no document ids in $LOG, the Paste will type stale clipboard" >&2
exit 1

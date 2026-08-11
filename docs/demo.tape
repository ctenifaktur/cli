# Demo GIF for the README — https://github.com/charmbracelet/vhs
#
#   sh path/to/demo-ids.sh &
#   vhs path/to/demo.tape        # writes demo.gif into the current directory
#
# Everything on screen is a real run against a real server. Re-recording it
# needs, in the directory VHS is started from:
#
#   * `ctenifaktur` on PATH (`bun run build`, then link `dist/ctenifaktur.js`
#     somewhere on PATH and make it executable)
#   * CF_API_KEY and CF_API_URL exported — VHS passes its environment through,
#     which is how the key stays out of every frame and out of this file
#   * doklady/faktura-01.pdf and doklady/faktura-02.pdf to upload
#   * the id of an accounting unit the key can reach, in the `upload` line below
#
# The document ids in the `export` line are not known when the tape is written:
# the upload prints them. demo-ids.sh, started alongside VHS, reads them out of
# the session log the hidden `script` below records, and puts them on the
# clipboard, so the `Paste` types the ids this very run produced.
#
# Extraction takes minutes. The `Hide` block around the wait is the only edit to
# the timeline — no output line is faked, reordered or shortened.

Output demo.gif

Require ctenifaktur

Set Shell bash
Set Theme "Catppuccin Mocha"
Set FontSize 18
Set Width 1000
Set Height 320
Set Padding 24
Set Framerate 20
Set CursorBlink false
Set TypingSpeed 40ms

# Setup, before the first recorded frame: log the session for demo-ids.sh and
# drop the shell prompt to a bare `$` so no hostname or username is on screen.
Hide
Type "script -q -F /tmp/ctenifaktur-demo.log bash --norc" Enter
Sleep 2s
Type "PS1='$ '" Enter
Sleep 500ms
Type "clear" Enter
Sleep 500ms
Show

Sleep 800ms
Type "ctenifaktur units" Sleep 400ms Enter
Wait+Screen@60s /Ukázková/
Sleep 1500ms

Type "ctenifaktur upload doklady/*.pdf --unit 6a5b41d8e7c204f93a1b8e62" Sleep 400ms Enter
Wait+Screen@120s /Dávka/
Sleep 2s

# The real wait for the AI extraction, off camera.
Hide
Wait+Screen@1800s /Stav dávky/
Show

Sleep 2500ms
Type "ctenifaktur export "
Paste
Type "--format pohoda --out import.xml" Sleep 400ms Enter
# Not a Wait: the command line itself contains `import.xml`, so a screen match
# would fire before the export ran. The download takes about two seconds.
Sleep 5s

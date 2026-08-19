# Second demo GIF for the README, the bank-statement pair of commands.
# https://github.com/charmbracelet/vhs
#
#   sh path/to/demo-ids.sh /tmp/ctenifaktur-demo.log 1 &
#   vhs path/to/demo-statements.tape   # writes demo-statements.gif into cwd
#
# Same rules as demo.tape: a real run against a real server, nothing faked.
# What it needs in the directory VHS starts from:
#
#   * `ctenifaktur` on PATH (`npm run build`, then link `dist/ctenifaktur.js`
#     somewhere on PATH and make it executable)
#   * CF_API_KEY and CF_API_URL exported — VHS passes its environment through,
#     so the key never appears in a frame or in this file. The key needs the
#     bank-statement permissions ticked, a documents-only key answers
#     `insufficient_scope`.
#   * vypis-07.pdf to upload
#   * the id of an accounting unit the key can reach, in the `upload` line below
#
# The statement id in the `export-statement` line is only known once the upload
# has printed it. demo-ids.sh, started alongside VHS, reads it out of the
# session log the hidden `script` records and puts it on the clipboard, so the
# `Paste` types the id this very run produced. `1` is how many ids to take: one
# statement here, against two documents in demo.tape.

Output demo-statements.gif

Require ctenifaktur

Set Shell bash
Set Theme "Catppuccin Mocha"
Set FontSize 18
Set Width 1000
# Lower than demo.tape's 320: this run is three lines shorter, and the extra
# rows would just be dead space under the last line.
Set Height 260
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
Type "ctenifaktur upload-statement vypis-07.pdf --unit 6a5b41d8e7c204f93a1b8e62" Sleep 400ms Enter
Wait+Screen@120s /Dávka/
Sleep 2s

# The real wait for the extraction, off camera. The only edit to the timeline.
Hide
Wait+Screen@1800s /Stav dávky/
Show

Sleep 2500ms
Type "ctenifaktur export-statement "
Paste
Type "--format gpc" Sleep 400ms Enter
# Not a Wait: the file name the export prints is not on screen beforehand, but
# the download is over in well under a second either way.
Sleep 4s

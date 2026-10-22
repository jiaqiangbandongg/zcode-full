# CUA ACT-VERIFY scenarios — coverage & design

This is the coverage doc for the **act-verify** e2e suite
(`scripts/cua_act_verify.py`). It is the act-verify counterpart to the existing
**observe-only** `scripts/e2e_opus.py`: the model PERFORMS a task and we VERIFY a
deterministic post-condition — "the model clicked" is not success; the verifiable
side effect is.

## The act-verify contract (vs. observe-only)

| | observe-only (`e2e_opus.py`) | **act-verify (`cua_act_verify.py`)** |
|---|---|---|
| model calls | `get_app_state`, then reports | `get_app_state` → **act** (`left_click`/`type`/`set_value`/...) → `get_app_state` |
| what counts as success | the model produced a description | **an independent verifier** confirms the post-state |
| pass signal | exit 0 if any tool fired | PASS only if `model_acted AND verify_passed` |

Every scenario has three independent phases the harness runs for you:

1. **setup** — deterministic prep (open the app, clear the document, create a
   fixture) so the model starts from a known state;
2. **act** — drive the real model (GLM-5V-Turbo) via `scripts/e2e_opus.py` with a
   task prompt that tells it to act through the a11y-first MCP tools;
3. **verify** — read the post-state with a method that does NOT trust the model's
   claim: AppleScript reads TextEdit/Finder/Notes/Terminal directly, `pbpaste`
   reads the clipboard, the Calculator display is read via System Events.

## How to run (local, real model, billed)

```bash
# Prerequisites (one-time, GUI):
#   1. unlock the screen (live CUA can't run behind the loginwindow shield)
#   2. System Settings > Privacy & Security > Accessibility    -> add the python executable that runs the harness
#   3. System Settings > Privacy & Security > Input Monitoring -> add the same executable
#   4. System Settings > Privacy & Security -> Screen Recording -> add the same executable
#      (without it the preflight prints a WARNING and per-app raster grabs the
#       wallpaper, not the target window — raster-based scenarios degrade)
#
# The act-verify harness runs on SYSTEM python3 (no `uv`, no `pyproject.toml`,
# no `.venv` — the Python MCP server was removed; only the harness stays).
# Install its deps once (see AGENTS.md §"Act-verify harness"):
python3 -m pip install mcp pyautogui pyobjc-framework-Quartz pyobjc-framework-ApplicationServices

# full suite (80 scenarios; spaces calls ~30s to avoid BigModel 429s)
python3 scripts/cua_act_verify.py --ts-server

# a subset
python3 scripts/cua_act_verify.py --ts-server --only AV01,AV03,AV08,AV22,AV28

# just the environment preflight (no model calls)
python3 scripts/cua_act_verify.py --ts-server --preflight-only
```

Artifacts land in `artifacts/act-verify/` (gitignored): one `result.json` +
`e2e_opus.stdout` + `ledger/{manifest.json,frames.jsonl}` per scenario, a combined
`summary.json`, and a `preflight.json`. The human report is written to
`/tmp/act-verify-e2e-report.md` (override with `--report`).

The per-tool-call **recording ledger** (!179) is enabled per scenario by pointing
`ZCODE_CUA_LEDGER_DIR` at the scenario's `ledger/` dir; it captures every tool's
redacted input + result/exception + duration + the exact backend method that crossed
the OS boundary.

## Environment preflight (fail-fast)

The harness refuses to burn billed model calls into a wall. It blocks (exit 0,
`status=BLOCKED`, zero API calls) when any of these hold:

- **screen locked** — `CGSSessionScreenIsLocked == true`. Behind the loginwindow
  shield AX returns `-25211` and AppleEvents time out (`-1712`); no app is
  actuable. (This is the same blocker documented in the MEMORY note
  `zcode-cua-m09-unlocked-console-verify`: locked-screen live runs are
  `infra_fail`, not real failures.)
- **Accessibility not trusted** — `AXIsProcessTrusted() == false` for the python
  executable running the server. `get_app_state` fail-closes with
  `permission_blocked`. (Note: `request_access` can report `accessibility:true`
  from a non-authoritative heuristic; `AXIsProcessTrusted()` is the source of
  truth and is what the preflight uses.)
- **pyobjc macos deps missing** — `No module named 'ApplicationServices'`. Fix
  with `python3 -m pip install pyobjc-framework-Quartz pyobjc-framework-ApplicationServices`
  (the `uv sync --extra macos` form is stale — no `pyproject.toml` / `uv` workflow on current `main`).

The preflight also emits non-blocking **WARNING**s (printed as `WARNING:` and
recorded under `evidence.warnings` in `preflight.json`). These degrade specific
scenarios but never block the suite, so they are surfaced loudly instead of
silently corrupting a run:

- **Screen Recording not granted** (`CGPreflightScreenCaptureAccess() == false`, a
  non-prompting probe; also recorded as `evidence.screen_recording_granted`).
  AX-only scenarios (Calculator/TextEdit read via the AX tree) still pass, but the
  per-app raster returned by `get_app_state` with `include_screenshot` captures the
  desktop wallpaper instead of the target window, so any raster-dependent scenario
  degrades to a blank frame. Grant Screen
  Recording to the same executable to clear it.
- **Active keyboard input source is a CJK IME / non-Latin layout** (recorded as
  `evidence.keyboard_input_source`). The ACTIVE input source is read via Text Input
  Source Services (`TISCopyCurrentKeyboardInputSource`, `ctypes` — no extra
  dependency), which reports the live input METHOD/MODE, so it catches a CJK input
  method (e.g. Pinyin, `com.apple.inputmethod.SCIM.ITABC`) layered over a Latin (ABC)
  layout — a case the HIToolbox *layout* default alone (the fallback when TIS is
  unavailable) cannot see. A CJK input method intercepts the harness's blind
  `type`/keystroke for composition, so typed text lands garbage and `type` scenarios
  false-FAIL. Switch to a Latin layout (ABC / U.S.) before an acceptance run. The
  harness only **detects and warns** — it never mutates the user's system input source.
- **Sticky iCloud TextEdit "Untitled N" backlog** (recorded as
  `evidence.icloud_textedit_backlog`, a count of `Untitled*.rtf` in
  `~/Library/Mobile Documents/com~apple~TextEdit/Documents/`). TextEdit **restores**
  these on launch (they survive quit/pkill, and the per-scenario hermetic reset only
  reaps the suite's OWN docs), so they shadow the front document and inflate TextEdit
  FAILs. Clear them before an acceptance run — they are USER iCloud data, so the
  harness **never deletes** them; it only reports the count.

Bypass for a forced live run despite the preflight: `--force` (you own the
consequence).

## Scenario matrix (80)

The suite spans **10 categories** of common computer-use tasks across **13 apps**
(Calculator, TextEdit, Finder, Notes, Terminal, Stickies, Safari, System Settings,
Activity Monitor, Preview, Dictionary, Font Book, and the Character Viewer). Every
scenario is **reversible** (fixtures live under `/tmp` and are removed; settings
toggles capture+restore their original — see the [Finder defaults recovery](#av78av79-finder-defaults-tri-state-recovery)
note for how an originally-ABSENT key is restored). PASS requires both
`model_acted` AND an independent `verify_passed`.

### AV01-AV17 (original suite)

| ID | Name | Class | App | Act path | Independent verify |
|----|------|-------|-----|----------|--------------------|
| AV01 | Calculator 7+5=12 | calculator-compute | `com.apple.calculator` | element-target `left_click` ×4 (Invoke) | Calculator display reads `12` (System Events) |
| AV02 | Calculator 8×3−4=20 | calculator-multi-step | `com.apple.calculator` | element `left_click` multi-step | display reads `20` |
| AV03 | TextEdit type "hello world" | textedit-type | `com.apple.TextEdit` | `type` tool (whole phrase) | `text of document 1` contains it |
| AV04 | TextEdit set_value "fixed" | textedit-set-value | `com.apple.TextEdit` | `set_value` on the text element | `text of document 1` == `fixed` |
| AV05 | Finder select target.txt | finder-navigate | `com.apple.finder` | element `left_click` on the file row | Finder `selection` == `[target.txt]` |
| AV06 | Notes create note | notes-create | `com.apple.Notes` | click "New Note" + `type` title | a note named `AV06_MARKER` exists (cleanup deletes it) |
| AV07 | Terminal `echo done` | terminal-command | `com.apple.Terminal` | `type` `echo done\n` | terminal tab `contents` contain `done` |
| AV08 | Clipboard copy | clipboard-copy | `com.apple.TextEdit` | `select_text` + Cmd+C (keyboard) | `pbpaste` contains `clipme-AV08` |
| AV09 | Stickies type marker | stickies-type | `com.apple.Stickies` | `type` into the note | note's static text contains the marker (cleanup clears it) |
| AV10 | Calculator 15÷3=5 | calculator-compute | `com.apple.calculator` | element `left_click` (÷ operator) | display reads `5` |
| AV11 | TextEdit append line | textedit-append | `com.apple.TextEdit` | `type` `\nline-two` at end | doc contains both `line-one` and `line-two` |
| AV12 | Finder open folder | finder-open | `com.apple.finder` | `open_application` / path action | front window `target` ends with `act-verify-fixture/` |
| AV13 | Finder drag file into folder | finder-drag | `com.apple.finder` | **`left_click_drag`** element→element | file exists at `DestFolder/moveme.txt` AND gone from parent (filesystem) |
| AV14 | Sound volume slider drag | settings-slider-drag | `com.apple.systempreferences` | **`left_click_drag`** on the volume slider | `get output volume of (get volume settings)` in 30..70 (cleanup restores) |
| AV15 | TextEdit type + select-all + bold | textedit-bold-multistep | `com.apple.TextEdit` | `type` → keyboard Cmd+A → Cmd+B | saved RTF source contains the marker + an RTF bold (`\b`) control word |
| AV16 | System Settings toggle Dock magnification | settings-navigate-toggle | `com.apple.systempreferences` | navigate pane + `left_click` a switch | `defaults read com.apple.dock magnification` flipped from captured original (cleanup restores) |
| AV17 | Copy from TextEdit, paste into Notes | clipboard-cross-app | `com.apple.TextEdit` | copy + `open_application` Notes + new note + paste | a Notes note contains `clipme-cross-av17` (cleanup removes it) |

### AV18-AV50 (33 new scenarios — 10-category expansion)

| ID | Name | Class | App | Act path | Independent verify |
|----|------|-------|-----|----------|--------------------|
| AV18 | TextEdit type + italic | textedit-italic-multistep | `com.apple.TextEdit` | `type` → Cmd+A → Cmd+I | saved RTF has marker + RTF italic (`\i`) control word |
| AV19 | TextEdit type + underline | textedit-underline-multistep | `com.apple.TextEdit` | `type` → Cmd+A → Cmd+U | saved RTF has marker + RTF underline (`\ul`) control word |
| AV20 | TextEdit select-all + clear | textedit-selectall-clear | `com.apple.TextEdit` | keyboard Cmd+A → Backspace | `text of document 1` is empty |
| AV21 | TextEdit 3 separate lines | textedit-multiline | `com.apple.TextEdit` | `type` `alpha\nbeta\ngamma` | doc has all 3 words + >=2 newlines |
| AV22 | TextEdit find & replace all | textedit-find-replace | `com.apple.TextEdit` | Edit>Find>Replace, type, Replace All | doc text == `bar alpha bar` (no `foo`) |
| AV23 | Finder rename file | finder-rename | `com.apple.finder` | Return → `type` new name → Return | FS: `newname-av23.txt` exists, `oldname` gone |
| AV24 | Finder navigate nested folder | finder-navigate-nested | `com.apple.finder` | double-`left_click` subfolder | front window `target` ends with `outer/inner` |
| AV25 | Finder move file to Trash | finder-trash | `com.apple.finder` | select + Cmd+Backspace | source file gone (cleanup restores from Trash) |
| AV26 | Finder duplicate file (Cmd+D) | finder-duplicate | `com.apple.finder` | select + Cmd+D | >=2 files matching `dupme-av26*` |
| AV27 | Finder create named folder | finder-new-folder | `com.apple.finder` | Cmd+Shift+N → `type` name | dir `/tmp/av27-newfolder/AV27Folder` exists |
| AV28 | Safari type URL in address bar | browser-type-url | `com.apple.Safari` | `open_application` + Cmd+L + `type` URL | `URL of front document` ends with `av28-fixture.html` |
| AV29 | Safari new tab (Cmd+T) | browser-new-tab | `com.apple.Safari` | keyboard Cmd+T | `count tabs of front window` >= 2 |
| AV30 | Safari click link to navigate | browser-click-link | `com.apple.Safari` | `left_click` the link element | `URL of front document` ends with `av30-b.html` |
| AV31 | System Settings toggle Dock auto-hide | settings-dock-autohide | `com.apple.systempreferences` | navigate + `left_click` switch | `defaults com.apple.dock autohide` flipped (restored) |
| AV32 | Finder Settings toggle filename extensions | finder-settings-toggle | `com.apple.finder` | Cmd+, → Advanced → checkbox | `defaults com.apple.finder AppleShowAllExtensions` flipped (restored) |
| AV33 | Clipboard cut | clipboard-cut | `com.apple.TextEdit` | Cmd+A → Cmd+X | `pbpaste` has marker AND doc empty |
| AV34 | Clipboard partial-select copy | clipboard-partial-copy | `com.apple.TextEdit` | `select_text` "BETA" → Cmd+C | `pbpaste` == `BETA` |
| AV35 | TextEdit edit opened file + save | textedit-edit-save | `com.apple.TextEdit` | select+`type` → Cmd+S | file on disk contains `av35-new` |
| AV36 | Terminal redirect to file | terminal-write-file | `com.apple.Terminal` | `type` `echo … > file` | `/tmp/av36-out.txt` contains the marker |
| AV37 | Notes create + type body | notes-body | `com.apple.Notes` | new note + `type` body via **real key input** | a note body contains `AV37_BODY_MARKER` — persists ONLY via real key input; a default element value-set does NOT commit (see [Notes body-write reconciliation](#notes-body-write-reconciliation)) |
| AV38 | TextEdit window resize (edge drag) | window-resize-drag | `com.apple.TextEdit` | **`left_click_drag`** corner→coordinate | `bounds of front window` changed (restored) |
| AV39 | Finder switch to List view | finder-view-list | `com.apple.finder` | Cmd+2 / View menu | `current view of front window` == `list view` |
| AV40 | Finder switch to Column view | finder-view-column | `com.apple.finder` | Cmd+3 / View menu | `current view of front window` == `column view` |
| AV41 | Calculator memory m+ then mr | calculator-memory | `com.apple.calculator` | element `left_click`: 5, m+, AC, mr | display reads `5` |
| AV42 | Calculator decimal 2.5+2.5 | calculator-decimal | `com.apple.calculator` | element `left_click` incl. `.` | display reads `5` |
| AV43 | Finder Get Info (context menu) | finder-context-menu | `com.apple.finder` | right-click + `left_click` menu item | a Finder "Info" window is present |
| AV44 | TextEdit close + Don't Save dialog | dialog-discard-unsaved | `com.apple.TextEdit` | Cmd+W → `left_click` Don't Save | 0 TextEdit windows open |
| AV45 | TextEdit select-word + replace | textedit-select-replace | `com.apple.TextEdit` | select "REPLACEME" → `type` "DONE" | doc == `alpha DONE gamma` |
| AV46 | Open Activity Monitor | app-launch-activity-monitor | `com.apple.ActivityMonitor` | `open_application` | `pgrep -x "Activity Monitor"` running |
| AV47 | TextEdit new document (Cmd+N) | textedit-new-document | `com.apple.TextEdit` | keyboard Cmd+N | >=2 TextEdit windows |
| AV48 | Finder new window (Cmd+N) | finder-new-window | `com.apple.finder` | keyboard Cmd+N | >=2 Finder windows |
| AV49 | Notes remove a note | notes-remove | `com.apple.Notes` | select + Backspace + confirm | note named `AV49_REMOVEME_MARKER` is gone |
| AV50 | Calculator chain 6+6+6 | calculator-chain | `com.apple.calculator` | element `left_click` chained `+` | display reads `18` |

### AV51-AV65 (15 more — reliable single-target element actions)

Biased to RELIABLE single-target element actions that exercise the a11y-first
element-target path: more Calculator button-by-button `Invoke`, TextEdit
`set_value` on a single text area (Notes `set_value` is the deliberate
NON-committal counter-case — see [Notes body-write reconciliation](#notes-body-write-reconciliation)), System Settings checkbox activation, Finder
`perform_action`, and app-launch + element-click scenarios (Preview, Dictionary,
Font Book, Character Viewer). Every task prompt steers the model to the NEUTRAL
activation verb ("press/activate") and to read the element's `actions` list for
the verb that backend announces — it never hardcodes a macOS-private `AX*` name
(see `test_scenario_tasks_have_no_platform_private_ax_tokens`).

| ID | Name | Class | App | Act path | Independent verify |
|----|------|-------|-----|----------|--------------------|
| AV51 | Calculator 9−3=6 (Invoke) | calculator-subtract-invoke | `com.apple.calculator` | element `left_click` buttons 9,−,3,= | display reads `6` |
| AV52 | Calculator 6×7=42 (Invoke) | calculator-multiply-invoke | `com.apple.calculator` | element `left_click` 6,×,7,= | display reads `42` |
| AV53 | Calculator 64−28=36 (Invoke) | calculator-subtract-multidigit-invoke | `com.apple.calculator` | element `left_click` multi-digit | display reads `36` |
| AV54 | TextEdit set_value replace | textedit-set-value-replace | `com.apple.TextEdit` | `set_value` text area | doc has `AV54_DONE`, not `AV54_OLD_MARKER` |
| AV55 | TextEdit set_value 2 lines | textedit-set-value-multiline | `com.apple.TextEdit` | `set_value` two lines | doc has both lines |
| AV56 | TextEdit set_value clear | textedit-set-value-clear | `com.apple.TextEdit` | `set_value` to `''` | doc is empty |
| AV57 | Notes set_value body | notes-set-value-body | `com.apple.Notes` | `set_value` body text area | **known non-persist**: `set_value` on the Notes body is non-committal (accepted+echoed, never committed) — NOT a product regression (see [reconciliation](#notes-body-write-reconciliation)) |
| AV58 | Notes title known-limitation | notes-title-known-limitation | `com.apple.Notes` | inspect / confirm | **KNOWN LIMITATION (xfail)**: Notes has NO separate title element (title = first body line), so a title `set_value` has no settable target — scored apart (`KNOWN_LIMITATION`), NOT a PASS and NOT a product FAIL (see [reconciliation](#notes-body-write-reconciliation)) |
| AV59 | Settings toggle "Show recent applications" | settings-dock-show-recents | `com.apple.systempreferences` | `perform_action`/`left_click` checkbox | `defaults com.apple.dock show-recents` flipped (restored) |
| AV60 | Settings toggle "Minimize into app icon" | settings-dock-minimize-to-app | `com.apple.systempreferences` | `perform_action`/`left_click` checkbox | `defaults com.apple.dock minimize-to-application` flipped (restored) |
| AV61 | Finder `perform_action` select file | finder-perform-action | `com.apple.finder` | `perform_action`/`left_click` file row | Finder `selection` == `[pickme-av61.txt]` |
| AV62 | Preview close image window | preview-close-window | `com.apple.Preview` | Cmd+W / close button | Preview has 0 open windows |
| AV63 | Dictionary search field type | dictionary-search | `com.apple.Dictionary` | focus field + `type` + Return | search field contains `apple` |
| AV64 | Open Font Book + click sidebar | app-launch-font-book | `com.apple.FontBook` | `open_application` + `left_click` | `pgrep "Font Book"` running + window present |
| AV65 | Character Viewer open + click category | app-launch-character-viewer | `com.apple.CharacterPaletteIM` | `open_application` + `left_click` | `pgrep CharacterPalette` running |

### AV66-AV80 (15 more — reliable element-target / set_value / defaults-toggle)

| ID | Name | Class | App | Act path | Independent verify |
|----|------|-------|-----|----------|--------------------|
| AV66 | Calculator 14+9=23 (Invoke) | calculator-add-multidigit-invoke | `com.apple.calculator` | element `left_click` 1,4,+,9,= | display reads `23` |
| AV67 | Calculator 7×8=56 (Invoke) | calculator-multiply-invoke | `com.apple.calculator` | element `left_click` 7,×,8,= | display reads `56` |
| AV68 | Calculator 63÷9=7 (Invoke) | calculator-divide-invoke | `com.apple.calculator` | element `left_click` 6,3,÷,9,= | display reads `7` |
| AV69 | TextEdit set_value replace marker | textedit-set-value-replace | `com.apple.TextEdit` | `set_value` text area | doc has `AV69_DONE`, not `AV69_OLD_MARKER` |
| AV70 | TextEdit set_value 3 lines | textedit-set-value-multiline | `com.apple.TextEdit` | `set_value` three lines | doc has all three lines |
| AV71 | TextEdit set_value clear | textedit-set-value-clear | `com.apple.TextEdit` | `set_value` to `''` | doc is empty |
| AV72 | Notes set_value body | notes-set-value-body | `com.apple.Notes` | `set_value` body | **known non-persist**: `set_value` on the Notes body is non-committal — NOT a product regression (see [reconciliation](#notes-body-write-reconciliation)) |
| AV73 | Notes title known-limitation | notes-title-known-limitation | `com.apple.Notes` | inspect / confirm | **KNOWN LIMITATION (xfail)**: Notes has NO separate title element (title = first body line) — scored apart (`KNOWN_LIMITATION`), NOT a PASS and NOT a product FAIL (see [reconciliation](#notes-body-write-reconciliation)) |
| AV74 | Finder `perform_action` select (alpha) | finder-perform-action | `com.apple.finder` | `perform_action`/`left_click` file row | Finder `selection` == `[alpha-av74.txt]` |
| AV75 | Finder `perform_action` select (gamma, decoys) | finder-perform-action | `com.apple.finder` | `perform_action`/`left_click` the right row | Finder `selection` == `[gamma-av75.txt]` |
| AV76 | Safari navigate via address bar | safari-address-bar-navigate | `com.apple.Safari` | Cmd+L + `type` `file://` URL + Return | `URL of front document` ends with `av76-fixture.html` |
| AV77 | Dictionary search field type | dictionary-search | `com.apple.Dictionary` | focus field + `type` + Return | search field contains `ocean` |
| AV78 | Finder toggle Show Path Bar | finder-view-pathbar-toggle | `com.apple.finder` | Opt+Cmd+P / View menu | `defaults com.apple.finder ShowPathbar` flipped (restored; see below) |
| AV79 | Finder toggle Show Status Bar | finder-view-statusbar-toggle | `com.apple.finder` | Cmd+/ / View menu | `defaults com.apple.finder ShowStatusBar` flipped (restored; see below) |
| AV80 | TextEdit set_value target phrase | textedit-set-value-marker | `com.apple.TextEdit` | `set_value` text area | doc contains `AV80_TARGET_PHRASE` |

### AV78/AV79 Finder defaults tri-state recovery

AV78/AV79 toggle a Finder user default (`com.apple.finder ShowPathbar` /
`ShowStatusBar`) and must restore the user's EXACT original config afterward.
`read_defaults_bool` collapses "key absent", "read failed", and explicit `False`
into one `False` — fine for a probe, but lossy for capture/restore: a key that
was ABSENT would be restored as `-bool false`, leaving a synthetic key behind.
AV78/AV79 therefore use the tri-state reader `read_defaults_state(domain, key)
-> (exists, value)`:

- key present + `1` → `(True, True)` → cleanup `defaults write ... -bool true`
- key present + `0` → `(True, False)` → cleanup `defaults write ... -bool false`
- key absent (`defaults read` reports "does not exist") → `(False, False)` →
  cleanup `defaults delete com.apple.finder <key>` (preserves the "unset" state)
- any OTHER read failure (timeout / bad domain / unparseable value) →
  `RuntimeError` → **setup fails** (`setup-error`), so the scenario does NOT run
  with a cleanup it cannot trust

Cleanup also guards the uncaptured case: if setup failed before it captured
(`_CAPTURED[s.sid]` has no `exists` entry), cleanup leaves defaults untouched —
the scenario never toggled them, so there is nothing to restore. Verified by
unit tests for all three original states plus the read-failure and
uncaptured paths (`tests/test_cua_act_verify.py`).

### Lifecycle: unified try/finally (setup → drive → verify → cleanup)

`run_one` wraps setup + drive + verify in ONE `try/finally` so **best-effort
cleanup always runs once setup has been attempted** — even when setup returns a
`setup-error`, the model drive times out, or `verify_scenario` raises. A thrown
exception is recorded on the record (`status=ERROR`/`SETUP_ERROR`, `error=...`)
so one bad scenario never aborts the whole suite, but it is **never masked**: a
cleanup exception is captured into `cleanup_status` separately and never
overwrites the original `error`. `result.json` is written exactly once, in the
`finally`, for every path. This is the guarantee that makes the AV78/79
Finder-defaults capture/restore (and every other stateful setup) safe across
partial-failure paths.

### Real-macOS verification requirement

These 80 scenarios are **live macOS GUI tests**, not hermetic unit tests. They
are only meaningful when run on real macOS hardware (or a macOS VM with a
visible desktop) with:

- the **console unlocked** (behind the loginwindow shield AX returns `-25211`
  and AppleEvents time out — see the preflight section);
- **Accessibility** granted to the python/uv executable running the server
  (`AXIsProcessTrusted() == true`);
- **Input Monitoring** granted to the same executable (for the raw-key fallback
  paths the model uses when an app's AX tree is momentarily empty);
- the active **keyboard input source set to a Latin layout** (ABC / U.S.) — a CJK
  IME (e.g. Pinyin) corrupts the harness's blind typing (preflight warns);
- the **iCloud TextEdit "Untitled N" backlog cleared** — TextEdit restores those
  autosaved docs on launch and they shadow the front document (preflight reports
  the count; the harness never deletes them);
- the **GLM-5V-Turbo** credentials in `~/.zcode/v2/config.json` (billed calls).

Per-scenario **window isolation** (TextEdit/Finder): before each scenario the
harness runs a hermetic reset that reaps ONLY the documents/windows the suite
itself created this run (tracked by a stamped owned-registry). TextEdit document
identity is read from the **System Events AX tree** (window `AXTitle` +
`AXDocument`), never the app-dictionary `path of d` (which raises on coercion for
a fresh unsaved doc on macOS 26 Tahoe and would fail-close every TextEdit scenario
to `SETUP_ERROR`). The reset's `saving no` close re-verifies each document's full
identity and closes it in the SAME AppleScript pass (no snapshot→close race),
gated on an unambiguous, exact, cleanly-read identity match — it prefers leaving a
harness Untitled doc open over any risk of discarding a user document.

They are skipped/blocked (not failed) when those don't hold. The unit tests in
`tests/test_cua_act_verify.py` + `tests/test_act_verify_teardown.py` pin the
scenario definitions, the verify routing, the AX-token guard, the tri-state
restore, and the try/finally contract **hermetically** (no GUI, no network) —
those run in CI on every push. The live matrix is the human/billed acceptance
gate and is run manually (`python3 scripts/cua_act_verify.py --ts-server`)
on an unlocked console.

### Coverage of the 10-category taxonomy

- **1. Text editing** (type/select/format/search/replace): AV03, AV04, AV11, AV15,
  AV18 (italic), AV19 (underline), AV20 (select-all+clear), AV21 (multi-line),
  AV22 (find-replace), AV45 (select-replace) — bold/italic/underline via RTF
  control words `\b`/`\i`/`\ul`; find-replace + select-replace are distinct patterns.
- **2. File management** (create/open/rename/delete/navigate): AV05, AV12, AV13,
  AV23 (rename), AV24 (navigate nested), AV25 (move to Trash), AV26 (duplicate),
  AV27 (new folder) — all verified by the filesystem, all fixtures under `/tmp`.
- **3. Web browser** (navigate/search/tab/bookmark): AV28 (type URL), AV29 (new
  tab), AV30 (click link) — Safari, verified via `URL of front document` +
  `count tabs`; local `file://` fixture pages so runs are offline-deterministic.
- **4. System settings** (toggle/configure/check): AV14 (volume slider), AV16
  (Dock magnification), AV31 (Dock auto-hide), AV32 (filename extensions) — each
  captures the original `defaults` value in setup and restores it in cleanup
  (`killall Dock`/`killall Finder` applies the restore live).
- **5. Clipboard** (copy/paste/cut/cross-app): AV08 (copy), AV17 (cross-app
  paste), AV33 (cut — verifies source emptied AND clipboard has it), AV34
  (partial-select copy — `pbpaste` must equal exactly `BETA`).
- **6. Multi-step workflows** (chain): AV15, AV17, AV35 (edit+save existing
  file), AV36 (terminal redirect to file), AV37 (notes create+body), AV45.
- **7. Drag & drop**: AV13 (Finder file→folder), AV14 (volume slider), AV38
  (window edge resize — `left_click_drag` corner→coordinate, bounds verified).
- **8. Search & navigation**: AV05, AV12, AV24, AV39 (List view), AV40 (Column
  view), AV43 (context menu / Get Info), AV47/AV48 (new window via Cmd+N).
- **9. Calculator/math**: AV01, AV02, AV10, AV41 (memory m+/mr), AV42 (decimal),
  AV50 (chain addition), AV51-AV53 (subtract/multiply element Invoke),
  AV66-AV68 (add/multiply/divide element Invoke) — twelve distinct compute
  patterns, the AV51+ set biased to element-target Invoke.
- **10. Dialogs & notifications**: AV43 (right-click context menu), AV44 (Don't
  Save dialog discard), AV49 (Notes removal confirmation alert).

The AV51-AV80 expansion additionally stresses the **a11y-first element-target
contract**: `set_value` on a single known text area (AV54-AV56, AV69-AV71, AV80
TextEdit — committal; AV57, AV72 Notes body — **deliberately non-committal**;
AV58, AV73 Notes title — **KNOWN_LIMITATION / xfail** (no separate title element),
see [Notes body-write reconciliation](#notes-body-write-reconciliation)), `perform_action`/`left_click` element
selection (AV61, AV74, AV75 Finder), `perform_action` checkbox activation
(AV59-AV60 System Settings), app-launch + element-click (AV62 Preview, AV63/AV77
Dictionary, AV64 Font Book, AV65 Character Viewer), Safari address-bar
navigation (AV76), and Finder View-menu defaults toggles (AV78-AV79).

### Notes body-write reconciliation

Covers **AV37** (`type` body — committal), **AV57 / AV72** (`set_value` body —
non-committal counter-case), **AV58 / AV73** (title — KNOWN_LIMITATION / xfail, no
separate title element), and the cross-app **AV17** paste.

**Confirmed reality.** The Notes note body is a rich-text / web-backed text view. A
direct accessibility value write — `set_value`, or the default `type` on an element
target (both take the a11y-first value-set path) — is *accepted and echoed back by
accessibility* but is **NOT committed to the note document model**. The independent
verify reads the note through the Notes AppleScript dictionary (the model layer), so it
correctly sees no marker. This is Notes-specific: the same `set_value` on TextEdit's
`NSTextView` (AV54-AV56, AV69-AV71, AV80) **does** commit and persist. Confirmed on the
80-scenario macOS run (AV37 default `type`, AV57 / AV72 `set_value` all read
`marker=False`) and by a live backend probe (`element_set_value` updates only the AX
shadow; `element_focus` + real keystrokes append at the caret and go through the app's
normal text-insertion path). The tool now surfaces this via
`keyboard_hints._non_committal_rich_text_warning`: `type`/`set_value` append a WARNING
on this path steering the model to real key input.

**Reconciled expectation (so this stops reading as a product regression):**

- **AV37 — committal path only.** Success (note body persists `AV37_BODY_MARKER`)
  requires **real key input**: bring Notes frontmost and `type` with `strategy=event`
  (or app-scoped keystrokes) into the focused body. A default element value-set is
  expected to NOT persist and must not be scored as the success path. This keeps AV37 a
  meaningful "enter text into Notes that actually sticks" test, aligned with the shipped
  hint.
- **AV57 / AV72 — known non-committal (`set_value`).** `set_value` on the Notes body is
  the deliberate **non-committal counter-case** to the TextEdit `set_value` scenarios:
  the tool correctly ACKs (`Value set`) and now WARNS, and the note model is expected to
  NOT receive the write. Treat a non-persist here as **expected behavior, not a
  `backend_fail`** — the committal alternative is AV37-style real key input.
- **AV58 / AV73 — KNOWN_LIMITATION / xfail (no title field), classified STATICALLY.**
  Notes exposes no separate title element; the "title" is the first line of the single
  body text area, so a "set the title field" act has **no settable target at all**. This
  is a **structural fact about the app's a11y tree, not a per-run observation**, so these
  sids are classified `KNOWN_LIMITATION` at the **top of `run_one`, BEFORE any setup /
  env-probe / model drive** — **no paid model call is made**, and there is structurally no
  model-drive result that a `429` / timeout / credential error could be masked into (the
  drive path is never entered). They are excluded from the valid PASS-rate denominator and
  are deliberately **not** routed through the body-write `score_notes_noncommittal_setvalue`
  (whose warning check is meaningless for a title). A documented app-AX limitation, neither
  a PASS nor a product `backend_fail`, and it can never become a false PASS.
- **AV17** (cross-app paste into a new note) shares the same committal requirement:
  paste (a real key event) into the *focused* body persists; a value-set would not.

**Harness scoring (reconciled — `scripts/cua_act_verify.py`).** The harness now agrees
with this spec:

- **AV57 / AV72 (body `set_value`)** are scored from the model transcript by
  `score_notes_noncommittal_setvalue` (dispatched in `run_one`, which has the transcript),
  NOT by a persistence read: PASS = the tool exercised the value-set AND surfaced the
  non-committal warning (`may NOT commit it to the document`); a missing marker is EXPECTED
  and is not a `FAIL_VERIFY`. `verify_scenario` has NO persistence branch for these sids
  (removed), so it can never re-introduce the contradiction. The set is pinned by
  `NOTES_NONCOMMITTAL_SET_VALUE = {"AV57", "AV72"}`.
- **AV58 / AV73 (title) are a separate KNOWN_LIMITATION / xfail bucket, classified
  STATICALLY** — `KNOWN_LIMITATION_SIDS = {"AV58", "AV73"}`. Notes exposes **no separate
  title element** (the title is just the first line of the single body text area), so a
  "set the title field" act has no settable target at all — a structural fact, not a
  per-run observation. `run_one` short-circuits these sids to `status = "KNOWN_LIMITATION"`
  (`verify_passed = False`, fixed evidence string) at its **very top, before setup /
  env-probe / `drive_model`**, so **no paid model call is made** and no infra/drive outcome
  can be swallowed into a known-limitation. They are **NOT** routed through
  `score_notes_noncommittal_setvalue` (that body-write warning check is meaningless for a
  title field) and **NOT** through a persistence read.
  KNOWN_LIMITATION is excluded from the valid PASS-rate denominator (like
  `env_offspace` / `BLOCKED_INFRA`): it is neither a PASS nor a product `backend_fail`,
  and it can never become a false PASS.
- **AV37** task steers to the committal **real key input** path (`type` with app_ref
  keystrokes into the focused new note, or `type` `strategy=event` on the body element);
  its verify still requires persistence (`AV37_MARKER` in the note body) because real key
  input DOES commit. Unit coverage: `tests/test_cua_act_verify.py`
  (`test_score_notes_noncommittal_*`, `test_run_one_scores_av57_pass_from_transcript`,
  `test_run_one_scores_av58_av73_known_limitation_without_any_model_call`,
  `test_known_limitation_sids_not_in_noncommittal_set`,
  `test_verify_scenario_does_not_read_persistence_for_notes_setvalue`).

### AV13-AV17 design notes (drag + multi-step)

These five expand the suite from click/type/set_value into the two paths the
prior matrix did not cover: the **`left_click_drag`** gesture (the P0
mouse-orphan fix !171 — a raw pointer gesture that must hit the foreground app
with verify→use TOCTOU closure on both endpoints) and **multi-step CUA** where a
single scenario chains several act tools.

- **AV13 (Finder drag)** — the canonical drag test: a file `moveme.txt` is dragged
  onto a folder `DestFolder`. The verify is a **pure filesystem check**
  (`DestFolder/moveme.txt` exists AND the source is gone) — independent of Finder's
  AX tree and of the model's claim. Reversible: the whole fixture lives under
  `/tmp/av13-drag/` and is `rmtree`d in cleanup.
- **AV14 (volume slider drag)** — exercises a slider drag in System Settings. The
  independent verify is `get output volume of (get volume settings)`, a channel the
  model cannot bluff. Setup baselines the volume to 10 so a mid drag is an
  unambiguous change (target window 30..70); cleanup restores the captured original.
- **AV15 (type + bold)** — a multi-step `type` → Cmd+A → Cmd+B chain. The verify
  saves `document 1` to `/tmp/av15-bold.rtf` and inspects the **RTF source** for the
  literal `\b` bold control word — a deterministic, model-independent signal that
  bold was actually applied. Setup forces a rich-text document (toggles plain→rich
  via Shift+Cmd+T only when needed) so Cmd+B can take effect.
- **AV16 (Dock magnification toggle)** — a System Settings navigation + switch
  toggle. The verify reads `defaults com.apple.dock magnification` and confirms it
  **flipped** from the value captured in setup. This is the reversible toggle
  pattern: setup records the original, cleanup writes it back via
  `defaults write` + `killall Dock`. (The earlier "intentionally not included"
  stance is superseded for this toggle specifically because the capture→restore
  makes it reversible; a destructive/irreversible toggle is still out of scope.)
- **AV17 (cross-app clipboard)** — copy from TextEdit, `open_application` Notes,
  new note, paste. The verify joins Notes titles + bodies and looks for the marker
  (`read_notes_titles` + `read_notes_bodies`, both via AppleScript). Cleanup deletes
  the note (same pattern as AV06).

`left_click_drag` was added to `ACT_TOOLS` so the drag scenarios' tool-call
trajectories register as "model acted" (otherwise a pure drag run would be
misclassified as `FAIL_NO_ACT`).

## Why the verify is deterministic

Each verifier reads the post-state through a channel the model cannot influence by
claiming success:

- **AppleScript** reads the app's own data model (`text of document 1`,
  `selection`, `name of every note`, terminal `contents`). The model never sees
  these calls; they run from the harness.
- **`pbpaste`** reads the pasteboard directly.
- **Calculator display** has no AppleScript dictionary, so it is read via System
  Events UI elements (the same AX the model would read, but from the harness).
- A `wait_for` poll (≤8s) absorbs the small async delay between the model's last
  action and the app committing the state.

`PASS` requires BOTH `model_acted` (the model actually fired an act tool — parsed
from the `[tool→]` lines in `e2e_opus`'s redacted stdout) AND `verify_passed`. This
rules out the two failure modes that an observe-only loop can't detect: the model
claiming success without acting, and the model acting on the wrong target.

## Recorded artifacts (per scenario)

```
artifacts/act-verify/
├── preflight.json            # environment gate evidence
├── summary.json              # pass/blocked tally + all records
└── <SCENARIO>/
    ├── result.json           # status, tool_calls[], verify_evidence, paths
    ├── e2e_opus.stdout       # redacted model log (tool I/O previews)
    ├── e2e_opus.stderr
    └── ledger/
        ├── manifest.json     # recording ledger (!179) schema + session key
        └── frames.jsonl      # every tool call: redacted input + result + duration
                              # + the backend method that crossed the OS boundary
```

The ledger `frames.jsonl` is the operation-path substrate: `kind=tool_call` (Hook A,
every tool), `kind=mutation` (Hook B via ActionExecutor, every actuation), and
`kind=backend_call` (the exact OS method). All three share one monotonic `seq`, so a
consumer can replay the full causal trajectory of a PASS or a FAIL_VERIFY.

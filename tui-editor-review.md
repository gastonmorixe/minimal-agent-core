# Code Review — TUI + Editor subsystem

Read-only review. Git tree is clean (`git diff` empty at `9ae0d52`), so this is a
full review of the current subsystem, not of a pending change.

## Files reviewed (line counts)

| Lines | File |
|------:|------|
| 809 | src/ui/compositor.ts |
| 19 | src/ui/overlay.ts |
| 179 | src/ui/picker.ts |
| 274 | src/ui/choice-modal.ts |
| 43 | src/ui/quit-modal.ts |
| 20 | src/ui/scrollback-guard.ts |
| 162 | src/ui/stdio-interceptor.ts |
| 140 | src/ui/term-caps.ts |
| 27 | src/ui/theme.ts |
| 1455 | src/editor-controller.ts |
| 444 | src/editor-renderer.ts |
| 318 | src/editor-buffer.ts |
| 883 | src/editor/key-dispatch.ts |
| 135 | src/input/key-codec.ts |
| 365 | src/input/line-buffer.ts |
| 1014 | src/input.ts |
| 224 | src/input-capture-stack.ts |
| 126 | src/ansi-stream.ts |
| 63 | src/streaming-formatter.ts |
| 11 | src/spinner.ts (re-export shim only) |

Also read for context: `src/term-width.ts` -> `plugin-api/src/utils/term-width.ts`
(the shared width model). `tsconfig` has `"strict": true` but **not**
`noUncheckedIndexedAccess`.

---

## CRITICAL

None found. The load-bearing redraw paths (compositor erase/draw, cols-drift
recovery, escape-safe stream buffering) are unusually well reasoned and
defended.

---

## HIGH

### H1. Cursor left hidden after a signal/exit — terminal left in a bad state
`src/ui/compositor.ts:162`, `src/editor-controller.ts:687-709` (and `:656-680`)

`Compositor.mount()` hides the cursor (`\x1b[?25l`). The only place that
restores it (`\x1b[?25h`) is `Compositor.unmount()`. But the process-level
signal/exit hooks call `EditorController.emergencyRestore()`
(`editor-controller.ts:90-105` -> `687-709`), which restores raw mode and the
key-protocol toggles but **never emits `\x1b[?25h`** and never calls
`compositor.unmount()`. On SIGINT (that bypasses raw mode), SIGTERM, or SIGHUP,
the process exits with the cursor still hidden. `stop()` (`:656-680`) has the
same gap — it relies on the host separately calling `compositor.unmount()`.
**Fix:** in both `emergencyRestore()` and `stop()`, write `\x1b[?25h` (and ideally
move the cursor below the live area) so cursor visibility is owned on every
teardown path, not just the clean compositor-unmount path.

### H2. 20 ms bare-Esc window misfires arrow keys over latency -> spurious turn abort
`src/editor-controller.ts:283`, `src/editor/key-dispatch.ts:255-263`, `:154-200`

`bareEscapeMs` defaults to **20 ms**. When stdin delivers `\x1b` and the CSI tail
(`[A`, `[B`, ...) more than 20 ms later (laggy SSH, busy event loop, `script(1)`
PTY), the disambiguation timer fires `fireBareEscape()`, which feeds the FSM an
`esc` -> mid-turn (`working`) that **aborts the running turn**, and the trailing
`[A` is then mis-parsed as a separate key. So a single arrow press on a slow link
can kill the user's turn. `RawInput` avoids this by waiting indefinitely for more
bytes (`input.ts:542-543`), trading "can't detect a true bare Esc" for "never
misfires." **Fix:** raise the default to ~50 ms, and/or only arm the timer when a
turn is in flight (a bare Esc is a no-op when idle anyway), so the dangerous
misfire window only exists when it can do something.

---

## MEDIUM

### M1. `EditorController.start()` calls `setRawMode(true)` with no `isTTY` guard
`src/editor-controller.ts:641-643`

`RawInput.enable()` guards with `if (!this.stdin.isTTY) return` (`input.ts:187`),
but `EditorController.start()` calls `this.stdin.setRawMode(true)`
unconditionally. On a non-TTY stdin (pipe, redirected input in production) Node
throws on `setRawMode`, crashing start. **Fix:** mirror `RawInput`: bail (or
fall back) when `!this.stdin.isTTY`.

### M2. `findEscapeSafeSplit` treats DCS/APC/PM/SOS as complete 2-byte sequences
`src/ansi-stream.ts:120-122`

The escape-safe splitter handles CSI (`ESC [`) and OSC (`ESC ]`), then falls
through to "any other `ESC X` is always 2 bytes ... complete." But `ESC P` (DCS),
`ESC _` (APC), `ESC ^` (PM), and `ESC X` (SOS) are **string sequences terminated
by ST (`ESC \`)**, not 2-byte. If a producer splits mid-DCS (tmux passthrough
`ESC P tmux;...`, sixel/kitty graphics, a terminal query reply), the splitter
returns `text.length`, the compositor appends its own `\x1b[?25l...` bytes, and
the two glue into one corrupt sequence — exactly the failure this module exists
to prevent. **Fix:** treat `next in {P, _, ^, X}` (0x50/0x5f/0x5e/0x58) like OSC:
scan for BEL/ST, hold back when unterminated.

### M3. `StdioInterceptor` discards write backpressure
`src/ui/stdio-interceptor.ts:143-153`

`makeWrapper` always returns `true` and fires the write callback synchronously,
regardless of what the underlying stream's `write` returns. Callers that respect
backpressure (`write() === false` -> await `drain`) never see it, so a slow
terminal cannot throttle a fast producer; streamed output buffers without bound
inside the compositor/AnsiStreamBuffer chain. **Fix:** forward the real return
value from the original `write`, and only invoke the supplied callback when the
underlying write completes.

### M4. `StreamingFormatter` corrupts markdown that straddles a delta, inconsistent SGR reset
`src/streaming-formatter.ts:13-50`

In prose state with no fence, the whole buffer is emitted and cleared
(`:18-21`), so a `**bold**` or `` `code` `` span split across two `feed()` calls
emits the raw `**`/backticks literally (the marker pair never matches within one
chunk). Separately, inline code uses `\x1b[33m$1\x1b[0m` (`:44`) — a **full
reset** — while bold uses `\x1b[22m` (`:43`); the `\x1b[0m` will terminate any
ambient SGR, not just the code color. **Fix:** hold back a trailing partial
inline-marker run across feeds (like the fence logic already does for `` ``` ``),
and replace `\x1b[0m` with `\x1b[39m` (reset fg only). Note there is no test for
this module (see Coverage).

### M5. `editor-controller.ts` (1455 lines): low cohesion, ~10 responsibilities
`src/editor-controller.ts` (whole file)

The controller owns: buffer, key-dispatch host wiring, abort/quit FSM effect
application + armed-footer timers, input-event debounce, `editor.buffer.changed`
hook, a footer **layer stack**, overlay ownership, viewport/window math, scroll
indicator rendering, paste/clipboard interceptors, and mode/queue wiring. Two
self-contained units are begging to be extracted:
- **`FooterLayerStack`** (`:1077-1178`: `footerLayers`, `setFooterLayer`,
  `clearFooterLayer`, `composeFooter`, `applyFooterChange`) is a pure
  priority-compositing data structure with its own dedup cache.
- **Viewport/window planner** (`:1294-1453`: `computeWindow`,
  `measureWindowPhysicalRows`, indicator reservation) is pure given
  `(buf, cols, budget)`.
Extracting both drops the file well under budget and makes each unit testable in
isolation.

### M6. Key->action mapping is duplicated 3x within the dispatcher and again in `RawInput`
`src/editor/key-dispatch.ts:386-503` (bare bytes), `:577-615` (CSI), `:800-833`
(CSI-u/xterm); mirrored wholesale in `src/input.ts:574-627`, `:717-804`

The same logical actions (word-left, kill-to-EOL, delete-forward, ...) are wired
independently for bare control bytes, legacy CSI, and the kitty/xterm modified
encodings, across three methods — and then a **second full copy** lives in
`RawInput`. The comment says it was "extracted verbatim," but the two have
already diverged (the editor has queue-nav, mode-interrupt, capture-stack ESC
routing, blank-line capping; `RawInput` does not; the abort-quit CSI routing was
a documented divergence/bug). This is the classic table-driven/Strategy
opportunity: one keymap (canonical key-name -> action) consumed by both readers,
plus a thin per-encoding decoder. It would have prevented the abort-routing drift
outright.

### M7. `RawInput` ambient Ctrl+C escalates to `SIGINT` -> process exit (mid-stream kill)
`src/input.ts:235-240`

In ambient mode (used while a turn streams in the legacy path), Ctrl+C does
`process.kill(process.pid, "SIGINT")`. With the installed SIGINT hook
(`:66-72`) that means restore-and-`process.exit(130)` — the agent **terminates**
instead of aborting the turn, contradicting the `EditorController` abort-quit UX
(in-band `\x03` -> FSM -> abort, never exit). If any production path still uses
`RawInput` for streaming, mid-turn Ctrl+C is a hard exit. **Fix:** route ambient
Ctrl+C through the same abort bus rather than raising SIGINT.

### M8. `output` typed without `columns`, read via repeated casts
`src/editor-controller.ts:118` decl, casts at `:371`, `:798`, `:1245`, `:280-281`

`output` is `Pick<NodeJS.WriteStream, "write">`, which has no `columns`, yet the
controller reads width with `(this.output as { columns?: number }).columns` in
several hot paths. The cast hides that `output` might genuinely lack `columns`.
**Fix:** declare `output: Pick<NodeJS.WriteStream, "write"> & { columns?: number }`
(exactly what `RawInput` does at `input.ts:102`) and delete the casts.

---

## LOW

### L1. `capBlankLines` docstring contradicts the implementation
`src/ui/compositor.ts:222-232` vs `:274-281`

The method docstring says runs are capped "at most two (= one blank line)" and
"any `\n` past the second consecutive one is dropped," but the code caps at three
(`if (this.consecutiveNewlines < 3)`, = two blank rows) with an inline comment
that says so. The top docstring is stale and will mislead. Align the prose.

### L2. `Picker` truncation/layout uses code-unit `.length`, not display width
`src/ui/picker.ts:156-164`, `:175-179`

`truncate()` and the label/hint padding all use `.length`, so wide CJK, emoji, or
combining-mark labels truncate and pad at the wrong visual column and the columns
misalign. `choice-modal.ts` already does this correctly with `displayWidth`.
**Fix:** use `displayWidth`/`truncateDisplayWidth` from `term-width.ts`.

### L3. `parseCsiUKey`: `Number("") === 0` accepts malformed sequences as code 0
`src/input/key-codec.ts:41-42`

`Number(fields[0]?.split(":")[0] ?? "")` yields `0` for an empty first field, and
`Number.isInteger(0)` is true, so `\x1b[u` parses to `{code: 0}` instead of
`null`. Downstream it's inert (NUL isn't printable / matches no handler), but it's
a latent footgun. **Fix:** reject an empty/absent code field explicitly before
`Number(...)`.

### L4. `scrollback-guard.ts` is dead code and a footgun if resurrected
`src/ui/scrollback-guard.ts` (whole file)

No production importer (only the file itself and `docs/`). It writes directly to
`process.stdout` with `\x1b[s`/`\x1b[u` (save/restore cursor) and `\x1b[nS`
(scroll up) — the absolute-positioning + scroll anti-patterns the `Compositor`
docstring explicitly rejects (`compositor.ts:7-25`), and `\x1b[nS` can drop
scrollback on some terminals. **Fix:** delete it.

### L5. `applyEffects` can silently drop an abort for a just-started turn
`src/editor-controller.ts:452-456`

The `abort-turn` effect only forwards to the bus `if
(this.abortBus.isTurnInFlight())`. If a turn started but isn't yet registered as
in-flight when the keystroke's effect runs, the abort is dropped. Given the
bus is already idempotent, the guard adds a race for no benefit. **Fix:** request
the abort unconditionally and let the idempotent bus no-op.

### L6. `liveAreaKey` JSON-stringifies the whole buffer every repaint
`src/ui/compositor.ts:807`, used at `:370`/`:317`/`:392`

Dedup keys are `JSON.stringify([lines, cursor])`, O(total visible text) per
keystroke. Cheap for a one-line prompt, but a multi-thousand-line paste pays it on
every repaint. **Fix:** hash incrementally, or compare arrays directly with a
length+last-line short-circuit.

### L7. `term-caps` leaves stdin resumed/raw for the caller
`src/ui/term-caps.ts:124-139`

`detectSynchronizedOutput` calls `input.resume()` and `setRawMode(true)` but never
pairs them on the way out (documented as "leave to the caller"). If the next
consumer isn't the editor, stdin is left resumed/raw. Acceptable given current
call ordering, but fragile. Note it as a contract the caller must honor.

---

## NIT

- `src/streaming-formatter.ts:45` — explicit `(_: any, l, u)` in the link
  replacer; type the replacer args (`string`) instead of `any`.
- `src/editor-renderer.ts:432` — `text.codePointAt(i)!` non-null assertion in
  `markHidden`; loop bound makes it safe but the `!` papers over the index model.
- `src/ui/quit-modal.ts:12-16` — `render()` ignores `_width`; the literal
  `"  Quit minimal-agent?"` can overflow/wrap on a very narrow terminal.
- Width model is a documented heuristic (`term-width.ts:9-19`): flag emoji, heavy
  ZWJ sequences, and PUA/Nerd-Font glyphs can drift the cursor by a column. Bounded
  and acknowledged; flagged only so the assumption is visible.

---

## Type safety (noUncheckedIndexedAccess)

`tsconfig` is `strict` but does **not** enable `noUncheckedIndexedAccess`, so
hundreds of `arr[i]` accesses type as non-`undefined` while being runtime-nullable
(`editor-renderer.ts:157` `buf.lines[logical]`, `key-codec.ts` `fields[n]`, etc.).
The code is mostly defensive (explicit `?? ""`, `if (!it) continue`), but enabling
the flag would surface the genuinely unguarded spots. Worth a scoped experiment on
this subsystem.

## Test coverage gaps (risky, untested logic)

- **`src/editor/key-dispatch.ts`** (883 lines, the byte-level state machine): no
  direct unit test. Exercised only indirectly via `editor-controller.test.ts` and
  e2e suites. The bare-Esc timer (H2), CSI-Ctrl+C/Esc lookahead, and CRLF
  coalescing deserve dedicated tests.
- **`src/streaming-formatter.ts`**: no test at all; M4 (cross-delta markdown) is
  exactly the kind of bug a small feed-splitting test would catch.
- `src/ui/compositor.ts` **is** well covered (compositor.test.ts +
  mdstream + cols-fallback). `editor-renderer`, `editor-buffer`, `ansi-stream`,
  `input-capture-stack`, `term-caps`, `stdio-interceptor` all have tests.

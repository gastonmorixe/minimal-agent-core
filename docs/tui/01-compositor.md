---
title: Compositor internals
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
tags: [tui, compositor, ansi, redraw, sigwinch]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: redraw cycle, state machine, separator logic, cols-drift recovery"
---

# Compositor internals

Source: `src/ui/compositor.ts` (787 lines).

The compositor is the only thing that writes the live area. It exposes two write surfaces and one query surface:

```ts
class Compositor {
  // write surfaces
  writeStream(chunk: string): void
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void

  // also: flushStream, mount, unmount, withSuspendedLiveArea, notifyResize

  // query
  get liveHeight(): number
}
```

Everything else (`eraseLiveSeq`, `drawLiveSeq`, `capBlankLines`, `maybeRecoverFromColsDrift`, etc.) is private.

## The atomic frame

Both `writeStream` (via `writeBufferedStream`) and `setLiveArea` emit ONE atomic frame wrapped in DEC mode 2026 (synchronized output) when the terminal supports it. The frame has six stages:

```
+----------------------------------------------------------------------------+
| 1. BSU  ESC[?2026h                                                         |
|   begin synchronized update (DEC mode 2026)                                |
+----------------------------------------------------------------------------+

+----------------------------------------------------------------------------+
| 2. hide cursor  ESC[?25l                                                   |
+----------------------------------------------------------------------------+

+----------------------------------------------------------------------------+
| 3. eraseLiveSeq()                                                          |
|   walk cursor UP over physical-row count of the live area,                 |
|   \r to col 0, walk back over sepRowsAboveLive, walk right                 |
|   by streamCol to the partial-stream cell, then ESC[J                      |
+----------------------------------------------------------------------------+


+----------------------------------------------------------------------------+
| 4. write chunk verbatim                                                    |
|   terminal scrolls naturally as cursor descends past bottom row;           |
|   those rows enter REAL scrollback (compositor does not own them)          |
+----------------------------------------------------------------------------+


+----------------------------------------------------------------------------+
| 5. drawLiveSeq()                                                           |
|   smart-skip \r\n separator + status + decoration + gap +                  |
|   indicator? + editor lines + footerSpacer + footer;                       |
|   per-row ESC[K; reposition cursor inside editor at (row, col)             |
+----------------------------------------------------------------------------+


+----------------------------------------------------------------------------+
| 6. show cursor  ESC[?25h    +    ESU  ESC[?2026l                           |
|   terminal applies entire frame as one atomic flip                         |
+----------------------------------------------------------------------------+
```

Without synchronized output (older terminals, unknown emulators), `bsu`/`esu` are empty strings and the user sees the frame assembled in steps - still correct, just visibly flickery on slow paints.

## The state the compositor carries

This is what a `--tui-debug=hud` mode will want to dump. Field names match the source.

| field | meaning |
|---|---|
| `mounted` | are we currently driving a TTY? Unmounted = passthrough |
| `tty` | is the output actually a TTY (vs a pipe / test stub) |
| `syncOutput` | did the DECRPM probe report mode 2026 supported |
| `liveHeightValue` | how many physical rows the live area occupies right now |
| `cursorRowInLive` | row 0..liveHeightValue-1 where the cursor sits inside the live area |
| `streamCol` | visual column of the last partial stream line (so `eraseLiveSeq` knows how many cells to walk right on row 0) |
| `streamAnsi` | `AnsiStreamBuffer` holding partial CSI/OSC tail so redraw bytes never split an escape |
| `consecutiveNewlines` | tail `\n` run counter, capped so scrollback never accumulates 3+ blanks |
| `lastLines` / `lastCursor` | the previous frame, used to re-measure during cols-drift |
| `liveSepDrawn` | was the blank separator above the live area already drawn? (avoids drift) |
| `sepRowsAboveLive` | 0, 1, or 2 - how many `\r\n` rows we put between scrollback and live area; `eraseLiveSeq` walks up exactly this far |
| `lastDrawColumns` | cols at the last paint, for cols-drift recovery on SIGWINCH races |
| `drawnLiveKey` | JSON-stringified `[lines, cursor]` from the last draw, for dedup short-circuit |

## `writeStream` path (scrollback writes)

```
writeStream(chunk)
   |
   v
streamAnsi.push(chunk)      <- AnsiStreamBuffer holds back any partial
                                CSI/OSC tail; returns escape-safe prefix
   |
   v
capBlankLines(safe)         <- walk left-to-right; count consecutive \n
                                (ANSI = zero-width, CR = passthrough);
                                drop any \n that would push the run past 3
   |
   v
writeBufferedStream(capped) <- the atomic frame above
```

### `capBlankLines` (the "no triple-blank" rule)

The cap was bumped from `< 2` (1 blank max) to `< 3` (2 blanks max) so turn-end transitions can land 2 blank rows above a freshly-committed prompt. `EditorController.submit` emits 3 leading `\n`s and relies on this cap to absorb whatever the previous content left in the run.

Why this matters: without the cap, every place that emits a trailing `\n` (formatter sink boundaries, model emitting whitespace-only text between tool calls, separators at boundaries) would compound. Three pieces each ending in `\n` would compose to `\n\n\n\n` = 3 visible blank rows.

## `setLiveArea` path (editor / status updates)

```
setLiveArea(lines, cursor)
   |
   v
snapshot prevLines/prevCursor   <- BEFORE overwriting lastLines/lastCursor,
                                   because eraseLiveSeq needs them to
                                   re-measure the still-on-screen live area
                                   under CURRENT cols (which may differ from
                                   lastDrawColumns)
   |
   v
short-circuit on drawnLiveKey == nextKey && !hasColsDrift
   |
   v
maybeRecoverFromColsDrift()    <- if cols changed since last draw, emit
                                   nothing, forget counters (HARD RULE)
   |
   v
BSU + hide cursor +
eraseLiveSeq({includeSepRows: !repaintExisting,
              drawnLines: prevLines, drawnCursor: prevCursor}) +
drawLiveSeq({reuseExistingGap: repaintExisting}) +
ESU
```

The `repaintExistingLiveArea` distinction matters:

- **Pure repaint** (spinner blink, keystroke): the live area is already there. `includeSepRows: false` so we stay on the live area's first row instead of walking up into the separator gap. `reuseExistingGap: true` so we don't draw a *second* separator above the existing one (which would push the prompt down by one row per repaint).
- **After a stream write**: scrollback content was just appended. The prior separator is now buried mid-scrollback. Reset `liveSepDrawn = false` so `drawLiveSeq` decides afresh.

## `eraseLiveSeq` - the load-bearing erase

```ts
// 1. cursor is at editor row (cursorRowInLive). Walk up to top of live area.
//    Use PHYSICAL row count under CURRENT cols, not the stored logical
//    cursorRowInLive - under cols drift smaller than lastDrawColumns,
//    lines whose displayWidth now exceeds cols have wrapped on the
//    terminal side, pushing the cursor's physical row DOWN. Walking up
//    by the logical count would leave the top of the reflowed live area
//    unerased (orphan), which subsequent writeBufferedStream calls scroll
//    into permanent scrollback as duplicated status / editor rows.
walkUpRows = computePhysicalCursorRowInLive(drawnLines, drawnCursor)
emit `ESC[${walkUpRows}A`
emit `\r`

// 2. Stream writes also need to walk back over the separator rows we
//    emitted between scrollback and live area. Pure repaints do NOT
//    (they stay on the live area's first row).
if includeSepRows && sepRowsAboveLive > 0:
    emit `ESC[${sepRowsAboveLive}A`
if includeSepRows && streamCol > 0:
    emit `ESC[${streamCol}C`     // walk right to the partial-line cell

// 3. ESC[J erases from cursor down to viewport bottom. Cells ABOVE the
//    cursor are untouched. SAFE because the walk-up above landed us
//    strictly inside owned territory.
emit `ESC[J`
liveHeightValue = 0
cursorRowInLive = 0
if includeSepRows: sepRowsAboveLive = 0
```

### `computePhysicalCursorRowInLive`

The walk-up math has to mirror `EditorRenderer`'s wrap math (and `wrapRows()` in `term-width.ts`) exactly. Under stable cols the result equals the stored logical `cursor.row`. Under cols drift smaller than `lastDrawColumns`:

- each drawn line above the cursor contributes `ceil(width / cols) - 1` extra physical rows
- within the cursor's own line, `floor(cursor.col / cols)` extra wrap chunks sit above the cursor

Falls back to `cursorRowInLive` (logical count) when the cursor / lines snapshot is unusable (cursor null, `effectiveColumns()` is 0, or drawn lines absent).

## `drawLiveSeq` - separator + body + cursor

```ts
if liveAreaKey is empty: return

if !reuseExistingGap:
  // Land on a fresh line at col 0. If the stream cursor is mid-line,
  // CRLF first.
  if streamCol > 0:
    emit `\r\n`; sepConsumed++

  // Smart-skip the blank separator: exactly one visible blank row between
  // scrollback and live area. Skip when scrollback already ends with a
  // blank row (consecutiveNewlines >= 2). The CRLF above is just a row
  // terminator, not a blank by itself.
  alreadyBlank = (streamCol == 0 && consecutiveNewlines >= 2)
  if !liveSepDrawn && !alreadyBlank:
    emit `\r\n`; sepConsumed++

sepRowsAboveLive = sepConsumed

// Per-row: line + ESC[K (clear any wider previous content) + \r\n
for line in lines:
  emit line + ESC[K
  if not last: emit \r\n

// Cursor: walk back up from end-of-last-line to (cursor.row, cursor.col)
rowsUp = lastIdx - cursor.row
if rowsUp > 0: emit `ESC[${rowsUp}A`
emit `\r`
if cursor.col > 0: emit `ESC[${cursor.col}C`
emit `ESC[?25h`  (show cursor)
liveHeightValue = lines.length
cursorRowInLive = cursor.row
```

## SIGWINCH and silent cols drift

`notifyResize()` is wired to `process.stdout.on("resize")`. Its policy is brutal but earned:

**HARD RULE: emit nothing on resize. Do not reset counters.**

Reasoning: the terminal already reflowed our cells in place. Counters are slightly stale (live area may now occupy ±1 physical row vs logical tracking) but they're still our best estimate. The next `setLiveArea` will run its normal `eraseLiveSeq` walk-up + `drawLiveSeq` per-row `ESC[K` overwrite, covering the old live area in place.

Why nothing else works (regression history is in the source comment):

| What we tried | Why it broke |
|---|---|
| `ESC[H ESC[J` (full viewport wipe) | iTerm drops `ESC[J`-erased cells from history. ~20 rows of neofetch+banner gone per resize. User-reported May 2026 session b50c7354. |
| `ESC[<rows>B + \n × rows` | duplicated the live area into history on every resize |
| `\n × (rows - liveHeight)` | assumed live area is sticky-to-bottom of viewport. It isn't. |
| reset counters | walk-up math drops, `drawLiveSeq` starts at current cursor → first byte of new "status" overstrikes old `❯` → "❯ ❯" cursor duplication |

**Trade-off, honestly stated (corrected May 2026):** on a *narrowing* resize the terminal reflows the pre-wrapped full-width live-area lines, growing their physical height. If the live area sat near the viewport floor, its TOP rows scroll ABOVE the viewport into permanent scrollback *at reflow time*, before this handler runs. The next paint's relative `ESC[J` can't reach above the viewport top, so those rows remain as a frozen copy. This is inherent to inline (non-alt-screen) redraw and is NOT scrollback loss. The earlier claim here ("bounded 1 row, never accumulates") was wrong on both counts: the residue can be several rows, and a window-edge *drag* (one SIGWINCH per column) used to leave one residue per column = dozens stacked. The accumulation is now killed upstream by coalescing resize repaints in `EditorController.notifyResize` (`resizeDebounceMs`, default 150ms — see chapter 03), so a whole drag yields at most one residue. A single deliberate resize may still strand one transient row.

`maybeRecoverFromColsDrift()` runs the same policy at paint time. Triggered when `effectiveColumns() !== lastDrawColumns`. Same regression history applies.

## `effectiveColumns()` and `script(1)`

```ts
private effectiveColumns(): number {
  const c = this.output.columns ?? 0
  if (c > 0) return c
  const env = Number.parseInt(process.env.COLUMNS ?? "", 10)
  return Number.isFinite(env) && env > 0 ? env : 0
}
```

macOS BSD `script(1)` allocates a slave PTY but never propagates the parent's window size, so `process.stdout.columns` is 0. With `columns ≤ 0`, `updateStreamCol` skips the wrap-modulo and returns the raw cell count; `eraseLiveSeq` then emits `ESC[1A ESC[<raw>C ESC[J`, which on a real (narrower) terminal clamps to the right edge and lands the cursor on the wrong physical row.

Fix: fall back to `$COLUMNS`. Users recording with `script` opt in via:

```bash
COLUMNS=120 script -r out.log -- bun run minimal-agent
```

`mdstream` does the same fallback in `renderer.rs`, so the two layers agree.

## `withSuspendedLiveArea(fn)`

Used by code paths that need raw control of the tty for one operation (overlays, modal pickers, etc.):

1. Erase the live area, show the cursor.
2. Run `fn()`. Caller owns the tty.
3. Assume the callback left a clean line (`streamCol = 0`), hide cursor again, redraw live area.

The compositor doesn't know what the callback wrote. The `streamCol = 0` assumption is load-bearing - if the callback leaves content mid-line, the next stream write will get the column wrong.

## Pass-through mode

When `output.isTTY` is false (pipes, test stubs, redirected stdout), the compositor is a pass-through:

- `writeStream` writes verbatim
- `setLiveArea` updates `lastLines`/`lastCursor` (so tests can inspect) but emits nothing
- `mount`/`unmount` are essentially no-ops on the wire

This lets the same code path drive interactive REPLs and one-shot piped invocations (`echo "hi" | bun run src/index.ts -`).

# Fix: resizing the terminal leaked stacked live-area copies into scrollback

> 2026-05-31. Dragging the terminal window edge (especially narrower) stacked
> dozens-to-hundreds of duplicate live areas (`❯ ──── ^ N more lines` + editor
> rows + wrapped paragraphs) into permanent scrollback. Root-caused by driving
> the real compositor/editor on a live iTerm2 PTY and measuring the terminal's
> reflow with a DSR cursor probe; fixed by coalescing resize-driven repaints.

## Symptom

A drag-resize of a session with a tall multiline prompt (long wrapping
paragraphs) left the scrollback full of frozen copies of the input area, the
scroll indicator's counter ticking down through each stranded copy. The live
prompt at the bottom was correct; the scrollback above it was littered.

## Root cause (measured, not guessed)

The live area is drawn as **pre-wrapped, full-width lines** using relative
cursor moves (`ESC[nA` walk-up + `ESC[J` erase), never the alternate screen, so
users can scroll up to re-read. That redraw model has a hard edge on resize:

1. On a **narrowing** resize the terminal reflows the already-drawn full-width
   lines. Each line wider than the new width wraps again, so the live area's
   **physical height grows** (measured: 11 logical rows → 21 physical rows when
   100→50 cols).
2. The terminal anchors the cursor on its logical cell and scrolls the content
   **above** it to keep it visible. Rows that cross above the viewport top enter
   the scrollback buffer — at reflow time, **before** SIGWINCH is delivered.
3. The next repaint's `eraseLiveSeq` walks the cursor up and issues `ESC[J`,
   which only clears from the cursor to the viewport bottom. It **cannot reach
   rows that already scrolled above the viewport top**, so they remain as a
   frozen duplicate.
4. A window-edge **drag** fires one SIGWINCH per intermediate column. The old
   code repainted on every one, so each column left its own residue → unbounded
   accumulation.

Confirmed with a DSR (`ESC[6n`) probe: after a 100→62 narrow the cursor stayed
in-viewport (row 24, no leak); after a 62→50 narrow it landed at row 11 with 16
rows of content above it → top at row -5, i.e. 5 rows scrolled off and stranded.

This matches the documented behavior of every inline (non-alt-screen) line
editor (fish `screen.cpp`, zsh `zle_refresh.c`, GNU readline, prompt_toolkit):
`ESC[J` can't erase above the viewport and DEC 2026 synchronized-output doesn't
prevent the reflow scroll. The only full avoidance is the alternate screen,
which would break the scroll-up-to-re-read UX. The previous code comment claimed
the residue was "bounded 1 row, never accumulates" — the measurement disproved
both halves (it can be several rows, and a drag accumulates one batch per
column).

## The fix: coalesce resize repaints

`EditorController.notifyResize()` now **debounces**. Instead of repainting
synchronously on every SIGWINCH, it arms a trailing timer and repaints **once**,
`resizeDebounceMs` after the last resize. A continuous drag collapses to a single
repaint at the final geometry, so the whole drag produces at most one reflow
residue instead of one per column.

- New `EditorControllerOptions.resizeDebounceMs`, default **150ms**. Measured on
  a 120→48 drag: **25** leaked copies at 0ms, **10** at 80ms, **0** at ≥150ms.
  150ms is below the ~200ms "feels instant" threshold, so a single deliberate
  resize is still snappy.
- `resizeDebounceMs: 0` keeps the legacy synchronous repaint-per-resize (used by
  the unit tests that assert immediate reflow).
- The pending timer is cleared in `stop()` and `emergencyRestore()` so no
  repaint can fire after teardown.

The compositor's `notifyResize` HARD RULE (emit nothing on SIGWINCH) is
unchanged; its stale "bounded 1 row" comment is replaced with an honest account
of the reflow-scroll-off limit and a pointer to the coalescing fix.

### What is and isn't fully fixed

- **Drag-resize accumulation** (the reported bug, hundreds of copies): fixed,
  0 leak.
- **Separate deliberate resizes** of a viewport-tall prompt may still strand one
  transient row each. That is the inherent inline-redraw limit (same as
  fish/zsh); it is bounded per-resize and is not scrollback loss.

## Tests

- `editor-controller.test.ts`: the `make` / `makeScrolled` helpers now default to
  `resizeDebounceMs: 0`, keeping the existing immediate-reflow assertions valid.
- Three new tests: a 12-step resize burst coalesces to exactly one repaint at the
  final width; `resizeDebounceMs: 0` stays synchronous; a pending coalesced
  repaint does not fire after `stop()`.
- Full gate green: typecheck, oxlint, biome, 4411 tests / 0 fail.

## Reproduction / verification harness

`private/work/rendering-fixes/` (not shipped): a standalone harness that boots
the real `Compositor` + `EditorController` on a real iTerm2 PTY, plus iTerm2
Python drivers that resize/drag/type and count leaked indicator copies in
scrollback, and a DSR reflow probe. `drag_drive.py` is the regression check:
0 leaked copies on the shipped default.

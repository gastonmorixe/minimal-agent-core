---
title: Live-area layout
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
tags: [tui, layout, status-row, footer-layers, indicator]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: row-by-row layout, cursor math, footer-layer priorities"
---

# Live-area layout

The compositor takes an array of strings. The shape of that array is decided by `EditorController.repaint()` around line 2040 of `src/editor-controller.ts`. This chapter documents the layout.

## Top-to-bottom

```
LIVE AREA INTERNAL LAYOUT  (built by EditorController.repaint)
--------------------------------------------------------------------------------------------

  segment              span         contributor
--------------------------------------------------------------------------------------------
  statusLine            0 or 1 row      setStatus(); cleared = blank row if reserved
  decorationLines       0..N rows       setDecoration(); queue display, etc.
  gap   ['', '']        0 or 2 rows     blank gap, only when status is FILLED
  indicatorLine?        0 or 1 row      '^ N more lines' when buffer scrolled
  editor lines          1..N rows       EditorRenderer.render(buf) with wrap
  footerSpacer ''       0 or 1 row      only when footer is present
  composedFooter        0..N rows       highest-priority non-empty layer wins
--------------------------------------------------------------------------------------------

cursor offset = (statusRows + decorationRows) + statusGapRows
                + indicatorOffset  + editorRowInWindow

FooterLayer priorities:
  DEFAULT  =   0   (quota / diagnostic ambient line)
  OVERLAY  =  50   (slash menu, plugin overlays)
  ARMED    = 100   (armed-quit confirm modal)
```

## Each segment in detail

### Status row

```ts
controller.setStatus(text: string | null): void
```

- `null` = clear.
- Non-null with non-empty content = show.
- Once a status has ever been set in a session, the row stays *reserved* (rendered as blank when cleared) so clearing the status doesn't move the prompt up by a row. `statusRowReserved` is the latch.
- Truncated to `cols` so a too-long status never wraps and bumps the editor.

Typical content: spinner glyph + state label + elapsed seconds + token count.

### Decoration rows

```ts
controller.setDecoration(lines: string[]): void
```

A small N-line band between status and editor. Used by features that want a persistent display above the prompt without claiming the status row (queue overview, etc.).

### Gap

Two blank rows between status/decoration and editor when status is *filled*. The reason is purely cosmetic - keeps the busy state readable without butting against the prompt's `❯ `. When status is reserved-but-blank (after a clear), the gap is collapsed to zero rows.

### Scroll indicator

When the editor buffer is taller than the editor's share of `maxLiveHeight`, `EditorController.repaint` runs a viewport algorithm:

1. Compute a window `[vTop, windowEnd)` of logical lines that fits the budget.
2. If `vTop > 0` and budget ≥ 2, *reserve one row* for an indicator above content rows. The cursor will never land on the indicator.
3. With budget = 1, fall back to "indicator REPLACES the single editor row" (degraded but never wraps).

The indicator carries the active mode's prompt prefix and a label:

```
❯ ──────────────────────────────────────── ^ 12 more lines
```

Three forms, picked by width (preferring mode visibility):

| Condition | Form |
|---|---|
| `w >= promptW + labelW + 3` | `❯ <dashes> ^ N more lines` (full) |
| `w >= promptW + labelW` | `❯^ N more lines` (no dash room) |
| else | ` ^ N more lines` (bare; prompt doesn't fit) |

This is also the *only* place the user can read off the active mode while the buffer is scrolled. Visible content rows below the indicator render with the continuation prompt (`  `), which carries no mode info.

### Editor lines

`EditorRenderer.render(buf, {firstRow: vTop, rowCount: editorWindow, columns: cols})` returns `{lines, cursor}`. Long logical lines are pre-wrapped into chunks ≤ `cols` wide, and the cursor is in PHYSICAL (post-wrap) coordinates.

When `columns` is omitted (non-TTY tests, edge cases), one physical row per logical line is emitted and the cursor column is the raw `prompt + buf.col` - legacy MVP behavior; relies on terminal-side wrap and breaks cursor placement for wrapped lines.

### Footer spacer + composed footer

Footer is a **priority-stacked layer system**. Three canonical layer ids ship in the source:

```ts
FOOTER_LAYER_DEFAULT  = "default"     // priority 0
FOOTER_LAYER_OVERLAY  = "overlay"     // priority 50
FOOTER_LAYER_ARMED    = "armed-quit"  // priority 100
```

Producers register lines with:

```ts
controller.setFooterLayer(id, lines, { priority })
controller.clearFooterLayer(id)
```

`composeFooter()` picks the **highest-priority non-empty layer** and returns its full `lines` array. Multi-line layers compose correctly.

Why this exists (Bug 2801 from source comment): two producers both writing through a `setFooterLines` getter/setter stomped each other on every refresh. The layer system gives each producer a stable id and lets the renderer pick a winner without producers having to coordinate.

Examples of producers:

| Producer | Layer | Why |
|---|---|---|
| Quota meter | `FOOTER_LAYER_DEFAULT` (0) | ambient, always-on |
| Slash menu, plugin overlays | `FOOTER_LAYER_OVERLAY` (50) | obscures quota while open |
| Armed-quit confirm modal | `FOOTER_LAYER_ARMED` (100) | critical, obscures even the overlay |

The 1-row `footerSpacer` is a blank inserted between editor and footer when both are present, so the quota row doesn't visually butt against the prompt.

## Cursor math

Given the layout above, the final cursor row inside the live area is:

```ts
finalCursor.row =
    statusRows               // = (statusReserved ? 1 : 0) + decorationRows
  + statusGapRows            // = statusReserved ? 1 : 0
  + indicatorOffset          // = actualNeedSeparate ? 1 : 0
  + editorCursorRowInWindow  // from EditorRenderer.render, 0-based
```

`finalCursor.col` is just the editor's reported col (prompt width is already baked into the rendered line widths).

## Height budget and viewport scrolling

```ts
maxLiveHeight = () => Math.max(2, Math.floor((process.stdout.rows ?? 24) / 2))
```

The live area is capped at half the viewport (min 2 rows). With a 50-row terminal, the live area can grow to 25 rows.

`repaint()` divides that budget:

```ts
const cap = Math.max(1, this.maxLiveHeight())
const editorBudget = Math.max(1, cap - statusRows - statusGapRows - footerRows)
```

Then runs a two-pass window computation:

- Pass 1: try to fit `[vTop..windowEnd]` around the cursor in `editorBudget` physical rows.
- Pass 2: if `vTop > 0` and budget ≥ 2, reserve a row for the indicator and recompute with `editorBudget - 1`.

When the buffer is shorter than budget, `vTop = 0` and no indicator is needed.

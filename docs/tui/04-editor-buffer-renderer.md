---
title: Editor buffer and renderer
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
session_id: 4aa1cfdf-7a42-47ce-8b99-c7612a39e167
host_info:
  hostname: macbookpro.home.arpa
  user: gaston
  os: "macOS 26.5 (25F71)"
  kernel: "25.5.0"
  arch: arm64
  serial: FHQ93DD9T6
tags: [tui, editor-buffer, editor-renderer, wrap, term-width]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: buffer model, renderer wrap math, term-width primitives"
---

# Editor buffer and renderer

Two pure modules underneath `EditorController`:

| File | LOC | Role |
|---|---:|---|
| `src/editor-buffer.ts` | 312 | the model |
| `src/editor-renderer.ts` | 438 | the view |
| `src/term-width.ts` | 241 | wrap math primitives (shared with compositor) |

## `EditorBuffer`

A pure multiline text model with one cursor. No terminal, no rendering. Used by both the persistent `EditorController` and the legacy `RawInput` (whose lifecycle is mount-per-read).

```ts
class EditorBuffer {
  readonly lines: readonly string[]
  row: number      // clamped to [0, lines.length - 1]
  col: number      // clamped to [0, lineLength(row)]

  toString(): string                    // lines.join("\n")
  isBlank(): boolean                    // single empty line only
  clear(): void

  insert(text: string): boolean         // at (row, col), advances col
  newline(): boolean                    // splits current line at col
  deleteBackward(): boolean             // backspace, joins lines at col=0
  deleteForward(): boolean              // delete, joins lines at end-of-line
  deleteWordBackward(): boolean         // alt-backspace
  deleteWordForward(): boolean          // alt-delete

  moveLeft / moveRight / moveUp / moveDown: boolean
  moveLineStart / moveLineEnd
  moveBufferStart / moveBufferEnd
  moveWordLeft / moveWordRight
}
```

All position units are unicode code points (matching `Array.from(line)`), so emoji and multi-code-unit characters count as one column. Display width is a *separate* concern handled by `term-width.ts`.

### `isBlank` semantics

```ts
isBlank(): true ↔ lines.length === 1 && lines[0].length === 0
```

This is *not* "buffer contains only whitespace". A multi-line buffer made of whitespace is real content the user composed and must not be silently wiped by Ctrl+C / Enter heuristics. The matching `RawInput.isBlankBuffer` follows the same rule.

## `EditorRenderer`

A pure transform from `EditorBuffer` state to a list of physical terminal rows + a cursor position, ready for `Compositor.setLiveArea`.

```ts
class EditorRenderer {
  constructor(opts: { prompt, continuationPrompt, showHidden? })

  setShowHidden(v: boolean): void
  setPrompt(prompt: string, continuationPrompt?: string): void

  render(buf: EditorBuffer, opts?: {
    firstRow?: number,        // first LOGICAL line to render
    rowCount?: number,        // how many LOGICAL lines
    columns?: number,         // terminal width - STRONGLY recommended
  }): { lines: string[], cursor: { row: number, col: number } }

  getPrompt(): string
  getPromptDisplayWidth(): number
}
```

### Wrap mode (with `columns`)

When `columns` is provided, long logical lines are pre-wrapped into chunks ≤ `columns` cells wide. The cursor is in **physical** (post-wrap) row/col coordinates inside the rendered output.

A logical line "row 0" with content "long string..." that wraps twice becomes 3 physical rows in the output array. If the cursor was at logical col 150 (well past `columns=80`) of row 0, the rendered cursor is `{row: 1, col: 70}` (or wherever 150 lands after wrapping past the prompt's width).

### Legacy mode (no `columns`)

Without `columns`, one physical row per logical line is emitted and the cursor column is the raw `prompt + buf.col`. This relies on terminal-side wrap and breaks cursor placement for wrapped lines. TTY callers should always pass `columns`. Used only by old tests that pre-date wrap support.

### Show-hidden rendering

When `showHidden: true`:

| char | rendered as | SGR |
|---|---|---|
| space | `·` | dim |
| tab | `→` (right-arrow) | dim |
| line terminator | `↵` | dim |

These glyphs occupy the same cell count as the original character (1 for space and tab; 0 for newline since newlines aren't drawn as rows). Tab width is intentionally NOT expanded - the buffer stores `\t` literally and renders one `→`.

## `term-width.ts`

The single source of truth for cell math. Used by `EditorRenderer`, `Compositor` (`computePhysicalCursorRowInLive`), `agent.ts` (status truncation), and the formatter.

```ts
displayWidth(s: string): number                      // total cells
codePointWidth(cp: number): 0 | 1 | 2                // per-char
cursorVisualCol(startCol: number, w: number, cols: number): number
cursorRowOffset(startCol: number, w: number, cols: number): number
wrapRows(line: string, cols: number, prompt?: string): string[]
truncateDisplayWidth(s: string, max: number): string
```

Rules:

- **ASCII** (0x20..0x7e): 1 cell
- **Combining marks** (0x0300..0x036f, 0xfe20..0xfe2f, 0x20d0..0x20ff, …): 0 cells
- **East-Asian Wide / Fullwidth** (CJK, fullwidth punctuation, hangul syllables, …): 2 cells
- **Emoji blocks** (most of them): 2 cells
- **C0/C1 controls** (everything < 0x20 except `\t` which is 1): 0 cells
- **ANSI escapes** (`\x1b[...]`, `\x1b]...]`): 0 cells (parsed and skipped by `displayWidth`)

Known limitation: full grapheme clustering (flag emoji `🇺🇸`, ZWJ sequences `👨‍👩‍👧`) is NOT implemented. The component code points are width-summed individually, which over-counts for clusters that should render as one cell. Cursor may drift ±1 cell per cluster. Acceptable trade-off - implementing UTS #29 grapheme cluster boundaries was deemed not worth the complexity for the typical agent prompt content.

Why this matters: the compositor's `eraseLiveSeq` walks the cursor back to `streamCol` to reposition at the end of the partial stream line. If `streamCol` underestimates by 1 per wide char, the cursor lands mid-glyph and `ESC[J` erases the wrong region. Keep `term-width.ts` as the only place that decides "how wide is this string".

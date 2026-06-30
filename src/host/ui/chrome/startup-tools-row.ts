/**
 * Format the value column of the startup tree's `tools` row.
 *
 * Background. The startup tree is the small left-rail block printed
 * before the REPL boots:
 *
 *     ╭ minimal-agent v…
 *     │ session  …
 *     │ model    …
 *     │ effort   max
 *     │ tools    ± ShowDiff · MemoryTool · WebSearch
 *     ╰ mode     ASK
 *
 * Pre-v2.1 the plugin row read `3 tool(s) · 1 mode(s)` — an aggregate
 * count that hid which tools were actually loaded. This helper produces
 * the "names with optional icons" rendering that replaced it.
 *
 * Design notes:
 *
 * - Names render plain (no color). Only the icon picks up the manifest's
 *   `color`, so the row stays visually quiet next to `model` (boldCyan)
 *   and the cat mascot.
 * - Icon is optional per tool. When absent the entry is just the name —
 *   no synthetic placeholder, no bullet. The row reads cleanly even
 *   when no plugin declares an icon.
 * - Items are joined by a dim mid-dot (`·`) so groups stay legible
 *   regardless of icon presence.
 * - Returns `null` for empty input; the caller decides whether to print
 *   nothing or substitute a different row (e.g. "loaded" for plugins
 *   that contribute only prompt fragments).
 *
 * The full row (label + padding + chrome) is composed by
 * `printStartupRow` in `src/index.ts`; this helper produces only the
 * value text.
 *
 * @module startup-tools-row
 */

import { displayWidth } from "../../../term-width.ts"
import { c } from "../style/ansi.ts"

/**
 * Subset of `PluginToolDefinition` (in `./plugins/loader.ts`)
 * we actually need. Kept minimal so callers don't have to plumb the
 * full schema through.
 */
export interface StartupToolEntry {
  /** Tool name as advertised to the model. */
  name: string
  /** Optional cosmetic glyph from the plugin manifest. */
  icon?: string
  /** Optional palette name (e.g. `"lime"`, `"cyan"`) from the manifest. */
  color?: string
}

/**
 * Internal type guard: the `c` palette is a flat object of named
 * paint functions. We index it by string at runtime since plugin
 * manifests can declare any string in `color`.
 */
type Painter = (s: string) => string
const palette = c as unknown as Record<string, Painter>

/** The chunk separator: a dim mid-dot framed by single spaces. */
const ITEM_SEP = c.dim(" · ")
/** Visible width of {@link ITEM_SEP} (" · " is 3 cells; ANSI is 0). */
const ITEM_SEP_WIDTH = 3

/**
 * One laid-out tool chunk: the styled text plus the width we use for
 * *layout* decisions.
 *
 * `fitWidth` is deliberately ≥ `displayWidth(text)`: it adds one cell of
 * slop per icon glyph. Many of the icons plugins declare (✦ U+2726,
 * ✔ U+2714, ⤓ U+2913, the ⏰ family, …) sit in Unicode's
 * emoji/symbol ambiguous zone, where the *terminal font* decides whether
 * the glyph paints 1 or 2 cells. `displayWidth` measures the conservative
 * (narrow) value; a font that renders an icon as an emoji takes 2 cells.
 * Reserving one extra cell per icon means the wrapped row never renders
 * wider than the budget even on a font that picks the wide presentation,
 * which is what keeps `closeStartupTree`'s cursor math honest (a row that
 * renders wider than predicted is exactly what caused the old "tools row
 * printed twice" bug). On a font that renders icons narrow we just wrap a
 * hair earlier — harmless, and the full inventory still shows.
 */
interface ToolChunk {
  text: string
  fitWidth: number
}

/**
 * Build the styled per-tool chunks (icon + name, or bare name). Shared by
 * the single-line {@link formatStartupToolsRow} and the wrapping
 * {@link wrapStartupToolsRows} so the two never drift.
 */
function buildToolChunks(tools: ReadonlyArray<StartupToolEntry>): ToolChunk[] {
  return tools.map((t) => {
    if (!t.icon) return { text: t.name, fitWidth: displayWidth(t.name) }
    // Plugins declare arbitrary color names; fall back to faintWhite if
    // the requested name isn't a known palette entry. Keeps the row
    // robust in the face of typos or future palette renames.
    const paint =
      t.color && typeof palette[t.color] === "function" ? palette[t.color] : c.faintWhite
    const text = `${paint(t.icon)} ${t.name}`
    // +1 cell of font-presentation slop for the icon (see ToolChunk docs).
    return { text, fitWidth: displayWidth(text) + 1 }
  })
}

/**
 * Render the value column for the `tools` row of the startup tree as a
 * single line. Kept for callers (and tests) that don't care about width.
 *
 * @returns Display string (with ANSI escapes) or `null` when `tools`
 *          is empty.
 */
export function formatStartupToolsRow(tools: ReadonlyArray<StartupToolEntry>): string | null {
  if (tools.length === 0) return null
  return buildToolChunks(tools)
    .map((ch) => ch.text)
    .join(ITEM_SEP)
}

/**
 * Reflow the tool chunks across as many lines as needed so each line's
 * visible width stays within `maxWidth`. Chunks are never split
 * mid-name; a chunk wider than `maxWidth` on its own gets its own
 * (overflowing) line rather than being truncated. The caller is
 * responsible for prefixing continuation lines with the tree gutter
 * (`│ `) and re-indenting under the value column.
 *
 * This replaced the old single-line-then-truncate behavior: the `tools`
 * row used to clip with `…` on narrow terminals, hiding which tools were
 * actually loaded. Now the names wrap and stay fully visible.
 *
 * @param tools - Loaded tool entries (name + optional icon/color).
 * @param maxWidth - Visible cell budget per line (already net of the row's
 *                 chrome + label + indent). Non-positive → everything on
 *                 one line (defensive; caller should pass ≥1).
 * @returns One styled string per physical line, or `[]` when empty.
 */
export function wrapStartupToolsRows(
  tools: ReadonlyArray<StartupToolEntry>,
  maxWidth: number,
): string[] {
  if (tools.length === 0) return []
  const chunks = buildToolChunks(tools)
  if (maxWidth <= 0) return [chunks.map((ch) => ch.text).join(ITEM_SEP)]

  const lines: string[] = []
  let line = ""
  let lineWidth = 0
  for (const chunk of chunks) {
    if (line === "") {
      line = chunk.text
      lineWidth = chunk.fitWidth
    } else if (lineWidth + ITEM_SEP_WIDTH + chunk.fitWidth <= maxWidth) {
      line += ITEM_SEP + chunk.text
      lineWidth += ITEM_SEP_WIDTH + chunk.fitWidth
    } else {
      lines.push(line)
      line = chunk.text
      lineWidth = chunk.fitWidth
    }
  }
  if (line !== "") lines.push(line)
  return lines
}

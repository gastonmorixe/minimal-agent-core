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

import { c } from "./agent.ts"

/**
 * Subset of {@link import("./plugins/loader.ts").PluginToolDefinition}
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

/**
 * Render the value column for the `tools` row of the startup tree.
 *
 * @returns Display string (with ANSI escapes) or `null` when `tools`
 *          is empty.
 */
export function formatStartupToolsRow(tools: ReadonlyArray<StartupToolEntry>): string | null {
  if (tools.length === 0) return null
  const items = tools.map((t) => {
    if (!t.icon) return t.name
    // Plugins declare arbitrary color names; fall back to faintWhite if
    // the requested name isn't a known palette entry. Keeps the row
    // robust in the face of typos or future palette renames.
    const paint =
      t.color && typeof palette[t.color] === "function" ? palette[t.color] : c.faintWhite
    return `${paint(t.icon)} ${t.name}`
  })
  return items.join(c.dim(" · "))
}

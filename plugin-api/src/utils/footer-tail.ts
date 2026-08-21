/*
 * Keyed, multi-writer holder for right-aligned footer tail segments.
 *
 * The quota-status footer line is built by one plugin; other plugins (tps,
 * future readouts) want to place a short segment at the FAR RIGHT of that
 * same line. A single-writer suffix (see `decoration-suffix.ts`) can't do
 * this: writers would clobber each other, and the publisher has no access
 * to the line's final width — only the host's footer flush knows it.
 *
 * Split responsibilities:
 *
 *   - Plugins call `setFooterTail(key, text)` (via the slot context's
 *     `setFooterTail`, bound by the scheduler to the plugin id) to publish
 *     or clear (`""`) their own keyed segment.
 *   - The host's footer flush calls `getFooterTails()` at paint time,
 *     receives the non-empty values joined with a two-space gap, measures
 *     the base line's visible width, and pads so the block ends at the
 *     terminal's right edge.
 *
 * Usage:
 *   // In a plugin slot handler:
 *   ctx.setFooterTail?.("\x1b[2m42/tps\x1b[22m")
 *   ctx.setFooterTail?.("") // clear when idle
 *
 *   // In the host flush:
 *   import { getFooterTails } from "@minimal-agent/plugin-api/utils/footer-tail"
 *   const tails = getFooterTails()
 *   if (tails) line = padRight(line, tails, cols)
 */

const tails = new Map<string, string>()

/**
 * Get all non-empty footer tails joined with a two-space gap.
 * Empty string when no plugin has published a tail.
 */
export function getFooterTails(): string {
  const parts: string[] = []
  for (const v of tails.values()) {
    if (v.length > 0) parts.push(v)
  }
  return parts.join("  ")
}

/**
 * Publish (or clear, with empty string) the tail segment for one key.
 * Keys are plugin ids — the scheduler binds each slot's publisher to its
 * own plugin id, so concurrent plugins never clobber each other.
 */
export function setFooterTail(key: string, text: string): void {
  tails.set(key, text)
}

/** Test helper: drop every tail. */
export function clearFooterTails(): void {
  tails.clear()
}

/**
 * Join a footer line with the right-aligned tail block.
 *
 * Padding rule: `pad = cols - displayWidth(line) - displayWidth(tails)`,
 * clamped to a minimum of 2 cells. When `cols` is undefined (piped output,
 * test env) or the pad would go negative, fall back to an inline two-space
 * gap so the tails still render, just not edge-flushed. Widths are display
 * widths (ANSI escapes contribute 0 cells), so styled tails don't skew the
 * math.
 *
 * Pure: `cols` is resolved by the caller (the scheduler reads COLUMNS /
 * stdout.columns); this module stays free of env reads so both branches are
 * trivially testable.
 */
export function applyFooterTails(
  line: string,
  tailsBlock: string,
  cols: number | undefined,
  widthOf: (s: string) => number,
): string {
  if (cols == null) return `${line}  ${tailsBlock}`
  const pad = cols - widthOf(line) - widthOf(tailsBlock)
  if (pad < 2) return `${line}  ${tailsBlock}`
  return line + " ".repeat(pad) + tailsBlock
}

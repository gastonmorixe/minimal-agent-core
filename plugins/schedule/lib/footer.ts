/**
 * Colored, width-aware live-area footer row for scheduled tasks.
 *
 * TUI-only (never seen by the model), so unlike ./format.ts it emits real ANSI
 * via the shared {@link PALETTE} — matching the quota footer so the colors line
 * up. The glyph is the focal point and carries state through color:
 *   - `⧗` gold  → tasks pending, next fire is more than a minute out
 *   - `⧗` lime  → the soonest task is imminent (due now / within a minute)
 *
 * The row PROGRESSIVELY discloses detail to fit the terminal width (its own
 * dedicated footer line, so the budget is the full `cols`):
 *
 *   wide    ⧗ v3muss8a next in 26s  ·  aef21c3d 9f2b1a7e
 *   medium  ⧗ v3muss8a next in 26s  ·  +2
 *   narrow  ⧗ next in 26s · 3 tasks
 *   tiny    ⧗ 3 tasks
 *   floor   ⧗
 *
 * The soonest task leads (bold glyph + its short id in the glyph color + its
 * countdown); the remaining task ids trail dim, as many as fit, with a `+K`
 * overflow marker. Showing the ids lets the user see WHICH loops are armed,
 * not just how many.
 *
 * @module schedule/lib/footer
 */

import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"
import { displayWidth } from "@minimal-agent/plugin-api/utils/term-width"

import { GLYPH_TIME, relativeTime } from "./format.ts"
import { nextFireMs } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"

const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"
// Full SGR reset (clears color AND dim). NOT `\x1b[39m` (color-only), which
// would let the dim attribute bleed into whatever the footer renders next.
const RESET = "\x1b[0m"

/** Soonest task within this window → the glyph turns lime (imminent). */
const IMMINENT_MS = 60_000

/**
 * Render the footer row (ANSI), or `null` when there are no tasks. `cols`
 * defaults to the live terminal width; tests pass it explicitly. The result is
 * always ≤ `cols` cells wide, so the live area never soft-wraps it.
 */
export function formatStatusRow(
  entries: CronEntry[],
  now: number,
  cols: number = process.stdout.columns ?? 80,
): string | null {
  if (entries.length === 0) return null

  const sorted = [...entries].sort(
    (a, b) =>
      (nextFireMs(a, now) ?? Number.POSITIVE_INFINITY) -
      (nextFireMs(b, now) ?? Number.POSITIVE_INFINITY),
  )
  const soonest = sorted[0]!
  const soonestMs = nextFireMs(soonest, now)
  const imminent = soonestMs !== null && soonestMs - now <= IMMINENT_MS
  const color = imminent ? PALETTE.lime : PALETTE.gold
  const g = `${BOLD}${color}${GLYPH_TIME}${RESET}`
  const count = `${entries.length} task${entries.length === 1 ? "" : "s"}`
  const fits = (s: string) => displayWidth(s) <= cols

  // No computable next fire (e.g. all one-shots already past): quiet count.
  if (soonestMs === null) {
    const full = `${g} ${DIM}${count}${RESET}`
    return fits(full) ? full : g
  }

  const rel = relativeTime(soonestMs, now)
  const when = rel === "due now" ? "due now" : `next ${rel}`

  // Richest lead: glyph + soonest id (in the glyph color) + countdown (dim).
  const lead = `${g} ${color}${soonest.id}${RESET} ${DIM}${when}${RESET}`
  if (!fits(lead)) {
    // Too narrow for the id: drop it. glyph + when + count → glyph + count → glyph.
    const a = `${g} ${DIM}${when} · ${count}${RESET}`
    if (fits(a)) return a
    const b = `${g} ${DIM}${count}${RESET}`
    if (fits(b)) return b
    return g
  }

  // Lead fits — append the other task ids (dim) greedily, then a `+K` marker
  // for any that didn't fit.
  let out = lead
  const others = sorted.slice(1)
  let i = 0
  for (; i < others.length; i++) {
    const sep = i === 0 ? `  ${DIM}·${RESET}  ` : " "
    const candidate = `${out}${sep}${DIM}${others[i]!.id}${RESET}`
    if (!fits(candidate)) break
    out = candidate
  }
  if (i < others.length) {
    const withK = `${out}  ${DIM}·  +${others.length - i}${RESET}`
    if (fits(withK)) out = withK
  }
  return out
}

/**
 * Neutral one-line quota summary renderer.
 *
 * Renders provider-NEUTRAL {@link QuotaWindow}s (parsed by the active
 * provider plugin behind `ProviderPlugin.fetchSessionInfo`) into the
 * compact colored startup-banner row. Core renders shapes; providers own
 * their wire formats (Phase-14 replacement for the deleted
 * `quota-format.ts`, which parsed `*-ratelimit-*` headers in core).
 *
 * Visual contract (pinned in `quota-summary.test.ts`, ported from the old
 * formatter's tests so the banner is byte-stable across the refactor):
 *   `5h 12% ↻ 3h12m · 7d 4% ↻ 2d6h · overall 9%`
 *   - integer percent, green below 60 / yellow 60-84 / red ≥85
 *   - reset humanized as `Nm` / `NhMm` / `Nd` / `NdMh`, omitted when past
 *   - windows pre-sorted by the provider (5h, 7d, named, overall)
 *   - optional trailing `overage off` segment (opt-in, non-"allowed" only)
 *
 * @module quota-summary
 */

import type { QuotaSnapshot, QuotaWindow } from "./llm/provider-plugin.ts"
import { c } from "./host/ui/style/ansi.ts"

export interface QuotaSummaryOptions {
  /** Spaces before the first segment (banner alignment). */
  leadSpaces?: number
  /** Surface an inactive overage status as a red trailing segment. */
  showOverage?: boolean
  /** Provider overage DTO (only consulted when `showOverage`). */
  overage?: QuotaSnapshot["overage"]
  /** Clock override for tests. */
  now?: () => number
}

/**
 * Render neutral quota windows as the one-line colored summary.
 * Returns `""` when there is nothing to show (caller skips the row).
 */
export function formatQuotaWindows(
  windows: readonly QuotaWindow[],
  opts: QuotaSummaryOptions = {},
): string {
  const now = opts.now ?? Date.now

  const colorPct = (util: number): string => {
    // Integer percent for at-a-glance compactness. Round ONCE and branch the
    // color on the same rounded value the user sees, so the color and the
    // number never disagree at boundaries (e.g. 84.6 → "85%" must be red).
    const pct = Math.round(util * 100)
    const txt = `${pct}%`
    if (pct >= 85) return c.red(txt)
    if (pct >= 60) return c.yellow(txt)
    return c.green(txt)
  }

  const humanReset = (resetAt: number): string | null => {
    const diffMs = resetAt - now()
    if (diffMs <= 0) return null
    const totalMins = Math.floor(diffMs / 60_000)
    const days = Math.floor(totalMins / (60 * 24))
    const hrs = Math.floor((totalMins % (60 * 24)) / 60)
    const mins = totalMins % 60
    if (days > 0) return hrs > 0 ? `${days}d${hrs}h` : `${days}d`
    if (hrs > 0) return `${hrs}h${mins}m`
    return `${mins}m`
  }

  const parts: string[] = []
  for (const w of windows) {
    let segment = `${c.faintWhite(w.id)} ${colorPct(w.utilization)}`
    if (w.resetAtMs) {
      const human = humanReset(w.resetAtMs)
      if (human) segment += ` ${c.dim("↻")} ${c.dim(human)}`
    }
    parts.push(segment)
  }

  // Overage — opt-in; "allowed" stays silent (the common, boring case).
  if (opts.showOverage && opts.overage && !opts.overage.active) {
    parts.push(`${c.faintWhite("overage")} ${c.red("off")}`)
  }

  if (parts.length === 0) return ""
  const sep = c.dim(" · ")
  const lead = " ".repeat(opts.leadSpaces ?? 0)
  return `${lead}${parts.join(sep)}`
}

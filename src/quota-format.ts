/**
 * Pure formatter for parsed `anthropic-ratelimit-*` response headers.
 *
 * Renders a compact, single-line, mid-dot-separated summary of the current
 * quota state — window name, utilization %, and time-to-reset — with
 * percentage color-graded by severity.
 *
 * Lifted out of `src/index.ts` so the startup banner AND the live-area
 * `quota-status` plugin can share one source of truth. Pure: no I/O, no
 * env reads, no `Date.now()` other than for the `↻` countdown (taken via
 * an injectable `now()` so tests don't drift).
 *
 * @module quota-format
 */

import { c } from "./agent.ts"

/**
 * Style hints for {@link formatQuotaSummary}.
 *
 * - `leadSpaces`: prefix the result with this many spaces. The startup
 *   path passes `2` to align with its tree-indented row; the live-area
 *   path passes `0` because the slot is column-anchored already.
 * - `now`: clock injection for tests. Defaults to `Date.now()`.
 */
export interface FormatQuotaOptions {
  leadSpaces?: number
  now?: () => number
}

/**
 * Format the parsed rate-limit headers from a successful quota check into a
 * compact, single-line summary.
 *
 * Style: minimalist, mid-dot separated. Window names are normal weight,
 * percentages are color-graded (green/yellow/red) by utilization, the soonest
 * reset is shown faint. Returns `""` when there's nothing useful to show
 * (e.g. test fakes without rate-limit headers).
 */
export function formatQuotaSummary(
  rl: Map<string, string>,
  opts: FormatQuotaOptions = {},
): string {
  if (rl.size === 0) return ""
  const now = opts.now ?? Date.now

  type Win = { util?: number; status?: string; reset?: number }
  const windows = new Map<string, Win>()
  // Two header shapes:
  //   anthropic-ratelimit-unified-<window>-<field>   (e.g. 5h, 7d, overage)
  //   anthropic-ratelimit-unified-<field>            (aggregate, no window)
  // We map the aggregate form to the synthetic key "overall" so it sorts and
  // renders alongside the windowed entries.
  const FIELDS = new Set(["utilization", "status", "reset"])
  for (const [k, v] of rl) {
    let win: string | null = null
    let field: string | null = null
    const mw = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (mw) {
      win = mw[1]!
      field = mw[2]!
    } else {
      const ma = k.match(/^anthropic-ratelimit-unified-(\w+)$/)
      if (ma && FIELDS.has(ma[1]!)) {
        win = "overall"
        field = ma[1]!
      }
    }
    if (!win || !field) continue
    if (!windows.has(win)) windows.set(win, {})
    const w = windows.get(win)!
    if (field === "utilization") w.util = Number(v)
    else if (field === "status") w.status = v
    else if (field === "reset") w.reset = Number(v) * 1000
  }

  const colorPct = (util: number): string => {
    const pct = util * 100
    // Round so 0.099 doesn't render as "9.9%". We show integers for
    // compactness — sub-percent precision isn't useful at a glance.
    const txt = `${Math.round(pct)}%`
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
  // Stable, narrow→wide order: 5h, 7d, overall (aggregate). Anything else
  // sorts after, alphabetical.
  const order = (w: string): number => (w === "5h" ? 0 : w === "7d" ? 1 : w === "overall" ? 2 : 3)
  const winEntries = [...windows.entries()]
    .filter(([w]) => w !== "overage" && w !== "fallback" && w !== "representative")
    .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))

  for (const [name, info] of winEntries) {
    if (info.util == null) continue
    let segment = `${c.faintWhite(name)} ${colorPct(info.util)}`
    if (info.reset) {
      const human = humanReset(info.reset)
      if (human) segment += ` ${c.dim("↻")} ${c.dim(human)}`
    }
    parts.push(segment)
  }

  // Overage status — only surface when explicitly disabled (the common case
  // is "allowed" and noise-free is better here).
  const ov = rl.get("anthropic-ratelimit-unified-overage-status")
  if (ov && ov !== "allowed") {
    parts.push(`${c.faintWhite("overage")} ${c.red("off")}`)
  }

  if (parts.length === 0) return ""
  const sep = c.dim(" · ")
  const lead = " ".repeat(opts.leadSpaces ?? 0)
  return `${lead}${parts.join(sep)}`
}

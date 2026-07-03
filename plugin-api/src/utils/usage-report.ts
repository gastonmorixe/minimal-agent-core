/**
 * Shared token-usage report shapes.
 *
 * The host owns the data engine that scans session history, but renderers and
 * plugins need a host-free contract for the folded report values. This module
 * is intentionally pure data: no filesystem, no model registry, no TUI state.
 *
 * @module usage-report
 */

/** The selectable look-back windows. Each is an independent filter ending "now". */
export type UsagePeriod = "today" | "last-day" | "last-month" | "ytd" | "year" | "all"

/** Ordered list of periods with short display labels, for interactive switchers. */
export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "today", label: "Today" },
  { id: "last-day", label: "Last 24h" },
  { id: "last-month", label: "Last 30d" },
  { id: "ytd", label: "YTD" },
  { id: "year", label: "Last year" },
  { id: "all", label: "All time" },
]

/**
 * Map a free-form CLI token to a {@link UsagePeriod}. Returns null on no match.
 * Pure string→enum helper (zero host state), so it lives on the leaf next to
 * {@link USAGE_PERIODS} and a plugin can parse its own `/usage <period>` argv
 * without reaching into `src/`.
 */
export function parseUsagePeriod(raw: string | undefined): UsagePeriod | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  switch (s) {
    case "today":
    case "day0":
      return "today"
    case "last-day":
    case "lastday":
    case "24h":
    case "1d":
    case "day":
      return "last-day"
    case "last-month":
    case "lastmonth":
    case "month":
    case "30d":
    case "1m":
      return "last-month"
    case "ytd":
    case "year-to-date":
      return "ytd"
    case "year":
    case "1y":
    case "365d":
    case "last-year":
      return "year"
    case "all":
    case "alltime":
    case "all-time":
      return "all"
    default:
      return null
  }
}

/** Folded token/cost totals for a set of usage events. */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Sum of headline token counts across the set. */
  tokens: number
  /** Sum of exact USD cost (real events only; estimated contribute 0). */
  costUSD: number
  /** Number of assistant turns counted. */
  turns: number
  /** Of {@link turns}, how many were estimated (no saved billed usage). */
  estimatedTurns: number
}

/** A named breakdown row (per provider or per model) with its totals. */
export interface UsageBreakdownRow {
  /** Provider id or model id. */
  key: string
  totals: UsageTotals
}

/** Full usage report for one period: totals + provider + model breakdowns. */
export interface UsageReport {
  period: UsagePeriod
  /** Window lower bound (epoch ms); 0 for `all`. */
  startMs: number
  /** "Now" the report was computed against (epoch ms). */
  nowMs: number
  totals: UsageTotals
  /** Per-provider rows, sorted by tokens descending. */
  byProvider: UsageBreakdownRow[]
  /** Per-model rows, sorted by tokens descending. */
  byModel: UsageBreakdownRow[]
  /** True when ANY counted turn was estimated. Drives the `[E]`/mixed marker. */
  estimated: boolean
}

/** Zeroed {@link UsageTotals}. */
function emptyUsageTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    tokens: 0,
    costUSD: 0,
    turns: 0,
    estimatedTurns: 0,
  }
}

/**
 * An empty (zeroed) {@link UsageReport} for one period — no events, no
 * breakdowns. Pure + host-free, so a test or a plugin can build the
 * "nothing recorded yet" shape without scanning disk or importing `src/`.
 * `startMs` is left 0 (the report is empty regardless of the window bound).
 */
export function emptyUsageReport(period: UsagePeriod, nowMs: number = Date.now()): UsageReport {
  return {
    period,
    startMs: 0,
    nowMs,
    totals: emptyUsageTotals(),
    byProvider: [],
    byModel: [],
    estimated: false,
  }
}

/**
 * Empty reports for EVERY period (the zeroed analog of the host's
 * `aggregateAllPeriods([])`). Lets the overlay/state tests build fixtures
 * without reaching into `src/quota/usage-stats`.
 */
export function emptyUsageReports(nowMs: number = Date.now()): Record<UsagePeriod, UsageReport> {
  const out = {} as Record<UsagePeriod, UsageReport>
  for (const { id } of USAGE_PERIODS) out[id] = emptyUsageReport(id, nowMs)
  return out
}

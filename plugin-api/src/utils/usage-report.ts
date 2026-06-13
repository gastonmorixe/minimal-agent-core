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

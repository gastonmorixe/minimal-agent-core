/**
 * LOCAL structural re-declaration of the host usage-report shapes this plugin
 * stores in its overlay state. The decoupling contract: a plugin may NOT
 * import host code (`src/...`), not even type-only — it must be able to live in
 * its own repository. So we re-declare exactly the slice of the usage data
 * engine's value types we hold; TypeScript's structural typing means the real
 * `Record<UsagePeriod, UsageReport>` the host's `aggregateAllPeriods` produces
 * satisfies these at runtime, with no cast.
 *
 * The host-side source of truth for these shapes is `src/usage-stats.ts`. Keep
 * the field names and the `UsagePeriod` union in lockstep — the overlay tests
 * (`overlay.test.ts`, `state.test.ts`) feed the REAL host reports through this
 * plugin and fail on drift.
 *
 * Note: the runtime data engine itself (`scanUsageEvents` / `aggregateUsage` /
 * `USAGE_PERIODS`) and the renderers (`renderUsageReport` / `renderUsageOverlay`)
 * stay as host imports in `overlay.ts` / `cmd_usage.ts` until a `usage:read`
 * capability (or a package home for the pure renderers) exists — they scan the
 * session store and read the model registry, which is host state.
 *
 * @module plugins/usage/lib/host-types
 */

/** The selectable look-back windows. Mirrors `src/usage-stats.ts`. */
export type UsagePeriod = "today" | "last-day" | "last-month" | "ytd" | "year" | "all"

/** Folded token/cost totals for a set of usage events. */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Sum of per-event headline token counts. */
  tokens: number
  /** Sum of exact USD cost (real events only; estimated contribute 0). */
  costUSD: number
  /** Number of assistant turns counted. */
  turns: number
  /** Of `turns`, how many were estimated (no saved billed usage). */
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
  /** True when ANY counted turn was estimated. */
  estimated: boolean
}

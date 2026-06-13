/**
 * Pure overlay logic for the `/usage` footer panel.
 *
 * Holds NO process state — that's `state.ts`. This module is the testable
 * core: given the precomputed per-period reports and a selected index, it
 * resolves the active period and renders the compact overlay. Key handling
 * is expressed as index math (`stepIndex` / `jumpIndex`) so the FSM-ish
 * behavior is unit-testable without a terminal.
 *
 * @module usage/lib/overlay
 */

import { renderUsageOverlay } from "../../../src/ui/usage/render.ts"
import { USAGE_PERIODS, type UsagePeriod, type UsageReport } from "../../../src/usage-stats.ts"

/** Default selected index: "All time" (last in the catalog). */
export const DEFAULT_PERIOD_INDEX = USAGE_PERIODS.length - 1

/** Clamp + wrap an index into the valid period range. */
export function wrapIndex(i: number): number {
  const n = USAGE_PERIODS.length
  return ((i % n) + n) % n
}

/** Step the selected index by `delta` (wraps). */
export function stepIndex(current: number, delta: number): number {
  return wrapIndex(current + delta)
}

/**
 * Map a 1-based number key (`"1"`..`"6"`) to a period index, or null when the
 * string isn't a valid jump key.
 */
export function jumpIndex(key: string): number | null {
  const n = Number.parseInt(key, 10)
  if (!Number.isInteger(n) || n < 1 || n > USAGE_PERIODS.length) return null
  return n - 1
}

/** The {@link UsagePeriod} at a given index. */
export function periodAt(index: number): UsagePeriod {
  return USAGE_PERIODS[wrapIndex(index)]!.id
}

/**
 * Render the overlay lines for the active period.
 *
 * @param reports - Precomputed reports keyed by period (one disk scan).
 * @param index - Selected period index.
 * @param cols - Terminal width.
 * @param maxRows - Max model rows to show.
 */
export function renderOverlayFrame(
  reports: Record<UsagePeriod, UsageReport>,
  index: number,
  cols: number,
  maxRows: number,
): string[] {
  const period = periodAt(index)
  return renderUsageOverlay(reports[period], { cols, maxRows })
}

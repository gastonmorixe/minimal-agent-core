/**
 * Process-singleton state for the `/usage` overlay, shared between the
 * `cmd_usage` and `on_key` handlers (ESM caches by URL → one instance).
 * Same pattern as the config + slash-menu plugins.
 *
 * The overlay precomputes every period's report from ONE disk scan when it
 * opens, so arrow-key period switching is allocation-free and never re-reads
 * the session files. `open: false` ⇒ key handler is a clean no-op.
 *
 * @module usage/lib/state
 */

import type { UsagePeriod, UsageReport } from "./host-types.ts"
import { DEFAULT_PERIOD_INDEX } from "./overlay.ts"

/**
 * Stable owner id for the modal-overlay channels (`editor.overlay.open` /
 * `editor.overlay.close`). Matches the plugin id; the host scopes ownership
 * to it so a close from a different overlay is ignored.
 */
export const USAGE_OVERLAY_OWNER = "usage"

export interface UsageOverlayState {
  open: boolean
  /** Selected period index into USAGE_PERIODS. */
  index: number
  /** Per-period reports, computed once on open. Empty object while closed. */
  reports: Record<UsagePeriod, UsageReport> | null
}

const state: UsageOverlayState = {
  open: false,
  index: DEFAULT_PERIOD_INDEX,
  reports: null,
}

/** Read the current usage-overlay state (singleton per process). */
export function getOverlayState(): UsageOverlayState {
  return state
}

/** Open the overlay with the given precomputed reports (resets selection). */
export function openOverlay(
  reports: Record<UsagePeriod, UsageReport>,
  index = DEFAULT_PERIOD_INDEX,
): void {
  state.open = true
  state.index = index
  state.reports = reports
}

/** Close + drop the reports so a stray later key is a clean no-op. */
export function closeOverlay(): void {
  state.open = false
  state.reports = null
  state.index = DEFAULT_PERIOD_INDEX
}

/** Test hook: reset everything. */
export function _resetForTests(): void {
  closeOverlay()
}

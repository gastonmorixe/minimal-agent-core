/**
 * Local shim for usage-report shapes consumed by the overlay state.
 *
 * The source of truth is the leaf contract package, not host `src/` code. This
 * file keeps the plugin's internal imports stable while preserving the
 * decoupling rule that plugins must not import host implementation modules.
 *
 * @module plugins/usage/lib/host-types
 */

export type {
  UsageBreakdownRow,
  UsagePeriod,
  UsageReport,
  UsageTotals,
} from "@minimal-agent/plugin-api/utils/usage-report"

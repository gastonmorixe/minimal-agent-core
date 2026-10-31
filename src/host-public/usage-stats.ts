/**
 * Public re-export shim for `@minimal-agent/core/host/usage-stats`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Token-usage aggregation across ALL saved sessions, bucketed by period and
 * broken down by provider/model — the data engine behind a `usage` command.
 * See `../quota/usage-stats.ts` for the full contract.
 *
 * @module host-public/usage-stats
 */

export * from "../quota/usage-stats.ts"

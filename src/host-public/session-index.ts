/**
 * Public re-export shim for `@minimal-agent/core/host/session-index`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `readSessionIndex` / `resolveSidByPrefix` / `resolveSessionTarget` /
 * `resolveLastSessionSid` — resolves a `--resume`/history target to a
 * concrete session id. See `../session/session-index.ts` for the
 * full contract.
 *
 * `listSessions` (session catalog: a fast, index-only session listing with
 * sub-agent children and per-session summaries) and the summary helpers
 * (`firstRealUserText`, `computeSessionSummary`, …) ride on the same
 * subpath. See `../session/session-catalog.ts` and
 * `../session/session-summary.ts`. `backfillLineage` (lineage lines for old
 * sub-agent sessions) is in `../session/session-lineage-backfill.ts`.
 *
 * @module host-public/session-index
 */

export * from "../session/session-catalog.ts"
export * from "../session/session-index.ts"
export * from "../session/session-lineage-backfill.ts"
export type {
  IndexLine,
  IndexLineage,
  IndexLineageRecord,
  IndexLineageSource,
  IndexRecord,
  IndexSummaryRecord,
  IndexTombstoneRecord,
} from "../session/session-store.ts"
export {
  indexMetaFilePath,
  isIndexLineageRecord,
  isIndexSummaryRecord,
  isIndexTombstoneRecord,
} from "../session/session-store.ts"
export * from "../session/session-summary.ts"

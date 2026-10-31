/**
 * Public re-export shim for `@minimal-agent/core/host/session-restore`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Pure data-folding (`foldRecords`, `foldRecordsForDisplay`,
 * `repairMessages`) that reconstructs a conversation from a `<sid>.jsonl`
 * log, plus the `loadSession` I/O wrapper. The exact pipeline a `--resume`
 * flow or a history-replay view needs. See
 * `../session/session-restore.ts` for the full contract.
 *
 * @module host-public/session-restore
 */

export * from "../session/session-restore.ts"

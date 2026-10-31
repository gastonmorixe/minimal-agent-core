/**
 * Public re-export shim for `@minimal-agent/core/host/queue-restore`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Any host restoring a session's queued-but-undrained submit buffer into its
 * own editor uses this exact formatting idiom (ordinal list, multi-line
 * indent) instead of reimplementing it. See `../session/queue-restore.ts`
 * for the full contract.
 *
 * @module host-public/queue-restore
 */

export * from "../session/queue-restore.ts"

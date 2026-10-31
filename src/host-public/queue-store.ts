/**
 * Public re-export shim for `@minimal-agent/core/host/queue-store`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Per-session submit-queue persistence (the REPL's "submitted but not yet
 * drained" buffer, snapshotted to `<sid>.queue`). See
 * `../session/queue-store.ts` for the full contract.
 *
 * @module host-public/queue-store
 */

export * from "../session/queue-store.ts"

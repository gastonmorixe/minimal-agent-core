/**
 * Public re-export shim for `@minimal-agent/core/host/context-exceeded-recovery`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `tryRecoverContextExceeded` — the one auto-compact-and-retry policy for a
 * context-window failure, shared by every host surface. See
 * `../agent/context-exceeded-recovery.ts` for the full contract.
 *
 * @module host-public/context-exceeded-recovery
 */

export * from "../agent/context-exceeded-recovery.ts"

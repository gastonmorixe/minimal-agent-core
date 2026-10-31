/**
 * Public re-export shim for `@minimal-agent/core/host/session-liveness`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Answers "is an agent currently attached to this session?" by probing the
 * live OS, not by trusting the on-disk log alone. See
 * `../session/session-liveness.ts` for the full contract.
 *
 * @module host-public/session-liveness
 */

export * from "../session/session-liveness.ts"

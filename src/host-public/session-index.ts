/**
 * Public re-export shim for `@minimal-agent/core/host/session-index`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `readSessionIndex` / `resolveSidByPrefix` / `resolveSessionTarget` /
 * `resolveLastSessionSid` — resolves a `--resume`/history target to a
 * concrete session id. See `../host/commands/session-index.ts` for the
 * full contract.
 *
 * @module host-public/session-index
 */

export * from "../host/commands/session-index.ts"

/**
 * Public re-export shim for `@minimal-agent/core/host/session-id`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * The provider-neutral conversation identifier that keys session files,
 * the file-lock identity, and the net-dbg capture dir. See
 * `../session/session-id.ts` for the full contract.
 *
 * @module host-public/session-id
 */

export * from "../session/session-id.ts"

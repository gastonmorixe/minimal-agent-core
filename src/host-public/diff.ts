/**
 * Public re-export shim for `@minimal-agent/core/host/diff`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `buildEditDiff` / `buildFileDiff` compute the identical diff the live
 * execution path shows for Edit/Write, for rendering-parity use in history
 * replay or any other host. See `../utils/diff.ts` for the full
 * contract.
 *
 * @module host-public/diff
 */

export * from "../utils/diff.ts"

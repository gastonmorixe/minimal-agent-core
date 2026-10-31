/**
 * Public re-export shim for `@minimal-agent/core/host/paste-intercept`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Synchronous editor paste handling: turns a drag-and-drop or clipboard-image
 * paste into media tokens. Pairs with `./host/clipboard`. See
 * `../media/paste-intercept.ts` for the full contract.
 *
 * @module host-public/paste-intercept
 */

export * from "../media/paste-intercept.ts"

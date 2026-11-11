/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-prompt-resolution`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Resolves whether a plugin prompt is suppressed for the current session.
 * Pairs with `./host/plugin-enable-resolution`. See
 * `../plugins/plugin-prompt-resolution.ts` for the full contract.
 *
 * @module host-public/plugin-prompt-resolution
 */

export * from "../plugins/plugin-prompt-resolution.ts"

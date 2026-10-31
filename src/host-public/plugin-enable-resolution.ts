/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-enable-resolution`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Pure CLI \> env \> config \> manifest-default resolver. Pairs with
 * `./host/plugin-platform-resolution`. See
 * `../plugins/plugin-enable-resolution.ts` for the full contract.
 *
 * @module host-public/plugin-enable-resolution
 */

export * from "../plugins/plugin-enable-resolution.ts"

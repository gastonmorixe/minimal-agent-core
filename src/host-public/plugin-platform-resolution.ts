/**
 * Public re-export shim for `@minimal-agent/core/host/plugin-platform-resolution`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Pure CLI \> env \> detected resolver for the platform the plugin loader
 * gates manifests against. See
 * `../plugins/plugin-platform-resolution.ts` for the full contract.
 *
 * @module host-public/plugin-platform-resolution
 */

export * from "../plugins/plugin-platform-resolution.ts"

/**
 * Public re-export shim for `@minimal-agent/core/host/auth-strategies`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../auth/auth-strategies.ts`: the
 * "which credentials/providers are available" query surface over the
 * provider-plugin registry's auth hooks.
 *
 * @module host-public/auth-strategies
 */

export * from "../auth/auth-strategies.ts"

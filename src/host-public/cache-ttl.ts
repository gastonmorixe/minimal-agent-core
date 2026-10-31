/**
 * Public re-export shim for `@minimal-agent/core/host/cache-ttl`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../cache/cache-ttl.ts`: the
 * CLI/env/config prompt-cache TTL precedence resolver.
 *
 * @module host-public/cache-ttl
 */

export * from "../cache/cache-ttl.ts"

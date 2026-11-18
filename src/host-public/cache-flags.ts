/**
 * Public re-export shim for `@minimal-agent/core/host/cache-flags`.
 *
 * The real implementation stays at `../cache/cache-flags.ts`: the
 * CLI/env/config resolvers of the `cacheAnchor` and `thinkingHistory` flags.
 *
 * @module host-public/cache-flags
 */

export * from "../cache/cache-flags.ts"

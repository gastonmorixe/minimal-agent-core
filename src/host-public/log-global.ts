/**
 * Public re-export shim for `@minimal-agent/core/host/log-global`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `GlobalLogSink` — one audit-trail file for the whole install, surviving
 * across runs. Pairs with `./host/log-file` and `./host/diagnostics`. See
 * `../logging/log-global.ts` for the full contract.
 *
 * @module host-public/log-global
 */

export * from "../logging/log-global.ts"

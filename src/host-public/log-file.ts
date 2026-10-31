/**
 * Public re-export shim for `@minimal-agent/core/host/log-file`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `FileLogSink` — subscribes to a `DiagnosticBus` and appends RFC 5424
 * lines per-session to disk. Pairs with `./host/diagnostics`. See
 * `../logging/log-file.ts` for the full contract.
 *
 * @module host-public/log-file
 */

export * from "../logging/log-file.ts"

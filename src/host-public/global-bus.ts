/**
 * Public re-export shim for `@minimal-agent/core/host/global-bus`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `setGlobalEventBus` / `getGlobalEventBus` — still load-bearing for
 * engine-side live telemetry (`run-compact.ts`, `quota-broadcast.ts`), so
 * whoever owns the plugin loader after the CLI split must still be able to
 * install the bus here. See `../bus/global-bus.ts` for the full
 * contract.
 *
 * @module host-public/global-bus
 */

export * from "../bus/global-bus.ts"

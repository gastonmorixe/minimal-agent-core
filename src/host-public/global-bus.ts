/**
 * Public re-export shim for `@minimal-agent/core/host/global-bus`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `setGlobalEventBus` / `getGlobalEventBus` — a host-side pointer to the
 * plugin bus. No engine path reads it: compaction and quota telemetry go
 * through the injected `pluginEvents` port (spec S28). See
 * `../bus/global-bus.ts` for the full contract.
 *
 * @module host-public/global-bus
 */

export * from "../bus/global-bus.ts"

/**
 * Public re-export of src/plugins/event-bus.ts (`EventBus` and its
 * listener/context types) — the plugin runtime's own event bus, needed by
 * `live-area-scheduler.ts` and e2e tests (S34 exports-gap decision,
 * Phase 0 / Bucket C). Pairs with the already-exported
 * `./host/global-bus` (S34 Y3) — same namespace, same placement.
 *
 * @module host-public/event-bus
 */
export * from "../plugins/event-bus.ts"

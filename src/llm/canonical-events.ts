/**
 * Re-export shim (Wave D-1). The canonical streaming-event type surface MOVED
 * to the leaf contract package `@minimal-agent/plugin-api/llm/canonical-events`
 * so plugins can depend on it without reaching into `src/`. This shim keeps the
 * old `src/llm/canonical-events.ts` import path alive for core (and any
 * not-yet-swept plugin) until the per-plugin D-5..D-12 sweeps re-point
 * importers at the package. `export *` carries both the event types AND the
 * pure `isEvent` runtime helper.
 *
 * @module llm/canonical-events
 */

export * from "@minimal-agent/plugin-api/llm/canonical-events"

/**
 * Re-export shim (Wave D-1). The capability type/util surface MOVED to the
 * leaf contract package `@minimal-agent/plugin-api/llm/capabilities` so plugins
 * can depend on it without reaching into `src/`. This shim keeps the old
 * `src/llm/capabilities.ts` import path alive for core (and any not-yet-swept
 * plugin) until the per-plugin D-5..D-12 sweeps re-point importers at the
 * package. `export *` carries both the types AND the pure runtime helpers
 * (`EFFORT_LEVELS`, `defaultCapabilities`, `compareEffort`, `supportsEffort`).
 *
 * @module llm/capabilities
 */

export * from "@minimal-agent/plugin-api/llm/capabilities"

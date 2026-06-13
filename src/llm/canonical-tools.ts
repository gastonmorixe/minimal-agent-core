/**
 * Re-export shim (Wave D-1). The canonical tool-definition type surface MOVED
 * to the leaf contract package `@minimal-agent/plugin-api/llm/canonical-tools`
 * so plugins can depend on it without reaching into `src/`. This shim keeps the
 * old `src/llm/canonical-tools.ts` import path alive for core (and any
 * not-yet-swept plugin) until the per-plugin D-5..D-12 sweeps re-point
 * importers at the package. `export *` carries both the tool types AND the pure
 * `isServerTool` runtime helper.
 *
 * @module llm/canonical-tools
 */

export * from "@minimal-agent/plugin-api/llm/canonical-tools"

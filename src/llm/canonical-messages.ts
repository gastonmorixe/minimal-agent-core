/**
 * Re-export shim (Wave D-1). The canonical message/content-block type surface
 * MOVED to the leaf contract package
 * `@minimal-agent/plugin-api/llm/canonical-messages` so plugins can depend on
 * it without reaching into `src/`. This shim keeps the old
 * `src/llm/canonical-messages.ts` import path alive for core (and any
 * not-yet-swept plugin) until the per-plugin D-5..D-12 sweeps re-point
 * importers at the package. `export *` carries both the block types AND the
 * pure message constructors (`userText`, `assistantText`, `systemMessage`,
 * `toolResult`).
 *
 * @module llm/canonical-messages
 */

export * from "@minimal-agent/plugin-api/llm/canonical-messages"

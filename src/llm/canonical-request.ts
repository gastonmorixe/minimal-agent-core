/**
 * Re-export shim (Wave C-3). The canonical request type surface MOVED to the
 * leaf contract package `@minimal-agent/plugin-api/llm/canonical-request` so
 * plugins can depend on it without reaching into `src/`. This shim keeps the
 * old `src/llm/canonical-request.ts` import path alive for core (and any
 * not-yet-swept plugin). `export *` carries the request shapes
 * (`CanonicalRequest`, `GenerationConfig`, `ThinkingConfig`, `OutputFormat`,
 * vendor opt shapes, `RequestMetadata`) AND `CanonicalResponseSummary`.
 *
 * @module llm/canonical-request
 */

export * from "@minimal-agent/plugin-api/llm/canonical-request"

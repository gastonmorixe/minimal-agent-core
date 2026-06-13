/**
 * Shared modality gating — `src/` surface.
 *
 * Wave D-2: the implementation MOVED whole into the leaf contract package
 * `@minimal-agent/plugin-api/llm/modality-check` (its entire dependency graph
 * resolves in-package), so a plugin's `validate()` can gate modalities without
 * reaching into `src/`. This module is a one-line re-export shim keeping the
 * old `src/llm/modality-check.ts` import path alive for core and any
 * not-yet-swept plugin.
 *
 * @module llm/modality-check
 */

export * from "@minimal-agent/plugin-api/llm/modality-check"

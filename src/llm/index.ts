/**
 * Public barrel for the canonical LLM core.
 *
 * Importers that don't need provider-specific types should import
 * everything from here. Provider adapters export their own surfaces
 * from `src/llm/providers/<id>/index.ts`.
 *
 * @module llm
 */

export * from "./canonical-events.ts"
export * from "./canonical-messages.ts"
export * from "./canonical-request.ts"
export * from "./canonical-tools.ts"
export * from "./capabilities.ts"
export * from "./errors.ts"
export * from "./modality-check.ts"
export * from "./model-label.ts"
export * from "./model-registry.ts"
export * from "./preflight.ts"
export * from "./pricing.ts"
export * from "./provider.ts"
export * from "./provider-discovery.ts"
export * from "./provider-plugin.ts"
export { type RunOptions, run } from "./run.ts"
export * from "./surface-codec-registry.ts"
export * from "./token-estimate.ts"

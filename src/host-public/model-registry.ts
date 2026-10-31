/**
 * Public re-export shim for `@minimal-agent/core/host/model-registry`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/model-registry.ts`: the model and
 * provider registries, including the test-hygiene resets
 * (`clearModelRegistry`/`clearProviderRegistry`) the CLI's own future test
 * suite will need.
 *
 * @module host-public/model-registry
 */

export * from "../llm/model-registry.ts"

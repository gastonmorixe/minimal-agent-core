/**
 * Public re-export shim for `@minimal-agent/core/host/model-catalog`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `ModelCatalogRow` + the pure collect/group functions over the model
 * registry, for a `models`/`--list-models` style command. See
 * `../llm/model-catalog-data.ts` for the full contract.
 *
 * @module host-public/model-catalog
 */

export * from "../llm/model-catalog-data.ts"

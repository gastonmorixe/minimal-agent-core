/**
 * Public re-export shim for `@minimal-agent/core/host/list-models`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/list-models.ts`: the
 * provider-neutral live model listing the REPL model picker uses.
 *
 * @module host-public/list-models
 */

export * from "../llm/list-models.ts"

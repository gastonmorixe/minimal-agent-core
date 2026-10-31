/**
 * Public re-export shim for `@minimal-agent/core/host/model-label`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/model-label.ts`: the compact
 * `<shortCode>-<versionToken>` model label used in dense UI.
 *
 * @module host-public/model-label
 */

export * from "../llm/model-label.ts"

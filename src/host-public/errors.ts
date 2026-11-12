/**
 * Public re-export shim for `@minimal-agent/core/errors`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here. The real module is `../errors/index.ts`: typed errors that hold no
 * text, `invariant()`, and the error renderer registry.
 *
 * @module host-public/errors
 */

export * from "../errors/index.ts"

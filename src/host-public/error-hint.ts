/**
 * Public re-export shim for `@minimal-agent/core/host/error-hint`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../llm/error-hint.ts`: the duck-typed
 * `hint`/`code` readers over the provider error hint channel.
 *
 * @module host-public/error-hint
 */

export * from "../llm/error-hint.ts"

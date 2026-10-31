/**
 * Public re-export shim for `@minimal-agent/core/host/model-error`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Pure pattern matchers (`parseModelNotFoundError`,
 * `parseContextLengthExceededError`, `contextLengthExceededAdvice`, …) any
 * host surfacing provider errors wants verbatim. See
 * `../host/model-error.ts` for the full contract.
 *
 * @module host-public/model-error
 */

export * from "../host/model-error.ts"

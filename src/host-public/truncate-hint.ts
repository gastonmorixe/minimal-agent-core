/**
 * Public re-export shim for `@minimal-agent/core/host/truncate-hint`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * Pure, zero-dependency text helpers (`truncHint`, `clampWithHint`) for the
 * canonical "content was elided" visual marker. See
 * `../utils/truncate-hint.ts` for the full contract.
 *
 * @module host-public/truncate-hint
 */

export * from "../utils/truncate-hint.ts"

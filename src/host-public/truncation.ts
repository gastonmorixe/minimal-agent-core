/**
 * Public re-export shim for `@minimal-agent/core/host/truncation`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives
 * here.
 *
 * `countLines` / `clampToolOutputLines` / `TruncationInfo` — the exact
 * byte/line clamp math the engine applies to tool output, needed by any
 * host that must render truncation notices consistently with what was
 * actually sent to the model. See `../tools/truncation.ts` for the full
 * contract.
 *
 * @module host-public/truncation
 */

export * from "../tools/truncation.ts"

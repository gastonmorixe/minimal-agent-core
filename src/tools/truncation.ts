/**
 * Universal tool-output guardrail.
 *
 * Every tool result passes through {@link truncateToolOutput} as the very
 * last step in `executeTool` (in `../tools.ts`). The clamp enforces
 * one byte budget and one line budget — whichever is hit first wins —
 * and appends a single-line, machine-readable notice the model can use to
 * decide a follow-up call without guessing.
 *
 * Notice shape (one line):
 *
 *   [truncated: shown <N> of <M> bytes, <sL>/<tL> lines; cut at byte <B>, line <L>. <hint>]
 *
 * `<M>` and `<tL>` are `unknown` when the source size is genuinely unknown
 * (e.g. a streamed Bash spawn we killed mid-output).
 *
 * The public surface of this module (re-exported by
 * `host-public/truncation.ts`) is the same as at a38c86b. The clamp engine
 * and its core-internal parts API live in `./truncation-parts.ts` (W2 U1b,
 * review W4).
 */

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"

import {
  clampLinesCounted,
  joinTruncationParts,
  MAX_TOOL_OUTPUT_LINE_CHARS,
  sliceUtf8,
  type TruncateCtx,
  type TruncationInfo,
  truncateToolOutputParts,
} from "./truncation-parts.ts"

export {
  countLines,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINE_CHARS,
  MAX_TOOL_OUTPUT_LINES,
  type TruncateCtx,
  type TruncationInfo,
} from "./truncation-parts.ts"

/**
 * Hard ceiling on the pre-clamp body persisted for the blob store (`_raw`).
 * Truncation still fires against the full in-memory body when a tool
 * produced one, but we refuse to keep multi-MB "recovery" blobs for a
 * single call (Adrian 2026-08-05: 7.2 MB webpack line).
 */
export const MAX_TOOL_RAW_BYTES = 256_000

/**
 * Clip every newline-delimited segment longer than `maxChars`, appending
 * a short `...(+Nch)` marker so the model can see that a mega-line was
 * shortened. `maxChars` and N are in UTF-16 units: the cap is about
 * `maxChars` and the clamp never splits a surrogate pair. Allocation-conscious: the common under-budget case (whole
 * body shorter than `maxChars`) is a single length check and returns the
 * input byte-identical.
 */
export function clampToolOutputLines(
  output: string,
  maxChars: number = MAX_TOOL_OUTPUT_LINE_CHARS,
): { text: string; clamped: boolean } {
  const { text, longLines } = clampLinesCounted(output, maxChars)
  return { text, clamped: longLines > 0 }
}

/**
 * Cap a pre-clamp body destined for the blob store. UTF-8 safe.
 * Returns the input unchanged when already under budget.
 */
export function clampToolRaw(raw: string, maxBytes: number = MAX_TOOL_RAW_BYTES): string {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw
  return sliceUtf8(raw, maxBytes)
}

/**
 * Applies the universal tool-output guardrail: clamps a body that exceeds
 * the per-line, byte, or line cap (cutting on a UTF-8 boundary), appends a
 * structured truncation notice, and reports the original totals either way
 * so the TUI can show size stats. Untruncated bodies pass through
 * byte-identical. Joins the parts of the core clamp engine
 * (`truncateToolOutputParts` in `./truncation-parts.ts`).
 */
export function truncateToolOutput(
  output: string,
  ctx: TruncateCtx = {},
  text: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT,
): { content: string; info: TruncationInfo } {
  const parts = truncateToolOutputParts(output, ctx, text)
  // A mutable copy: the caller owns it, the parts keep their frozen copy.
  return { content: joinTruncationParts(parts), info: { ...parts.info } }
}

// IMPORTANT: Never redact session IDs. Pattern-based (any `…session-id`/
// `session_id`/`sessionId` variant) so provider-specific header names —
// e.g. a vendor's `x-<vendor>-session-id` — are covered without naming
// any provider in core.
const SESSION_ID_KEY_RE = /session[-_]?id/i

/** True for every metadata key except session-id variants, which must stay visible for debugging. */
export function shouldRedact(key: string): boolean {
  return !SESSION_ID_KEY_RE.test(key)
}

/**
 * Anthropic-specific preflight: detect thinking-block signatures that
 * were produced by a different model than the one the request targets,
 * and build the human-facing {@link PreflightIssue} so the agent can
 * surface it to the user.
 *
 * # The bug this fixes
 *
 * Anthropic thinking blocks carry a cryptographic `signature` bound to
 * the model that produced them. When a session is forked across model
 * boundaries (e.g. parent ran on `claude-opus-4-7`, child resumes on
 * `claude-opus-4-8`), the inherited thinking blocks reach the new
 * model's verifier and fail with:
 *
 *     messages.<i>.content.<j>: `thinking` or `redacted_thinking`
 *     blocks in the latest assistant message cannot be modified.
 *
 * The fix is two-fold:
 *
 *  1. Detect the mismatch BEFORE we send (this module), so the user
 *     never hits the wall.
 *  2. Offer two clean resolutions: (a) strip stale thinking blocks
 *     and continue with the current model, (b) switch the agent back
 *     to the model that produced the blocks, OR (c) cancel.
 *
 * # Pure / decoupled
 *
 * Both `findThinkingMismatches()` and the resolution helpers are pure
 * functions: they take a {@link CanonicalRequest} + a target model id
 * and return data. The adapter wires them into the provider port
 * (`preflight` + `applyResolution`) in `./adapter.ts`. The agent never
 * imports anything from this module.
 *
 * @module llm/providers/anthropic/thinking-preflight
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
} from "@minimal-agent/plugin-api/llm/canonical-messages"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import type { PreflightIssue, PreflightOption } from "../../src/llm/provider.ts"

import { extractModelFromSignature } from "./signature-model.ts"

// ---------------------------------------------------------------------------
// Issue code (stable, public)
// ---------------------------------------------------------------------------

/**
 * Stable code identifying the "thinking blocks signed by a different
 * model" issue. Exported so test code and host telemetry can pattern-
 * match without re-deriving the string.
 */
export const ISSUE_THINKING_MODEL_MISMATCH = "anthropic.thinking-model-mismatch"

/**
 * Option ids exposed on the mismatch issue. The `switch:<modelId>` form
 * encodes which model to fall back to (we recommend the OLDEST model
 * that signed any of the stale blocks, so the resume continues from
 * the most-coherent context).
 */
export const OPTION_STRIP = "strip"
export const OPTION_CANCEL = "cancel"
export const OPTION_SWITCH_PREFIX = "switch:"

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * One thinking block whose signature was bound to a model other than
 * the request's `modelId`. Carries enough information for the adapter
 * to surface a useful message AND for tests to assert on shape.
 */
export interface ThinkingMismatch {
  /** Index in `req.messages`. */
  messageIndex: number
  /** Index in the assistant message's content array. */
  blockIndex: number
  /** Model id decoded from the signature (e.g. `"claude-opus-4-7"`). */
  signedByModel: string
}

/**
 * Walk every `thinking` block in `messages` and return the ones whose
 * signature decodes to a model id other than `targetModelId`. Blocks
 * with no signature OR with a signature that can't be decoded are
 * ignored (we can't prove they're wrong; let the server decide).
 *
 * Pure / synchronous. O(B) where B is the total number of thinking
 * blocks in the request.
 */
export function findThinkingMismatches(
  messages: CanonicalMessage[],
  targetModelId: string,
): ThinkingMismatch[] {
  const target = normalizeModelId(targetModelId)
  const out: ThinkingMismatch[] = []
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi]
    if (!m || m.role !== "assistant") continue
    const content = m.content
    if (!Array.isArray(content)) continue
    for (let bi = 0; bi < content.length; bi++) {
      const b = content[bi]
      if (!b || b.type !== "thinking") continue
      const sig = b.signature
      if (!sig) continue
      const signedBy = extractModelFromSignature(sig)
      if (!signedBy) continue
      if (normalizeModelId(signedBy) === target) continue
      out.push({ messageIndex: mi, blockIndex: bi, signedByModel: signedBy })
    }
  }
  return out
}

/**
 * Strip Anthropic-style `[1m]` / `[2m]` context-window suffixes so
 * `claude-opus-4-7[1m]` and `claude-opus-4-7` compare equal. The
 * signature only ever stores the base id.
 */
export function normalizeModelId(modelId: string): string {
  return modelId.replace(/\[(1|2)m\]/gi, "")
}

// ---------------------------------------------------------------------------
// Issue construction
// ---------------------------------------------------------------------------

/**
 * Build the human-facing {@link PreflightIssue} for a non-empty
 * mismatch list. Caller is expected to have called
 * {@link findThinkingMismatches} first and only invoke this when the
 * list is non-empty.
 *
 * The options are:
 *  - one `strip` (default, destructive — loses prior reasoning context)
 *  - one `switch:<modelId>` for EACH distinct model that signed stale
 *    blocks (most-common first, so the user's likely fallback is on
 *    the left)
 *  - one `cancel`
 */
export function buildMismatchIssue(
  mismatches: ThinkingMismatch[],
  targetModelId: string,
): PreflightIssue {
  if (mismatches.length === 0) {
    throw new Error("buildMismatchIssue: mismatches must be non-empty")
  }
  const targetBase = normalizeModelId(targetModelId)
  const counts = new Map<string, number>()
  for (const m of mismatches) {
    const k = normalizeModelId(m.signedByModel)
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const orderedSigners = [...counts.entries()].sort((a, b) => b[1] - a[1])

  const detail = buildDetailParagraph(targetBase, orderedSigners)

  const options: PreflightOption[] = []
  options.push({
    id: OPTION_STRIP,
    label: `Strip stale thinking, continue with ${targetBase}`,
    description:
      "Remove the mismatched thinking blocks and send. " +
      "The model loses its prior reasoning context but the conversation continues.",
    destructive: true,
    isDefault: true,
  })
  for (const [signer] of orderedSigners) {
    options.push({
      id: `${OPTION_SWITCH_PREFIX}${signer}`,
      label: `Switch back to ${signer}`,
      description:
        `Keep all thinking blocks intact; this and future turns use ${signer} ` +
        `instead of ${targetBase} until you change models again.`,
    })
  }
  options.push({
    id: OPTION_CANCEL,
    label: "Cancel",
    description: "Abort this send. The conversation stays where it is; nothing is modified.",
  })

  return {
    code: ISSUE_THINKING_MODEL_MISMATCH,
    title: "Conversation has thinking blocks from a different model",
    detail,
    options,
  }
}

function buildDetailParagraph(targetBase: string, signers: Array<[string, number]>): string {
  const signerSummary =
    signers.length === 1
      ? `${signers[0]?.[0]} (${signers[0]?.[1]} blocks)`
      : signers.map(([id, n]) => `${id} (${n})`).join(", ")
  return (
    `This conversation contains thinking blocks signed by ${signerSummary} ` +
    `but the current request targets ${targetBase}. Anthropic verifies each ` +
    `thinking-block signature against the request's model, so the API will ` +
    `reject the request with a 400 unless we either drop the stale blocks or ` +
    `switch back to the original model.\n` +
    `This usually happens after a session was forked or resumed with a different --model.`
  )
}

// ---------------------------------------------------------------------------
// Resolution helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Return a new messages array with all `thinking` and
 * `redacted_thinking` blocks removed from every assistant message.
 * Other blocks (text, tool_use, tool_result, image, …) are preserved
 * in their original order.
 *
 * Assistant messages that become EMPTY after stripping are kept with
 * an empty content array, because dropping them entirely would break
 * the user/assistant alternation the API requires.
 */
export function stripThinkingBlocks(messages: CanonicalMessage[]): CanonicalMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m
    const filtered = m.content.filter((b) => !isThinkingLike(b))
    if (filtered.length === m.content.length) return m
    return { ...m, content: filtered }
  })
}

function isThinkingLike(b: CanonicalBlock): boolean {
  return b.type === "thinking"
}

// ---------------------------------------------------------------------------
// Top-level applyResolution helper (called from adapter.applyResolution)
// ---------------------------------------------------------------------------

/**
 * Outcome of {@link applyMismatchResolution} so the adapter can
 * translate it to a {@link PreflightResolution} without re-doing the
 * dispatch. The adapter glue is the only file that knows about the
 * canonical resolution shape; this module stays pure.
 */
export type MismatchResolutionOutcome =
  | {
      kind: "modify-request"
      messages: CanonicalMessage[]
      /** Present when the user picked a `switch:<model>` option. */
      adoptModelId?: string
    }
  | { kind: "cancel" }
  | { kind: "unknown-option"; optionId: string }

/**
 * Apply the user's choice on a mismatch issue:
 *  - `OPTION_STRIP` → strip thinking blocks, keep the same model
 *  - `OPTION_SWITCH_PREFIX + <modelId>` → keep messages, adopt the
 *    decoded model id
 *  - `OPTION_CANCEL` → cancel
 *  - anything else → `kind:"unknown-option"` so the adapter can decide
 *    what to do (typically throw)
 */
export function applyMismatchResolution(
  req: CanonicalRequest,
  optionId: string,
): MismatchResolutionOutcome {
  if (optionId === OPTION_STRIP) {
    return {
      kind: "modify-request",
      messages: stripThinkingBlocks(req.messages),
    }
  }
  if (optionId === OPTION_CANCEL) {
    return { kind: "cancel" }
  }
  if (optionId.startsWith(OPTION_SWITCH_PREFIX)) {
    const modelId = optionId.slice(OPTION_SWITCH_PREFIX.length)
    if (!modelId) return { kind: "unknown-option", optionId }
    return {
      kind: "modify-request",
      messages: req.messages,
      adoptModelId: modelId,
    }
  }
  return { kind: "unknown-option", optionId }
}

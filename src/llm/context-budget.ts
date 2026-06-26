/**
 * Context-budget helpers - keep `input_tokens + max_output_tokens` inside
 * the model's context window.
 *
 * Why this exists: the OpenAI **Responses** API validates
 * `input_tokens + max_output_tokens <= context_window` and rejects an
 * over-budget request with `context_length_exceeded`. The agent requests
 * the model's FULL registered `maxOutputTokens` on every turn (see
 * `Agent.resolveMaxOutputTokens`), which is correct on Anthropic (where
 * `max_tokens` is an output budget on top of the input window) but wrong
 * on OpenAI once the transcript grows: a 1.0M-token history on gpt-5.5
 * (1.05M window, 128k output) reserves 128k output and trips
 * `1.0M + 128k > 1.05M`, even though the input alone fits.
 *
 * The fix is to clamp the requested output budget to the room actually
 * left in the window, with a small safety margin to absorb the slop in
 * our token estimate. Both functions here are PURE (functional core): no
 * registry I/O, no network. The registry-bound estimator
 * (`estimateTokensForModel`) is injected via the model id only.
 *
 * @module llm/context-budget
 */

import type { SystemBlock } from "../headers.ts"

import type { ContentBlock, Message } from "./messages.ts"
import { estimateTokensForModel, type TokenEstimator } from "./token-estimate.ts"

/**
 * Floor for the clamped output budget. Even on a near-full window we
 * still ask for at least this many output tokens so the model can emit a
 * short message (e.g. "I'm out of context, compact the history"). The
 * request may still be rejected if the input genuinely exceeds the
 * window, but that is a different, honest failure than a self-inflicted
 * over-reservation.
 */
export const MIN_OUTPUT_TOKENS = 1_024

/**
 * Default tokens held back from the available room when no explicit
 * margin is given. Our input estimate is approximate (char-ratio, not a
 * real tokenizer), so we leave a cushion to avoid clamping to a value
 * that is itself slightly over budget.
 */
export const DEFAULT_OUTPUT_SAFETY_MARGIN = 4_096

/** Inputs to {@link clampMaxOutputTokens}. */
export interface ClampMaxOutputTokensInput {
  /** The model's registered `maxOutputTokens` ceiling. */
  modelMax: number
  /**
   * The model's context window. `0` / `undefined` means "unknown", in
   * which case the clamp is a no-op (we trust the caller's `modelMax`).
   */
  contextWindow: number | undefined
  /** Estimated tokens the outgoing request already carries. */
  inputTokens: number
  /** Tokens to hold back. Defaults to {@link DEFAULT_OUTPUT_SAFETY_MARGIN}. */
  safetyMargin?: number
}

/**
 * Clamp a requested output-token budget to what fits in the context
 * window after accounting for the input already in the request.
 *
 * Returns `modelMax` unchanged when the window is unknown or when there
 * is plenty of room. When the window is tight, returns the remaining
 * room (window − input − margin), never below {@link MIN_OUTPUT_TOKENS}
 * and never above `modelMax`. Always an integer.
 */
export function clampMaxOutputTokens(input: ClampMaxOutputTokensInput): number {
  const { modelMax, contextWindow, inputTokens } = input
  const safetyMargin = input.safetyMargin ?? DEFAULT_OUTPUT_SAFETY_MARGIN

  // Unknown window → trust the model max (matches pre-clamp behavior).
  if (!contextWindow || contextWindow <= 0) return modelMax

  const available = Math.floor(contextWindow - inputTokens - safetyMargin)

  // Already over (or at) the window: ask for the floor and let the
  // request fail honestly if the input itself doesn't fit.
  if (available < MIN_OUTPUT_TOKENS) return MIN_OUTPUT_TOKENS

  // Never exceed the model's own ceiling; never go below the floor.
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(modelMax, available))
}

/** A tool definition shape sufficient for size estimation. */
export interface EstimableTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Inputs to {@link estimateRequestInputTokens}. */
export interface EstimateRequestInputTokensInput {
  /** Canonical / alias model id for the per-model estimator. */
  modelId: string | undefined
  /**
   * Optional estimator override. Pass the resolved `ModelEntry.estimateTokens`
   * when the caller already resolved the provider-scoped model entry, so a
   * duplicate id registered by another provider cannot steal the estimator.
   */
  estimateTokens?: TokenEstimator
  /** Conversation history (legacy `client.ts` message shape). */
  messages: Message[]
  /** Top-level system prompt blocks. */
  system?: SystemBlock[]
  /** Tool definitions advertised to the model. */
  tools?: EstimableTool[]
}

/**
 * Estimate the token footprint of an outgoing request: system prompt +
 * every message's content + tool schemas. Intentionally approximate and
 * conservative (it would rather over-count than under-count, so the
 * clamp leaves more headroom). Uses the model's registered estimator
 * when available, else the default char-ratio.
 */
export function estimateRequestInputTokens(input: EstimateRequestInputTokensInput): number {
  const { estimateTokens, modelId, messages, system, tools } = input
  let chars = 0

  if (system) {
    for (const block of system) {
      if (block.type === "text") chars += block.text.length
    }
  }

  for (const msg of messages) {
    chars += messageContentChars(msg.content)
  }

  if (tools) {
    for (const tool of tools) {
      chars += tool.name.length + tool.description.length
      chars += safeJsonLength(tool.input_schema)
    }
  }

  if (chars === 0) return 0
  // Estimate on a single synthesized string so a per-model estimator
  // (char-ratio) applies uniformly. We pass a string of the measured
  // length rather than concatenating real content to avoid building a
  // multi-megabyte string just to count it.
  const measuredText = " ".repeat(chars)
  return estimateTokens
    ? estimateTokens(measuredText)
    : estimateTokensForModel(modelId, measuredText)
}

/** Sum the character length of one message's content. */
function messageContentChars(content: string | ContentBlock[]): number {
  if (typeof content === "string") return content.length
  let chars = 0
  for (const block of content) {
    chars += blockChars(block)
  }
  return chars
}

/** Character length contributed by a single content block. */
function blockChars(block: ContentBlock): number {
  switch (block.type) {
    case "text":
      return block.text.length
    case "thinking":
      // Thinking text is re-sent to the same provider and occupies the
      // window, so it counts. The signature is small; ignore it.
      return block.thinking.length
    case "tool_use":
      return block.name.length + safeJsonLength(block.input)
    case "tool_result":
      return typeof block.content === "string"
        ? block.content.length
        : block.content.reduce((sum, b) => sum + blockChars(b), 0)
    default:
      // image / document / redacted_thinking: opaque or media payloads.
      // We don't size base64 bytes here (the clamp's margin absorbs the
      // slop); count nothing rather than guess wildly.
      return 0
  }
}

/** JSON.stringify length, defensively returning 0 on a cyclic value. */
function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return 0
  }
}

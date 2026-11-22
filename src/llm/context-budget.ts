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
 * our token estimate. The clamp is PURE (functional core). The input
 * estimate reads the model registry only through `lookupTokenEstimator`
 * (or takes the estimator as a parameter). Core has no chars-per-token
 * ratio: with no estimator it uses the UTF-8 byte upper bound.
 *
 * @module llm/context-budget
 */

import type { ContentBlock, Message } from "./messages.ts"
import { lookupTokenEstimator, type TokenEstimator } from "./token-estimate.ts"
import type { SystemBlock } from "./transport/types.ts"

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
 * margin is given. Our input estimate is approximate (a provider
 * heuristic, not a real tokenizer), so we leave a cushion to avoid clamping to a value
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

/**
 * A tool definition shape sufficient for size estimation. `input_schema` is
 * `unknown` (as on the wire `SendOptions.tools`): the estimate only
 * serializes it (`safeJson`).
 */
export interface EstimableTool {
  name: string
  description?: string
  input_schema: unknown
}

/** Inputs to {@link estimateRequestInputTokens}. */
export interface EstimateRequestInputTokensInput {
  /** Canonical / alias model id for the per-model estimator lookup. */
  modelId: string | undefined
  /** Provider scope for the estimator lookup (see `lookupTokenEstimator`). */
  providerId?: string
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
 * every message's content + tool schemas.
 *
 * - With an estimator (the override, else
 *   `lookupTokenEstimator(modelId, providerId)`): the sum of the estimator on each text part. The parts are
 *   estimated one at a time, so no large joined string is built.
 * - With NO estimator: the UTF-8 byte count of the same parts. Core has no
 *   chars-per-token ratio. The byte count is a ratio-free UPPER BOUND of the
 *   token count: a byte-level BPE (GPT-2, o200k, Llama 3 and most modern
 *   tokenizers) and a SentencePiece tokenizer with byte fallback never make
 *   a token that covers less than one byte, so tokens are at most bytes. The few
 *   framing tokens for each message are far below the over-count (prose is
 *   about 3-4 bytes for each token) and the clamp safety margin. The bound
 *   over-counts, so the clamp gives a SMALLER `max_tokens`, never a context
 *   overflow.
 *
 * Media blocks (image, document) count 0 (see `blockText`).
 */
export function estimateRequestInputTokens(input: EstimateRequestInputTokensInput): number {
  const { messages, system, tools } = input
  const estimator = input.estimateTokens ?? lookupTokenEstimator(input.modelId, input.providerId)
  const measure: (text: string) => number = estimator ?? utf8ByteLength
  let total = 0
  const add = (text: string): void => {
    if (text.length > 0) total += measure(text)
  }

  if (system) {
    for (const block of system) {
      if (block.type === "text") add(block.text)
    }
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") add(msg.content)
    else for (const block of msg.content) addBlock(block, add)
  }

  if (tools) {
    for (const tool of tools) {
      add(tool.name)
      add(tool.description ?? "")
      add(safeJson(tool.input_schema))
    }
  }

  return total
}

/** UTF-8 byte count of `text` (no allocation). The no-estimator upper bound. */
export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8")
}

/** Pass the text of one content block to `add`. */
function addBlock(block: ContentBlock, add: (text: string) => void): void {
  switch (block.type) {
    case "text":
      add(block.text)
      return
    case "thinking":
      // Thinking text is re-sent to the same provider and occupies the
      // window, so it counts. The signature is small; ignore it.
      add(block.thinking)
      return
    case "tool_use":
      add(block.name)
      add(safeJson(block.input))
      return
    case "tool_result":
      if (typeof block.content === "string") add(block.content)
      else for (const b of block.content) addBlock(b, add)
      return
    default:
      // image / document / redacted_thinking: opaque or media payloads.
      // We don't size base64 bytes here (the clamp's margin absorbs the
      // slop); count nothing rather than guess wildly.
      return
  }
}

/** JSON.stringify text, defensively `""` on a cyclic value. */
function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return ""
  }
}

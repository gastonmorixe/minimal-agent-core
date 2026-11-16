/**
 * The synthetic messages of a continuation round (stop-table rows 3 and 5:
 * a `max_tokens` or interrupted response with no tool call).
 *
 * Core holds no text. In bare core the resolver answers "" for
 * `assistant.placeholder` and `continue.*`. An empty text block is invalid
 * on some providers (Anthropic: "text content blocks must be non-empty"), so
 * an empty text adds no block, and a message with no block is not added.
 *
 * @module sdk/continuation
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { continueText, placeholderText } from "../agent/synthetic-texts.ts"
import type { ContentBlock } from "../llm/messages.ts"

/** What a continuation round appends to the history. */
export type ContinuationPlan =
  | {
      kind: "continue"
      /** Assistant placeholder content, or `null` for no assistant message. */
      placeholder: ContentBlock[] | null
      /** User nudge content. */
      nudge: ContentBlock[]
    }
  /**
   * The nudge has no text. With no user message the history ends on the
   * assistant (a prefill, which some models reject with a 400) or, after an
   * empty response, re-sends the same request. The turn ends as truncated.
   */
  | { kind: "stop" }

/** One text block, or `null` when `text` is empty. */
function textContent(text: string): ContentBlock[] | null {
  return text ? [{ type: "text", text }] : null
}

/**
 * Plan the continuation messages. `responseEmpty`: the response had no
 * blocks, so the history holds no assistant message for it. An empty
 * placeholder adds no assistant message: the nudge then follows the last
 * user message, and the provider joins the two user turns.
 */
export function planContinuation(
  resolver: SyntheticTextResolver,
  maxTokens: boolean,
  responseEmpty: boolean,
): ContinuationPlan {
  const nudge = textContent(continueText(resolver, maxTokens))
  if (nudge === null) return { kind: "stop" }
  const placeholder = responseEmpty ? textContent(placeholderText(resolver)) : null
  return { kind: "continue", placeholder, nudge }
}

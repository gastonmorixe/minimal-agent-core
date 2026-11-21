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
import { continueText, MARKER_KIND, placeholderText } from "../agent/synthetic-texts.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ContentBlock } from "../llm/messages.ts"

import { MAX_INTERRUPTED_TURN_CONTINUATIONS, MAX_TOKENS_CONTINUATION_CAP } from "./stop-policy.ts"

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
   * A needed text is empty, so the round has no valid new body. The turn
   * ends as truncated. `missing`:
   * - `"continue"`: the nudge has no text. With no user message the history
   *   ends on the assistant (a prefill, which some models reject with a 400)
   *   or, after an empty response, re-sends the same request.
   * - `"placeholder"`: the response was empty and the placeholder has no
   *   text. The nudge would follow the last user message (two user turns in
   *   a row). Anthropic joins them, but OpenAI-compatible backends that apply
   *   a chat template (vLLM, some HF templates) reject a request whose roles
   *   do not alternate. So core does not send it.
   */
  | { kind: "stop"; missing: "continue" | "placeholder" }

/**
 * One text block, or `null` when `text` is empty. `kind`: the block mark of
 * harness text (design step 12c); the nudge has it, the placeholder (an
 * assistant text with no tag) does not.
 */
function textContent(text: string, kind?: string): ContentBlock[] | null {
  if (!text) return null
  return [kind === undefined ? { type: "text", text } : { type: "text", text, sideband: { kind } }]
}

/**
 * Plan the continuation messages. `responseEmpty`: the response had no
 * blocks, so the history holds no assistant message for it, and the round
 * needs a placeholder to keep the roles alternating. With a partial response
 * the reply itself is the assistant message (`placeholder` is `null`).
 */
export function planContinuation(
  resolver: SyntheticTextResolver,
  maxTokens: boolean,
  responseEmpty: boolean,
): ContinuationPlan {
  const nudgeKind = maxTokens ? MARKER_KIND.maxTokensContinue : MARKER_KIND.streamInterrupted
  const nudge = textContent(continueText(resolver, maxTokens), nudgeKind)
  if (nudge === null) return { kind: "stop", missing: "continue" }
  if (!responseEmpty) return { kind: "continue", placeholder: null, nudge }
  const placeholder = textContent(placeholderText(resolver))
  if (placeholder === null) return { kind: "stop", missing: "placeholder" }
  return { kind: "continue", placeholder, nudge }
}

/**
 * Record why a continuation round ended the turn (warning
 * `continuation.no_text`). The cap stop emits a TurnNotice; this stop has no
 * notice (the turn does not continue), so the diagnostic is what tells it
 * apart from the cap.
 */
export function noteContinuationStop(
  diagnostics: Diagnostics,
  plan: { missing: "continue" | "placeholder" },
  maxTokens: boolean,
): void {
  diagnostics.warn("continuation.no_text", "", {
    reason: maxTokens ? "max_tokens" : "stream_interrupted",
    missing: plan.missing,
  })
}

/** The notice when a D20 streak cap ends the turn (rows 4 and 6). */
export function cappedNotice(maxTokens: boolean): TurnNotice {
  return maxTokens
    ? { kind: "max_tokens_capped", severity: "warn", cap: MAX_TOKENS_CONTINUATION_CAP }
    : {
        kind: "stream_interrupted_capped",
        severity: "warn",
        cap: MAX_INTERRUPTED_TURN_CONTINUATIONS,
      }
}

/** The notice of one continuation round (rows 3 and 5). */
export function continuingNotice(maxTokens: boolean, attempt: number): TurnNotice {
  return {
    kind: maxTokens ? "max_tokens_continuing" : "stream_interrupted_continuing",
    severity: "warn",
    attempt,
    cap: maxTokens ? MAX_TOKENS_CONTINUATION_CAP : MAX_INTERRUPTED_TURN_CONTINUATIONS,
  }
}

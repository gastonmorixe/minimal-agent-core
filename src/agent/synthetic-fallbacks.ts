/**
 * Warn-mode fallbacks for the AgentCore-owned synthetic kinds (G3).
 *
 * Each helper asks the resolver and passes today's text as the fallback, so
 * the bytes stay equal when no provider owns the kind. `resolver` is
 * optional on the runtime helpers: omitted, no provider, the fallback text.
 * This file leaves core in S3.3, when the call sites end the turn instead.
 *
 * @module agent/synthetic-fallbacks
 */

import {
  outputTruncatedAttachmentText,
  reflectionCheckpointAttachmentText,
  responseTruncatedPlaceholderText,
  sessionResumedAttachmentText,
  streamInterruptedAttachmentText,
  streamInterruptedContinueAttachmentText,
  toolCallInterruptedByStopResult,
  toolExecutionAbortedBeforeCompletionResult,
  turnAbortedAttachmentText,
} from "./PROMPTS.ts"
import { FALLBACK_SYNTHETIC_TEXT, type SyntheticTextResolver } from "./synthetic-text.ts"

/** Text of the assistant placeholder when a response has no blocks. */
export function placeholderText(resolver: SyntheticTextResolver): string {
  return resolver.resolve("assistant.placeholder", {}, responseTruncatedPlaceholderText)
}

/** Text of the continue nudge after a max_tokens or interrupted response. */
export function continueText(resolver: SyntheticTextResolver, maxTokens: boolean): string {
  return maxTokens
    ? resolver.resolve("continue.max_tokens", {}, outputTruncatedAttachmentText)
    : resolver.resolve("continue.stream_interrupted", {}, streamInterruptedContinueAttachmentText)
}

/** `runtime.turn_aborted`: the marker after a turn the user aborted. */
export function turnAbortedText(resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT): string {
  return resolver.resolve("runtime.turn_aborted", {}, turnAbortedAttachmentText)
}

/** `runtime.session_resumed`: the marker after a resume with incomplete work. */
export function sessionResumedText(
  resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("runtime.session_resumed", {}, sessionResumedAttachmentText)
}

/** `runtime.stream_interrupted`: the attachment after salvaged tool calls. */
export function streamInterruptedText(
  resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("runtime.stream_interrupted", {}, streamInterruptedAttachmentText)
}

/** `runtime.reflection_checkpoint` with facts `round` and `cooldownSec`. */
export function reflectionCheckpointText(
  round: number,
  cooldownSec: number,
  resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("runtime.reflection_checkpoint", { round, cooldownSec }, () =>
    reflectionCheckpointAttachmentText(round, cooldownSec),
  )
}

/** `tool_result.aborted` with `site: "orphan"`: an orphan tool_use closed on the next turn. */
export function orphanAbortedText(
  resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): string {
  return resolver.resolve(
    "tool_result.aborted",
    { site: "orphan" },
    toolExecutionAbortedBeforeCompletionResult,
  )
}

/** `tool_result.interrupted_by_stop`: a tool call a kill cut off (decision 31). */
export function interruptedByStopText(
  resolver: SyntheticTextResolver = FALLBACK_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("tool_result.interrupted_by_stop", {}, toolCallInterruptedByStopResult)
}

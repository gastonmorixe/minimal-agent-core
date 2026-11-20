/**
 * Resolver helpers for the AgentCore-owned synthetic kinds (G3).
 *
 * Each helper asks the resolver for one kind with its facts. Core holds no
 * text: with no provider the result is "" (bare core). `resolver` is
 * optional on the runtime helpers: omitted, no provider, "".
 *
 * @module agent/synthetic-texts
 */

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "./synthetic-text.ts"

/** Text of the assistant placeholder when a response has no blocks. */
export function placeholderText(resolver: SyntheticTextResolver): string {
  return resolver.resolve("assistant.placeholder", {})
}

/** Text of the continue nudge after a max_tokens or interrupted response. */
export function continueText(resolver: SyntheticTextResolver, maxTokens: boolean): string {
  return maxTokens
    ? resolver.resolve("continue.max_tokens", {})
    : resolver.resolve("continue.stream_interrupted", {})
}

/** `runtime.turn_aborted`: the marker after a turn the user aborted. */
export function turnAbortedText(resolver: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT): string {
  return resolver.resolve("runtime.turn_aborted", {})
}

/** `runtime.session_resumed`: the marker after a resume with incomplete work. */
export function sessionResumedText(resolver: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT): string {
  return resolver.resolve("runtime.session_resumed", {})
}

/** `runtime.stream_interrupted`: the attachment after salvaged tool calls. */
export function streamInterruptedText(
  resolver: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("runtime.stream_interrupted", {})
}

/** `tool_result.aborted` with `site: "orphan"`: an orphan tool_use closed on the next turn. */
export function orphanAbortedText(resolver: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT): string {
  return resolver.resolve("tool_result.aborted", { site: "orphan" })
}

/** `tool_result.interrupted_by_stop`: a tool call a kill cut off (decision 31). */
export function interruptedByStopText(
  resolver: SyntheticTextResolver = EMPTY_SYNTHETIC_TEXT,
): string {
  return resolver.resolve("tool_result.interrupted_by_stop", {})
}

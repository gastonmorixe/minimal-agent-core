/**
 * Warn-mode fallbacks for the AgentCore-owned synthetic kinds (G3).
 *
 * Each helper asks the resolver and passes today's text as the fallback. This
 * file leaves core in S3.3, when the call sites end the turn instead.
 *
 * @module agent/synthetic-fallbacks
 */

import {
  outputTruncatedAttachmentText,
  responseTruncatedPlaceholderText,
  streamInterruptedContinueAttachmentText,
} from "./PROMPTS.ts"
import type { SyntheticTextResolver } from "./synthetic-text.ts"

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

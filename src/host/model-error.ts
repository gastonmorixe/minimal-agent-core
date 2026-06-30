/**
 * Model-availability error parsing.
 *
 * Split out of `src/agent.ts` to keep that file under the
 * `max-lines` lint budget. The two `parseModel...Error` predicates are
 * re-exported from `agent.ts` for back-compat.
 *
 * @module agent/model-error
 */

/**
 * Extracts the offending model id from an API `not_found_error` payload, or
 * `null` when the message is some other kind of error. The id is what the
 * recovery flow shows in the "model not available" picker.
 */
export function parseModelNotFoundError(message: string): string | null {
  if (!message.includes("not_found_error")) return null
  const match = message.match(/"message"\s*:\s*"model:\s*([^"]+)"/)
  return match ? match[1] : null
}

/**
 * Detect API errors that don't say "model not found" but still mean the
 * current model selection won't work for this account : e.g. picking a
 * `[1m]` variant on a subscription without long-context access:
 *
 * ```text
 * API 400: {"type":"error","error":{"type":"invalid_request_error",
 *  "message":"The long context beta is not yet available for this subscription."},...}
 * ```
 *
 * Returns the current model id (so the caller can re-open the picker), or
 * null if the error is unrelated to model selection.
 */
export function parseModelUnavailableError(
  message: string,
  currentModel: string | undefined,
): string | null {
  if (!currentModel) return null
  if (message.includes("long context beta is not yet available")) return currentModel
  return null
}

/**
 * Detect provider errors that mean the outgoing request exceeded the
 * model's context window. This usually happens after a long autonomous
 * loop or when resuming an already-large transcript under a smaller or
 * stricter model.
 *
 * Stateful "responses"-style APIs commonly emit a code-tagged message:
 * "context_length_exceeded - Your input exceeds the context window of
 * this model." Chat-style APIs may instead say "maximum context length"
 * or "reduce the length of the messages". The parser intentionally stays
 * broad but requires context/window wording so random network errors
 * don't match. Kept provider-neutral on purpose: matching keys off the
 * error shape, never a vendor name.
 */
export function parseContextLengthExceededError(message: string): boolean {
  const lower = message.toLowerCase()
  if (lower.includes("context_length_exceeded")) return true
  if (lower.includes("maximum context length")) return true
  if (lower.includes("context window") && lower.includes("exceed")) return true
  if (lower.includes("reduce the length") && lower.includes("message")) return true
  return false
}

/**
 * User-facing recovery guidance for context-window failures. The failed
 * user turn has already been rolled back by the caller, so the next step
 * must be to shrink or reset history. Retrying the same oversized
 * transcript will fail again.
 */
export function contextLengthExceededAdvice(currentModel: string | undefined): string {
  const modelSuffix = currentModel ? ` for ${currentModel}` : ""
  return (
    `Context window exceeded${modelSuffix}. The failed user turn was rolled back. ` +
    "Start a fresh session, compact the transcript, or prune old history before retrying. " +
    "Resuming the same oversized transcript will fail again."
  )
}

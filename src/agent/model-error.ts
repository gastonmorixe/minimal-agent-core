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

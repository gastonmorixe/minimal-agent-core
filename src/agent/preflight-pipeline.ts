/**
 * Agent-side preflight pipeline.
 *
 * The agent loop calls {@link runPreflightPipeline} just before each
 * `sendFn` invocation. The pipeline:
 *
 *  1. Translates the agent's legacy `Message[]` into a
 *     {@link CanonicalRequest} so the provider-neutral preflight wrapper
 *     can dispatch to the right adapter.
 *  2. Asks the host (`askUser`) about each issue surfaced by the
 *     provider.
 *  3. Applies the user's resolution via the provider's
 *     `applyResolution()`.
 *  4. Returns the (possibly modified) messages + model id, and a
 *     `cancelled` flag.
 *
 * This module is provider/model-free: it only knows the canonical
 * shapes and never branches on provider id. The agent only knows
 * `runPreflightPipeline` and the host-supplied `askUser` callback.
 *
 * @module agent/preflight-pipeline
 */

import { canonicalMessageToLegacy, legacyMessageToCanonical } from "../llm/adapter-legacy.ts"
import type { CanonicalMessage } from "../llm/canonical-messages.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { Message } from "../llm/messages.ts"
import { applyPreflightResolution, runPreflight } from "../llm/preflight.ts"
import type { PreflightIssue } from "../llm/provider.ts"

/**
 * Callback the host provides to gather a user choice for one preflight
 * issue. Returns the chosen option id, or `null` to cancel.
 *
 * Async: the host typically opens a TUI modal that resolves when the
 * user presses Enter / Esc.
 */
export type AskUserFn = (issue: PreflightIssue) => Promise<string | null>

/**
 * Result of the preflight pipeline. When `cancelled` is true the agent
 * MUST abort the send (typically via `AbortError`).
 *
 * `messages` and `modelId` reflect the user's choices: stripped /
 * unchanged / model swap. When the pipeline didn't run any resolution
 * (no issues), both fields are returned verbatim from the input.
 */
export interface PreflightPipelineOutcome {
  messages: Message[]
  modelId: string
  cancelled: boolean
  /** When set, the agent should adopt this model for future turns too. */
  adoptModelId?: string
}

/**
 * Translate legacy messages to canonical, run preflight, gather user
 * choices, apply resolutions, and translate back.
 *
 * The function is a no-op (returns `{messages, modelId, cancelled:false}`)
 * when the provider raises no issues. The hot path adds one canonical
 * conversion pass over `messages` per send : O(N×B) where N = messages
 * and B = avg blocks per message. For a 100-message conversation this
 * is under 1ms.
 */
export async function runPreflightPipeline(opts: {
  messages: Message[]
  modelId: string
  askUser: AskUserFn
}): Promise<PreflightPipelineOutcome> {
  const canonicalReq: CanonicalRequest = {
    modelId: opts.modelId,
    messages: opts.messages.map(legacyMessageToCanonical),
  }
  const issues = runPreflight(canonicalReq)
  if (issues.length === 0) {
    return { messages: opts.messages, modelId: opts.modelId, cancelled: false }
  }

  let curReq = canonicalReq
  let curModelId = opts.modelId
  let adoptModelId: string | undefined

  for (const issue of issues) {
    const optionId = await opts.askUser(issue)
    if (optionId === null) {
      return {
        messages: opts.messages,
        modelId: opts.modelId,
        cancelled: true,
      }
    }
    const resolution = applyPreflightResolution(curReq, issue.code, optionId)
    if (resolution.kind === "cancel") {
      return {
        messages: opts.messages,
        modelId: opts.modelId,
        cancelled: true,
      }
    }
    // Carry the modified request forward (subsequent issues, if any,
    // see the latest state).
    curReq = resolution.request
    if (resolution.adoptModelId) {
      adoptModelId = resolution.adoptModelId
      curModelId = resolution.adoptModelId
      // Also update the canonical request's modelId so any further
      // issues are evaluated against the new model. (The Anthropic
      // adapter doesn't currently raise stacked issues, but other
      // providers might.)
      curReq = { ...curReq, modelId: resolution.adoptModelId }
    }
  }

  return {
    messages: (curReq.messages as CanonicalMessage[]).map(canonicalMessageToLegacy) as Message[],
    modelId: curModelId,
    cancelled: false,
    ...(adoptModelId !== undefined ? { adoptModelId } : {}),
  }
}

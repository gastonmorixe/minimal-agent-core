/**
 * Provider-neutral preflight helpers.
 *
 * The agent loop doesn't know which provider serves a given model. It
 * calls these helpers, which resolve the model → provider, dispatch
 * `preflight()` and `applyResolution()` on the adapter, and return a
 * consistent shape.
 *
 * Why this lives in the canonical layer (not on the agent): the agent
 * is provider/model-free by design. All "which provider knows how to
 * inspect this request" knowledge lives in `model-registry`, and the
 * dispatch fan-out belongs next to it. The agent imports ONE function,
 * `runPreflight()`, and never touches `ProviderAdapter` directly.
 *
 * The wrapper is safe-by-default: missing model, missing provider, or a
 * provider that doesn't implement `preflight()` returns `[]`. Failures
 * in the provider's own logic are caught and logged at debug level so a
 * buggy adapter cannot wedge the send loop.
 *
 * @module llm/preflight
 */

import type { CanonicalRequest } from "./canonical-request.ts"
import { resolveModel, resolveProvider } from "./model-registry.ts"
import type { PreflightIssue, PreflightResolution } from "./provider.ts"

/**
 * Resolve the provider for `req.modelId` and call its `preflight()`.
 * Returns an empty array when the model/provider can't be resolved or
 * the provider has no `preflight()` method. Catches and swallows
 * exceptions from the provider's own preflight, returning `[]` so the
 * agent never crashes on a bad adapter.
 */
export function runPreflight(req: CanonicalRequest): PreflightIssue[] {
  try {
    const model = resolveModel(req.modelId)
    const adapter = resolveProvider(model.providerId)
    if (!adapter.preflight) return []
    return adapter.preflight(req, model) ?? []
  } catch (err) {
    // Defensive: don't let a buggy adapter throw mid-loop. Best-effort
    // log; the agent continues with no preflight issues surfaced.
    if (process.env.MINIMAL_AGENT_PREFLIGHT_DEBUG) {
      process.stderr.write(
        `[preflight] adapter threw: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
    return []
  }
}

/**
 * Resolve the provider for `req.modelId` and call its `applyResolution()`.
 * Throws if the model/provider isn't resolvable, the provider doesn't
 * implement `applyResolution()`, or the provider's own logic throws.
 * Unlike {@link runPreflight}, errors here are surfaced because the
 * caller has already gathered user input and a silent failure would be
 * confusing.
 */
export function applyPreflightResolution(
  req: CanonicalRequest,
  issueCode: string,
  optionId: string,
): PreflightResolution {
  const model = resolveModel(req.modelId)
  const adapter = resolveProvider(model.providerId)
  if (!adapter.applyResolution) {
    throw new Error(
      `provider ${model.providerId} declared preflight issues but has no applyResolution()`,
    )
  }
  return adapter.applyResolution(req, issueCode, optionId)
}

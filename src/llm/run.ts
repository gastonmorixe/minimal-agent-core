/**
 * Top-level `run()` orchestrator.
 *
 * Resolves the model + provider, validates the request against the
 * model's capabilities, dispatches to the adapter, yields canonical
 * events. The agent loop only ever consumes from this function.
 *
 * Validation behavior:
 *
 * - `acceptDegrade:false` (default): on validation failure, throws
 *   {@link UnsupportedCapabilityError}. The caller hasn't asked for
 *   a fallback so we surface the issue.
 * - `acceptDegrade:true`: when the adapter offers `validation.degrade`,
 *   we yield a one-shot `StreamErrorEvent` with `retryable:false` and
 *   `category:"unknown"` (carrying the violations as the cause), then
 *   continue with the degraded request. Callers parse the cause to
 *   surface the downgrade to the user. When no degrade is offered,
 *   we still throw.
 *
 * The streaming watchdog (idle / hard timeout) lives in
 * `streaming/stream-watchdog.ts` and wraps the inner adapter stream
 * here, so adapters don't have to re-implement it.
 *
 * @module llm/run
 */

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { UnsupportedCapabilityError } from "./errors.ts"
import { resolveModel, resolveProvider } from "./model-registry.ts"
import type { RunContext } from "./provider.ts"

/** Options that don't belong on `CanonicalRequest`. */
export interface RunOptions {
  /**
   * When the adapter offers a degrade for an invalid request, accept
   * it instead of throwing. The first yielded event is a
   * `StreamErrorEvent` describing the downgrade, then the degraded
   * stream begins. Default `false`.
   */
  acceptDegrade?: boolean
  /** Run context (auth, networkClient, sessionId, debug, onUsage). */
  context: RunContext
}

export async function* run(req: CanonicalRequest, opts: RunOptions): AsyncIterable<CanonicalEvent> {
  const model = resolveModel(req.modelId)
  const adapter = resolveProvider(model.providerId)
  const validation = adapter.validate(req, model)
  let effective: CanonicalRequest = req
  if (!validation.ok) {
    if (opts.acceptDegrade && validation.degrade) {
      yield {
        type: "stream_error",
        retryable: false,
        category: "unknown",
        cause: new UnsupportedCapabilityError(validation.errors, validation.degrade),
      }
      effective = validation.degrade
    } else {
      throw new UnsupportedCapabilityError(validation.errors, validation.degrade)
    }
  }
  yield* adapter.run(effective, model, opts.context)
}

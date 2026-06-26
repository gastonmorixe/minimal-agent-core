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
 *   we surface a diag notice (so the user sees the downgrade), then
 *   continue with the degraded request. This is the key enabler for
 *   --resume with a different model: a session created under a vision
 *   model can resume under a text-only model because unsupported
 *   media blocks are stripped before the first send. When no degrade
 *   is offered, we still throw.
 *
 * The streaming watchdog (idle / hard timeout) lives in
 * `streaming/stream-watchdog.ts` and wraps the inner adapter stream
 * here, so adapters don't have to re-implement it.
 *
 * @module llm/run
 */

import { diag } from "../diagnostic-bus.ts"
import { defaultNetworkClient } from "../network/index.ts"

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { UnsupportedCapabilityError } from "./errors.ts"
import { resolveModel, resolveModelForProvider, resolveProvider } from "./model-registry.ts"
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

/**
 * Provider-neutral entry point for one streaming completion: resolves the
 * model and its provider adapter, validates the request against the model's
 * capabilities (optionally degrading instead of failing when
 * `acceptDegrade` is set), then delegates to the adapter and yields its
 * canonical event stream. Validation failures surface as a thrown
 * `UnsupportedCapabilityError` or an in-stream `stream_error` event, never as
 * a provider-specific error shape.
 */
export async function* run(req: CanonicalRequest, opts: RunOptions): AsyncIterable<CanonicalEvent> {
  const model = req.providerId
    ? resolveModelForProvider(req.modelId, req.providerId)
    : resolveModel(req.modelId)
  const adapter = resolveProvider(model.providerId)
  const validation = adapter.validate(req, model)
  let effective: CanonicalRequest = req
  if (!validation.ok) {
    if (opts.acceptDegrade && validation.degrade) {
      diag.warn(
        "capability.degrade",
        `model ${model.id} downgraded by stripping ${validation.errors.length} unsupported feature(s): ${validation.errors.map((e) => e.capability).join(", ")}`,
      )
      effective = validation.degrade
    } else {
      throw new UnsupportedCapabilityError(validation.errors, validation.degrade)
    }
  }
  // Net seam (Wave D): the host owns the network singleton, not the plugin.
  // Always populate `ctx.networkClient` with the shared `defaultNetworkClient`
  // unless the caller injected its own (tests, alt transports). Adapters then
  // read `ctx.networkClient` instead of importing `src/network` for the
  // runtime client — the client crosses the provider port, not a module edge.
  const context: RunContext = opts.context.networkClient
    ? opts.context
    : { ...opts.context, networkClient: defaultNetworkClient }
  yield* adapter.run(effective, model, context)
}

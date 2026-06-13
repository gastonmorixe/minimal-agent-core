/**
 * Default agent transport selector.
 *
 * Picks, per request, which transport implements `Agent.sendFn`:
 *
 * - **Every registered model** (Anthropic, OpenAI Chat/Responses,
 *   OpenRouter, future vendors) → `canonicalSendFn`, which routes through
 *   the canonical `run()` so the request reaches the model's own provider
 *   adapter. This is the Wave-B flip (B-0, PLAN.md §2): the canonical
 *   Anthropic path is equivalence-pinned against the legacy client
 *   (callback order included; parity gaps closed by the summarize port +
 *   the canonical quota probe), with two DELIBERATE divergences resolved
 *   in the flip commit (B3a: redact-thinking omitted from conversations,
 *   B2: api-key requests adopt the canonical beta set).
 * - **Unregistered / missing model ids** → the legacy `sendMessage`
 *   fallback, so a genuinely bad id fails the same way it always did.
 *
 * # Reversibility (env escape hatches)
 *
 * `MINIMAL_AGENT_LEGACY_TRANSPORT`:
 * - `"1"`: route EVERY request through the legacy `sendMessage` stack
 *   (instant rollback for the B-0 flip; equivalent to mode `"off"`).
 *   Takes precedence over `MINIMAL_AGENT_CANONICAL_TRANSPORT` — the
 *   revert switch must be absolute. The legacy stack is not deleted
 *   until the post-flip bake passes (B-5).
 *
 * `MINIMAL_AGENT_CANONICAL_TRANSPORT`:
 * - unset / `"auto"` (default): registry-conditional, as above.
 * - `"all"`: route EVERY model through `canonicalSendFn`, including ids
 *   the registry can't resolve (run() then raises its own unknown-model
 *   error).
 * - `"off"`: route EVERY model through legacy `sendMessage` (same effect
 *   as the legacy hatch; non-Anthropic models will fail, as they did
 *   before the canonical transport existed).
 *
 * @module llm/transport/select-transport
 */

import type { SendOptions, StreamedResponse } from "../../client/types.ts"
import { sendMessage } from "../../client.ts"
import { resolveModel } from "../model-registry.ts"

import { canonicalSendFn } from "./canonical-send.ts"

export type TransportMode = "auto" | "all" | "off"

/**
 * Read + normalize the transport mode from the environment.
 * `MINIMAL_AGENT_LEGACY_TRANSPORT=1` (the B-0 rollback hatch) wins over
 * everything; otherwise `MINIMAL_AGENT_CANONICAL_TRANSPORT` applies.
 */
export function transportMode(): TransportMode {
  if (process.env.MINIMAL_AGENT_LEGACY_TRANSPORT === "1") return "off"
  const v = (process.env.MINIMAL_AGENT_CANONICAL_TRANSPORT ?? "auto").toLowerCase()
  return v === "all" || v === "off" ? v : "auto"
}

/**
 * Choose the transport function for a model id. Pure + synchronous so it
 * can be unit-tested without a network.
 */
export function pickTransport(
  modelId: string | undefined,
  mode: TransportMode = transportMode(),
): typeof sendMessage {
  if (mode === "off") return sendMessage
  if (mode === "all") return canonicalSendFn
  // auto: any model the registry resolves goes canonical (the B-0 flip);
  // an unresolved id falls back to legacy so failure modes are unchanged.
  if (!modelId) return sendMessage
  try {
    resolveModel(modelId)
    return canonicalSendFn
  } catch {
    // Unregistered model id: fall back to the legacy default (preserves
    // prior behavior; a genuinely bad id fails the same way it used to).
    return sendMessage
  }
}

/**
 * The default `Agent.sendFn`: dispatches each request to the transport its
 * model requires. Signature-compatible with `sendMessage` so it is a
 * drop-in default and any caller can still inject a custom `sendFn`.
 *
 * @yields text deltas from the selected transport.
 * @returns the selected transport's `StreamedResponse`.
 */
export async function* selectedTransport(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  return yield* pickTransport(opts.model)(opts)
}

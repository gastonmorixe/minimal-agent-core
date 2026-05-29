/**
 * Default agent transport selector.
 *
 * Picks, per request, which transport implements `Agent.sendFn`:
 *
 * - **Anthropic** models → the legacy `client.ts` `sendMessage` (its
 *   battle-tested retry / watchdog / 401-keychain-race infra, untouched).
 * - **Everything else** (OpenAI Chat/Responses, OpenRouter, future
 *   OpenAI-compatible vendors) → `canonicalSendFn`, which routes through
 *   the canonical `run()` so the request actually reaches the right vendor.
 *   This is the only path on which `--model gpt-5.5` dispatches to OpenAI.
 *
 * This provider-conditional default is the low-risk staging of the
 * canonical migration: the Anthropic experience is byte-identical to
 * before (same `sendMessage`), while non-Anthropic models go from
 * "registered but non-functional at runtime" to "working".
 *
 * # Reversibility (env escape hatch)
 *
 * `MINIMAL_AGENT_CANONICAL_TRANSPORT`:
 * - unset / `"auto"` (default): provider-conditional, as above.
 * - `"all"`: route EVERY model (incl. Anthropic) through `canonicalSendFn`.
 *   Used to exercise the canonical Anthropic path end-to-end (Phase 4).
 * - `"off"`: route EVERY model through legacy `sendMessage` (emergency
 *   revert; non-Anthropic models will fail, as they did before this work).
 *
 * @module llm/transport/select-transport
 */

import type { SendOptions, StreamedResponse } from "../../client/types.ts"
import { sendMessage } from "../../client.ts"
import { resolveModel } from "../model-registry.ts"

import { canonicalSendFn } from "./canonical-send.ts"

export type TransportMode = "auto" | "all" | "off"

/** Read + normalize the transport mode from the environment. */
export function transportMode(): TransportMode {
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
  // auto: route by the model's registered provider. Anthropic stays legacy;
  // anything else (or an unresolved id) is canonical / legacy-safe-default.
  if (!modelId) return sendMessage
  try {
    return resolveModel(modelId).providerId === "anthropic" ? sendMessage : canonicalSendFn
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

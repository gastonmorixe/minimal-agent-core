/**
 * The default agent transport.
 *
 * Every request routes through the canonical `run()` orchestrator, which
 * resolves the model to its provider adapter. There is one transport for
 * all providers; the agent loop never names a vendor. The function is
 * signature-compatible with the agent's `sendFn` seam, so any caller can
 * still inject a custom transport (tests do).
 *
 * @module llm/transport/select-transport
 */

import { canonicalSendFn } from "./canonical-send.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "./types.ts"

/**
 * The default `Agent.sendFn`. Routes the request through the canonical
 * transport, which dispatches to the model's provider adapter.
 *
 * @yields text deltas from the canonical transport.
 * @returns the canonical transport's `StreamedResponse`.
 */
export const selectedTransport: TransportFn = canonicalSendFn

/**
 * Resolve the transport for a model id. Retained as a stable seam for
 * callers that historically chose a transport per request; now every model
 * uses the single canonical transport.
 */
export function pickTransport(_modelId?: string): TransportFn {
  return canonicalSendFn
}

export type { SendOptions, StreamedResponse }

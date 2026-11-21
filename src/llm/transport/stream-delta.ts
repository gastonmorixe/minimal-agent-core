/**
 * Streamed-output telemetry: batched accumulation of generated-token
 * progress, reported through the injected `pluginEvents` port (spec S28)
 * so a host can render live throughput (e.g. a tokens-per-second readout).
 *
 * WHY THIS EXISTS: session token counters fold once per API call (at
 * message_start), so sampling them can never produce a rate that advances
 * DURING generation. The only signal that advances mid-stream is the delta
 * text itself, seen in `assembleStreamedResponse` (`llm/codec/stream-assembler.ts`) — the single funnel
 * every provider's stream passes through.
 *
 * Usage (host side, inside the text_delta / thinking_delta cases):
 *   const acc = getStreamDeltaAccumulator(lookupTokenEstimator(model, provider))
 *   acc.add(ev.text)
 *   acc.maybeFlush(pluginEvents)
 *
 * The token count comes ONLY from the (provider, model) estimator. Core has
 * no chars-per-token ratio: with no estimator, the accumulator counts
 * nothing and emits no delta (the host shows no token rate).
 *
 * Usage (plugin side): subscribe to the {@link LLM_OUTPUT_DELTA} channel on
 * whatever bus the host's `pluginEvents` port forwards to; payload is
 * `{ deltaTokens: number }`.
 *
 * @module llm/transport/stream-delta
 */

import type { PluginEventsPort } from "../../bus/plugin-events-port.ts"
import type { TokenEstimator } from "../token-estimate.ts"

/**
 * Stable channel name carrying streamed OUTPUT token progress, forwarded
 * through the `pluginEvents` port. Payload: `{ deltaTokens: number }` —
 * approximate output tokens (text + thinking, from the model's estimator)
 * since the previous emit on this channel. A model with no estimator emits
 * no delta.
 *
 * Once published, plugins may subscribe via manifest `events[]`; renaming
 * is a breaking change.
 */
export const LLM_OUTPUT_DELTA = "llm.outputDelta"

/**
 * Stable channel name marking the immediate end of live model output.
 * Payload: `{ reason: "stream_end" }`. Emitted once after the final output
 * batch flushes, for every bridge exit. Consumers should treat it as an
 * idempotent inactive signal.
 */
export const LLM_OUTPUT_END = "llm.outputEnd"

export type OutputEndReason = "stream_end"

/** Report a live-output boundary through `sink`. No-op with no sink. */
export function emitOutputEnd(reason: OutputEndReason, sink?: PluginEventsPort): void {
  sink?.emit(LLM_OUTPUT_END, { reason })
}

/** Minimum wall time between emits (ms). */
const BATCH_MS = 250
/** ...or this many accumulated tokens, whichever comes first. */
const BATCH_TOKENS = 50

/**
 * Batched accumulator for one in-flight stream. NOT reusable across
 * streams: create a fresh one per send (see {@link resetStreamDeltaAccumulator}).
 */
export interface StreamDeltaAccumulator {
  /**
   * Record an output text chunk. Its tokens come from the estimator given at
   * creation. No estimator: a no-op (no rate without a model estimator).
   */
  add(text: string): void
  /**
   * Report through `sink` if the time/token batch thresholds are met.
   * Cheap enough to call on every delta. No-op with no sink.
   */
  maybeFlush(sink?: PluginEventsPort): void
  /**
   * Report through `sink` whatever is still batched. Call at stream end so
   * the final partial window isn't lost. No-op with no sink.
   */
  flush(sink?: PluginEventsPort): void
}

let active: StreamDeltaAccumulator | null = null

/**
 * The accumulator for the CURRENT in-flight stream, creating it on first
 * use. One stream at a time: a second concurrent send would interleave
 * deltas into one window. That matches reality — the agent sends one chat
 * completion at a time; side-probes don't stream output deltas.
 *
 * @param estimateTokens - The (provider, model) estimator of this stream.
 *   Read only when the call creates the accumulator. Absent: the
 *   accumulator counts nothing (core has no ratio).
 */
export function getStreamDeltaAccumulator(estimateTokens?: TokenEstimator): StreamDeltaAccumulator {
  if (!active) {
    let pending = 0
    let lastEmitAt = performance.now()
    active = {
      add(text: string) {
        if (!estimateTokens || text.length === 0) return
        pending += estimateTokens(text)
      },
      maybeFlush(sink?: PluginEventsPort) {
        if (pending <= 0) return
        const now = performance.now()
        if (now - lastEmitAt < BATCH_MS && pending < BATCH_TOKENS) return
        sink?.emit(LLM_OUTPUT_DELTA, { deltaTokens: pending })
        pending = 0
        lastEmitAt = now
      },
      flush(sink?: PluginEventsPort) {
        if (pending <= 0) return
        sink?.emit(LLM_OUTPUT_DELTA, { deltaTokens: pending })
        pending = 0
      },
    }
  }
  return active
}

/** Drop the current accumulator (call when the send completes). */
export function resetStreamDeltaAccumulator(): void {
  active = null
}

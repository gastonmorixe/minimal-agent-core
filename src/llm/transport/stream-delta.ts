/**
 * Streamed-output telemetry: batched accumulation of generated-token
 * progress, broadcast on the plugin bus so plugins can render live
 * throughput (e.g. a tokens-per-second readout).
 *
 * WHY THIS EXISTS: session token counters fold once per API call (at
 * message_start), so sampling them can never produce a rate that advances
 * DURING generation. The only signal that advances mid-stream is the delta
 * text itself, seen in `canonicalEventsToLegacyStream` — the single funnel
 * every provider's stream passes through.
 *
 * Usage (host side, inside the text_delta / thinking_delta cases):
 *   const acc = getStreamDeltaAccumulator()
 *   acc.add(ev.text.length)
 *   acc.maybeFlush()
 *
 * Usage (plugin side): subscribe to the {@link LLM_OUTPUT_DELTA} bus
 * channel; payload is `{ deltaTokens: number }`.
 *
 * @module llm/transport/stream-delta
 */

import { getGlobalEventBus } from "../../bus/global-bus.ts"

/**
 * Stable plugin-bus channel carrying streamed OUTPUT token progress.
 * Payload: `{ deltaTokens: number }` — approximate output tokens (text +
 * thinking, ~4 chars/token) since the previous emit on this channel.
 *
 * Once published, plugins may subscribe via manifest `events[]`; renaming
 * is a breaking change.
 */
export const LLM_OUTPUT_DELTA = "llm.outputDelta"

/**
 * Stable plugin-bus channel marking the immediate end of live model output.
 * Payload: `{ reason: "stream_end" }`. Emitted once after the final output
 * batch flushes, for every bridge exit. Consumers should treat it as an
 * idempotent inactive signal.
 */
export const LLM_OUTPUT_END = "llm.outputEnd"

export type OutputEndReason = "stream_end"

/** Publish a live-output boundary without coupling the bridge to plugins. */
export function emitOutputEnd(reason: OutputEndReason): void {
  getGlobalEventBus()?.emit(LLM_OUTPUT_END, { reason })
}

/** Minimum wall time between emits (ms). */
const BATCH_MS = 250
/** ...or this many accumulated tokens, whichever comes first. */
const BATCH_TOKENS = 50

/**
 * Approximate tokens for an output text chunk. Providers bill roughly 4
 * characters per token for English prose; thinking streams run similar.
 * Exact per-chunk counts don't matter for a rate display — consistency
 * does.
 */
function approxTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4))
}

/**
 * Batched accumulator for one in-flight stream. NOT reusable across
 * streams: create a fresh one per send (see {@link resetStreamDeltaAccumulator}).
 */
export interface StreamDeltaAccumulator {
  /** Record an output text chunk (characters). */
  add(chars: number): void
  /**
   * Emit if the time/token batch thresholds are met. Cheap enough to call
   * on every delta.
   */
  maybeFlush(): void
  /**
   * Emit whatever is still batched. Call at stream end so the final
   * partial window isn't lost.
   */
  flush(): void
}

let active: StreamDeltaAccumulator | null = null

/**
 * The accumulator for the CURRENT in-flight stream, creating it on first
 * use. One stream at a time: a second concurrent send would interleave
 * deltas into one window. That matches reality — the agent sends one chat
 * completion at a time; side-probes don't stream output deltas.
 */
export function getStreamDeltaAccumulator(): StreamDeltaAccumulator {
  if (!active) {
    let pending = 0
    let lastEmitAt = performance.now()
    active = {
      add(chars: number) {
        pending += approxTokens(chars)
      },
      maybeFlush() {
        if (pending <= 0) return
        const now = performance.now()
        if (now - lastEmitAt < BATCH_MS && pending < BATCH_TOKENS) return
        getGlobalEventBus()?.emit(LLM_OUTPUT_DELTA, { deltaTokens: pending })
        pending = 0
        lastEmitAt = now
      },
      flush() {
        if (pending <= 0) return
        getGlobalEventBus()?.emit(LLM_OUTPUT_DELTA, { deltaTokens: pending })
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

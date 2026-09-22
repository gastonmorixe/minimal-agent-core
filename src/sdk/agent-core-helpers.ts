/**
 * Small helpers extracted from {@link AgentCore} so that file stays under the
 * 810-line gate.
 *
 * @module sdk/agent-core-helpers
 */

import type { StopReason } from "../llm/canonical-events.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import type { EventUsage } from "./events.ts"

export type MaybePromise<T> = T | Promise<T>

export const MAX_TOKENS_CONTINUATION_CAP = 5
/** See agent.ts — one local continuation for mid-text terminal-less closes. */
export const MAX_INTERRUPTED_TURN_CONTINUATIONS = 1

/** Canonical stop-reason bridge: transport already emits the union. */
export function toEventStopReason(stopReason: string | null): StopReason | null {
  return stopReason as StopReason | null
}

/**
 * Project a transport usage snapshot onto the host-facing {@link EventUsage}
 * shape (the four counters a `--json` consumer reports). Missing counters
 * default to 0 so `turn_completed.usage` is always a complete object, per the
 * frozen event contract (usage is REQUIRED on turn_completed).
 */
export function toEventUsage(usage: StreamedResponse["usage"] | undefined): EventUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

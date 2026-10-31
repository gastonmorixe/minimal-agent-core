/**
 * Small helpers extracted from {@link AgentCore} so that file stays under the
 * 810-line gate.
 *
 * @module sdk/agent-core-helpers
 */

import type { StopReason } from "../llm/canonical-events.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import type { AgentEvent, EventUsage } from "./events.ts"

export type MaybePromise<T> = T | Promise<T>

/** The empty response a turn reports before any model response arrived. */
export const EMPTY_RESPONSE: StreamedResponse = { blocks: [], text: "", stopReason: null }

/**
 * The `item_started` / `item_completed` pair for each text, tool_use, and
 * thinking block. The id is the tool_use id for a tool call (so the later
 * tool_result joins on it), or `${round}:${i}` for text and thinking.
 */
export function itemEvents(blocks: StreamedResponse["blocks"], round: number): AgentEvent[] {
  const out: AgentEvent[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    if (block.type !== "text" && block.type !== "tool_use" && block.type !== "thinking") continue
    const itemType = block.type
    const id = block.type === "tool_use" ? block.id : `${round}:${i}`
    const text =
      block.type === "tool_use"
        ? block.name
        : block.type === "text"
          ? block.text
          : (block.thinking ?? "")
    out.push({
      type: "item_started",
      itemType,
      id,
      ...(block.type === "tool_use" ? { label: block.name } : {}),
    })
    out.push({ type: "item_completed", itemType, id, text })
  }
  return out
}

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

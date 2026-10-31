/**
 * Which event kinds an {@link EventSink} takes (spec S18).
 *
 * A sink may list the kinds it wants in `kinds`. The core then emits only
 * those kinds to it. A sink without `kinds` takes every kind except
 * `tool_output`. `text_delta` / `thinking_delta` stay gated by the run's own
 * `emitDeltas` option (unaffected by `kinds`); `tool_output` is gated by
 * `kinds` alone, read through {@link EventKindFilter.wantsToolOutput}.
 *
 * @module sdk/event-filter
 */

import type { AgentEventType, EventSink } from "./events.ts"

/** The kind decisions for one sink. */
export interface EventKindFilter {
  /** Whether the sink takes an event of this kind. */
  accepts(type: AgentEventType): boolean
  /** Whether the sink asked for `tool_output` events. */
  readonly wantsToolOutput: boolean
}

const NO_SINK: EventKindFilter = { accepts: () => false, wantsToolOutput: false }

/** Build the kind decisions for `sink` (read once; a sink's kinds are fixed). */
export function eventKindFilter(sink: EventSink | null): EventKindFilter {
  if (!sink) return NO_SINK
  const listed = sink.kinds
  if (listed === undefined) {
    return { accepts: (type) => type !== "tool_output", wantsToolOutput: false }
  }
  const kinds = new Set(listed)
  return { accepts: (type) => kinds.has(type), wantsToolOutput: kinds.has("tool_output") }
}

/**
 * The 4-marker budget of the Anthropic Messages API (F3).
 *
 * "You can define up to 4 cache breakpoints" (prompt-caching docs). A body
 * with a fifth `cache_control` marker gets an HTTP 400. Core places up to 3
 * system markers, one rolling tail marker and (with the anchor flag) one
 * anchor marker, and a plugin can add more through `message.willSend`. This
 * module counts every marker of the FINAL body (system + tools + messages,
 * also the blocks nested in a `tool_result`) and drops the extra ones.
 *
 * Drop order when the body has more than {@link MAX_CACHE_MARKERS}:
 * 1. Message markers other than the last one (the anchor), from the start.
 * 2. System markers, from the end (the first system marker is the widest prefix).
 * 3. Tool markers, from the end.
 * The last message marker (the rolling tail) is never dropped.
 *
 * With 4 markers or fewer the body is not touched, so today's requests stay
 * byte-identical.
 *
 * @module llm/cache-marker-cap
 */

import type { AnthropicContentBlock, AnthropicRequestBody } from "./anthropic-request.ts"

/** The API limit of explicit `cache_control` breakpoints in one request. */
export const MAX_CACHE_MARKERS = 4

/** One object that carries a `cache_control` key in the body. */
type Marked = { cache_control?: unknown }

/** All marked message blocks in wire order (nested `tool_result` blocks included). */
function messageMarkers(body: AnthropicRequestBody): Marked[] {
  const out: Marked[] = []
  const visit = (blocks: readonly AnthropicContentBlock[]): void => {
    for (const b of blocks) {
      if (b.type === "tool_result" && Array.isArray(b.content)) visit(b.content)
      if (b.cache_control !== undefined) out.push(b)
    }
  }
  for (const m of body.messages) {
    if (Array.isArray(m.content)) visit(m.content)
  }
  return out
}

/** Marked entries of a flat list (system blocks or tool definitions). */
function flatMarkers(list: readonly object[] | undefined): Marked[] {
  return (list ?? []).filter((b): b is Marked => (b as Marked).cache_control !== undefined)
}

/**
 * Count the `cache_control` markers of an Anthropic request body.
 *
 * @param body - The final wire body.
 * @returns The total over system, tools and messages.
 */
export function countCacheMarkers(body: AnthropicRequestBody): number {
  return (
    flatMarkers(body.system).length +
    flatMarkers(body.tools).length +
    messageMarkers(body).length
  )
}

/**
 * Keep at most {@link MAX_CACHE_MARKERS} markers in `body` (mutated in place).
 *
 * @param body - The final wire body.
 * @param max - The budget. Default {@link MAX_CACHE_MARKERS}.
 * @returns The number of markers removed (0 when the body was in budget).
 */
export function capCacheMarkers(
  body: AnthropicRequestBody,
  max: number = MAX_CACHE_MARKERS,
): number {
  const msgs = messageMarkers(body)
  const system = flatMarkers(body.system)
  const tools = flatMarkers(body.tools)
  let excess = msgs.length + system.length + tools.length - max
  if (excess <= 0) return 0
  // Never the tail: it is the last message marker.
  const order: Marked[] = [
    ...msgs.slice(0, -1),
    ...system.slice().reverse(),
    ...tools.slice().reverse(),
  ]
  let dropped = 0
  for (const m of order) {
    if (excess <= 0) break
    delete m.cache_control
    excess--
    dropped++
  }
  return dropped
}

/**
 * Rolling cache-breakpoint helper used by the agent's send loop.
 *
 * Split out of `src/agent.ts` to keep that file under the `max-lines`
 * lint budget. The function is re-exported from `agent.ts` for
 * back-compat.
 *
 * @module agent/cache
 */

import type { ContentBlock, Message } from "../client.ts"

/**
 * Returns a defensive copy of `messages` with the last block of the last
 * message marked `cache_control: { type: "ephemeral", ttl: "1h" }` and any
 * earlier `cache_control` markers in messages stripped. Live 2.1.118 traffic
 * uses exactly one rolling tail breakpoint per request; combined with the two
 * static system-prompt breakpoints (instructions + session guidance) this
 * stays under the API's 4-breakpoint limit while letting the cached prefix
 * grow turn-over-turn.
 *
 * @param messages - Conversation history (not mutated).
 * @returns A new array of messages with cache markers normalized for the
 *   next API call.
 */
export function withRollingCacheBreakpoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const out: Message[] = messages.map((m) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => {
            // cache_control is now declared on every ContentBlock variant, so
            // no cast is needed to destructure it out.
            const { cache_control: _drop, ...rest } = b
            return rest as ContentBlock
          }),
  }))
  const last = out[out.length - 1]
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }]
  }
  const blocks = last.content
  if (blocks.length === 0) return out
  const tail: ContentBlock = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral", ttl: "1h" },
  }
  blocks[blocks.length - 1] = tail
  return out
}

/**
 * Rolling cache-breakpoint helper used by the agent's send loop.
 *
 * Split out of `src/agent.ts` to keep that file under the `max-lines`
 * lint budget. The function is re-exported from `agent.ts` for
 * back-compat.
 *
 * @module agent/cache
 */

import type { ContentBlock, Message } from "../llm/messages.ts"

/**
 * Returns a defensive copy of `messages` with the rolling tail
 * `cache_control: { type: "ephemeral", ttl: "1h" }` breakpoint placed on the
 * last cache-eligible block of the last message, and any earlier
 * `cache_control` markers in messages stripped. Live 2.1.118 traffic uses
 * exactly one rolling tail breakpoint per request; combined with the two
 * static system-prompt breakpoints (instructions + session guidance) this
 * stays under the API's 4-breakpoint limit while letting the cached prefix
 * grow turn-over-turn.
 *
 * "Cache-eligible" excludes `thinking` / `redacted_thinking` blocks: the
 * Anthropic API forbids modifying those in the latest assistant message, and
 * adding `cache_control` is a modification (a 400). So when the last message
 * is an assistant turn ending in thinking, the breakpoint moves to the last
 * non-thinking block (or is skipped if the turn is all thinking). In the
 * steady state the last message is a `user` turn (tool_results or prompt),
 * whose last block is never thinking, so behavior there is unchanged.
 *
 * @param messages - Conversation history (not mutated).
 * @returns A new array of messages with cache markers normalized for the
 *   next API call.
 */
export function withRollingCacheBreakpoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  // Drop stale thinking from older assistant turns BEFORE building the request
  // (see stripStaleThinking). Re-sending every prior turn's thinking balloons
  // the request and 400s once several interleaved-thinking turns accumulate.
  const pruned = stripStaleThinking(messages)
  const out: Message[] = pruned.map((m) => {
    if (typeof m.content === "string") return { role: m.role, content: m.content }
    // cache_control is declared on every ContentBlock variant, so destructure
    // it out (no cast needed) to strip earlier breakpoints before re-marking.
    const content = m.content.map((b) => {
      const { cache_control: _drop, ...rest } = b
      return rest as ContentBlock
    })
    return { role: m.role, content }
  })
  const last = out[out.length - 1]
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }]
  }
  const blocks = last.content
  if (blocks.length === 0) return out
  // Pick the breakpoint target. Normally that's the final block, but when
  // the conversation ends on an assistant turn whose tail is a `thinking`
  // (or `redacted_thinking`) block we MUST NOT mark it. The Anthropic API
  // pins the bytes of thinking blocks in the latest assistant message
  // ("`thinking` or `redacted_thinking` blocks in the latest assistant
  // message cannot be modified. These blocks must remain as they were in the
  // original response."), and attaching `cache_control` counts as a
  // modification, so the whole request 400s. This state is reachable
  // whenever an assistant turn is re-sent without a trailing user message:
  // an assistant prefill (`capabilities.assistantPrefill`), or a
  // forked/resumed session whose last record is a long interleaved-thinking
  // turn. Walk back to the last NON-thinking block and mark that instead; if
  // every trailing block is thinking, skip the breakpoint this turn (the two
  // static system-prompt breakpoints still cache the bulk of the prefix).
  let idx = blocks.length - 1
  while (idx >= 0 && isThinkingBlock(blocks[idx])) idx--
  if (idx < 0) return out
  const tail: ContentBlock = {
    ...blocks[idx],
    cache_control: { type: "ephemeral", ttl: "1h" },
  }
  blocks[idx] = tail
  return out
}

/**
 * Drop `thinking` / `redacted_thinking` blocks from every assistant message
 * EXCEPT the most recent one. The Anthropic API only requires the LATEST
 * assistant turn's thinking to be preserved (the interleaved-thinking tool-use
 * loop). Re-sending full thinking from every prior turn balloons the request
 * and, once a few interleaved-thinking turns accumulate (~200 KB+ of thinking
 * signatures), trips a 400:
 *
 *   messages.<i>.content.<j>: `thinking` or `redacted_thinking` blocks in the
 *   latest assistant message cannot be modified. These blocks must remain as
 *   they were in the original response.
 *
 * Observed live on session 562e2a3f (anth-4.8, interleaved-thinking beta,
 * display:"summarized"): 1 thinking turn / 119 KB of signatures → OK, 2 /
 * 186 KB → OK, 3 / 223 KB → 400. The assistant content we re-send is
 * byte-identical to what the model produced (verified against the SSE
 * capture), so the failure is payload accumulation, not a client mutation.
 *
 * Stripping stale thinking client-side keeps the request small and matches
 * what the server's `clear_thinking_20251015` edit intends (our `keep:"all"`
 * tells the server NOT to clear, so we must). The latest assistant turn is
 * never touched : its thinking text + signatures stay byte-identical, which
 * the tool-use continuation requires. Tool_use blocks in older turns are
 * preserved so tool_use/tool_result pairing stays intact. Returns a new array;
 * the caller's `messages` (and the agent's persisted history) are not mutated.
 */
export function stripStaleThinking(messages: Message[]): Message[] {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistant = i
      break
    }
  }
  // 0 or 1 assistant turn → nothing stale to drop.
  if (lastAssistant <= 0) return messages
  return messages.map((m, i) => {
    if (i === lastAssistant || m.role !== "assistant" || typeof m.content === "string") {
      return m
    }
    const kept = m.content.filter((b) => !isThinkingBlock(b))
    // No thinking to drop, or stripping would empty the message (defensive :
    // an all-thinking non-latest turn shouldn't exist, but never send []).
    if (kept.length === 0 || kept.length === m.content.length) return m
    return { ...m, content: kept }
  })
}

/**
 * True for assistant reasoning blocks whose bytes the Anthropic API pins in
 * the latest assistant message. The codebase models redacted thinking as a
 * `thinking` block with empty text + a signature today, but a restored or
 * forked session could carry the literal `redacted_thinking` wire type, so
 * match it defensively too.
 */
function isThinkingBlock(b: ContentBlock): boolean {
  return b.type === "thinking" || (b.type as string) === "redacted_thinking"
}

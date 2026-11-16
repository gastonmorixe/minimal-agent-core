/**
 * Conversation-history repair helpers used by the agent's run loop and the
 * REPL abort path.
 *
 * Split out of `src/agent.ts` to keep that file under the `max-lines` lint
 * budget. Both functions operate on the agent's `messages` array directly
 * (and, for orphan repair, an optional session store) so they carry no
 * dependency on the engine class. The `AgentCore` methods of the same name
 * are thin delegators to these. See `src/sdk/agent-core.ts`.
 *
 * @module agent/history-repair
 */

import type { Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

import { interruptedByStopText, orphanAbortedText } from "./synthetic-fallbacks.ts"
import type { SyntheticTextResolver } from "./synthetic-text.ts"

/**
 * Minimal structural view of the session store this module touches: it only
 * appends synthetic tool_result rows. Kept structural (not the concrete
 * `SessionStore`) so the helper stays trivially testable and import-light.
 */
export interface ToolResultSink {
  appendToolResult(block: ToolResultBlock): void
}

/**
 * Pop trailing non-assistant messages that represent an unsent pending turn,
 * stopping at (and preserving) any message that carries `tool_result` blocks.
 *
 * Mutates `messages` in place (the array is shared by reference with the
 * caller's `Agent.messages`). Returns `true` when at least one message was
 * removed.
 *
 * @param messages - The conversation history (mutated in place).
 * @returns Whether any trailing message was popped.
 */
export function rollbackPendingTurn(messages: Message[]): boolean {
  let removed = false
  while (messages.length > 0 && messages[messages.length - 1].role !== "assistant") {
    const last = messages[messages.length - 1]
    const hasToolResult =
      Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")
    if (hasToolResult) break
    messages.pop()
    removed = true
  }
  return removed
}

/**
 * Scan the trailing assistant message for `tool_use` blocks that lack matching
 * `tool_result` blocks in the immediately-following user message. For each
 * orphan, build an `is_error: true` `tool_result` block whose content says the
 * tool was aborted before completion.
 *
 * Returns the synthetic blocks. The caller is responsible for prepending them
 * to the next user message so the `tool_use → tool_result` pairing is restored.
 * Synthesized blocks are also persisted via `store.appendToolResult` so the
 * session JSONL stays consistent (resumes cleanly without depending on
 * `session-restore.ts`'s repair pass).
 *
 * Why this exists: when the user aborts a turn (Esc, Ctrl+C, Alt+M) between the
 * moment the assistant streams its `tool_use` block and the moment the for-loop
 * builds the matching tool_result user message, the orphan `tool_use` sits in
 * `messages`. The Anthropic API then 400s on the next send with "tool_use ids
 * were found without tool_result blocks immediately after". Repro: session
 * `1b0cbbbf-0000-…` (2026-05-27, fixed by this helper alongside the
 * ASAP-mode-change rework in the same commit).
 *
 * Pure side-effect-free in shape: does NOT push to `messages` (the caller
 * controls placement so blocks land FIRST in the new user message). Only side
 * effect: per-orphan `store?.appendToolResult` calls so the JSONL records the
 * pairing the same instant the in-memory repair happens.
 *
 * Returns `[]` when:
 *   - history is empty,
 *   - trailing message is not assistant,
 *   - trailing assistant has no `tool_use` blocks,
 *   - all `tool_use` blocks already have matching tool_results in the next user
 *     message (clean state).
 *
 * @param messages - The conversation history (not mutated).
 * @param store - Optional session store to persist the synthetic results into.
 * @param text - The core's synthetic text resolver (kind `tool_result.aborted`,
 *   site `orphan`). Omitted: "" (no provider).
 * @returns The synthetic `tool_result` blocks the caller must prepend.
 */
export function repairOrphanedToolUse(
  messages: Message[],
  store: ToolResultSink | null,
  text?: SyntheticTextResolver,
): ToolResultBlock[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "assistant") return []
  if (!Array.isArray(last.content)) return []
  const toolUses = last.content.filter((b): b is ToolUseBlock => b.type === "tool_use")
  if (toolUses.length === 0) return []

  // Defensive: if the message AFTER the assistant already has
  // tool_results, walk those ids to identify the still-orphaned
  // subset. In the current run() flow this branch never fires
  // (orphans only happen when the for-loop's user message was
  // never pushed), but we keep the check so this helper is safe
  // to call from session-restore-style repair flows later.
  const next = messages[messages.length] // undefined by construction
  const pairedIds = new Set<string>()
  if (next && next.role === "user" && Array.isArray(next.content)) {
    for (const b of next.content) {
      if (b.type === "tool_result") pairedIds.add(b.tool_use_id)
    }
  }
  const orphans = toolUses.filter((t) => !pairedIds.has(t.id))
  if (orphans.length === 0) return []

  const blocks: ToolResultBlock[] = orphans.map((tu) => ({
    type: "tool_result" as const,
    tool_use_id: tu.id,
    content: orphanAbortedText(text),
    is_error: true,
  }))
  // Persist each synthetic result so the on-disk JSONL contains the
  // same pairing the in-memory `messages` is about to send. On
  // resume, `session-restore.ts`'s `repairMessages` would have done
  // this anyway by dropping the orphan; ours is non-destructive
  // (model sees "this was aborted" instead of the turn vanishing).
  if (store) {
    for (const b of blocks) store.appendToolResult(b)
  }
  return blocks
}

/**
 * Close the tool calls a kill cut off (decision 31). Use it only when a turn
 * resumes from a round checkpoint.
 *
 * The last assistant message with `tool_use` blocks is either the last
 * message, or the one before a user message that holds only `tool_result`
 * blocks (the calls that finished before the kill). Each `tool_use` with no
 * result gets a synthetic error result with
 * the `tool_result.interrupted_by_stop` text. The call never runs again by
 * itself. The model reads the note and checks the effects first.
 *
 * Mutates `messages` in place: it appends the results to the user message,
 * or pushes a new user message.
 *
 * @param messages - The conversation history (mutated).
 * @param text - The core's synthetic text resolver. Omitted: "" (no provider).
 * @returns The synthetic `tool_result` blocks it added, for the caller to persist.
 */
export function closeInterruptedToolCalls(
  messages: Message[],
  text?: SyntheticTextResolver,
): ToolResultBlock[] {
  let at = messages.length - 1
  let results: Message | undefined
  const tail = messages[at]
  if (tail?.role === "user") {
    if (!Array.isArray(tail.content) || tail.content.some((b) => b.type !== "tool_result"))
      return []
    results = tail
    at--
  }
  const asst = messages[at]
  if (!asst || asst.role !== "assistant" || !Array.isArray(asst.content)) return []
  const done = new Set<string>()
  if (results && Array.isArray(results.content)) {
    for (const b of results.content) if (b.type === "tool_result") done.add(b.tool_use_id)
  }
  const blocks: ToolResultBlock[] = asst.content
    .filter((b): b is ToolUseBlock => b.type === "tool_use" && !done.has(b.id))
    .map((tu) => ({
      type: "tool_result" as const,
      tool_use_id: tu.id,
      content: interruptedByStopText(text),
      is_error: true,
    }))
  if (blocks.length === 0) return []
  if (results && Array.isArray(results.content)) results.content = [...results.content, ...blocks]
  else messages.push({ role: "user", content: blocks })
  return blocks
}

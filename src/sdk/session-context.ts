/**
 * One-shot session context for AgentCore (`addSessionContext`, and the
 * `session.willStart` context after a compaction).
 *
 * Lines wait in a pending list. The next user message that the loop appends
 * takes them one time, as one context text block before the user text. The
 * block is part of the message history, so it is persisted and stays in
 * later requests and on resume. The system prompt never changes.
 *
 * Dedupe: when a user message in the current history already holds a text
 * block with the same wrapped text, the take gives `""`, so a resume with
 * the same session context adds no second block.
 *
 * @module sdk/session-context
 */

import type { ContentBlock, Message } from "../llm/messages.ts"

import { cleanHookContext, wrapHookContext } from "./hook-context.ts"

/**
 * Put the context `text` as one text block into user `content`, after the
 * leading `tool_result` blocks (they must stay first) and before the rest.
 * Returns the block, or `null` (and no change) when `text` is empty.
 */
export function insertSessionContext(content: ContentBlock[], text: string): ContentBlock | null {
  if (!text) return null
  const block: ContentBlock = { type: "text", text }
  const at = content.findIndex((b) => b.type !== "tool_result")
  content.splice(at === -1 ? content.length : at, 0, block)
  return block
}

/** True when a user message in `history` has a text block equal to `text`. */
export function historyHasSessionBlock(history: readonly Message[], text: string): boolean {
  for (const m of history) {
    if (m.role !== "user") continue
    if (typeof m.content === "string") {
      if (m.content === text) return true
      continue
    }
    for (const b of m.content) if (b.type === "text" && b.text === text) return true
  }
  return false
}

/** Pending session context lines. */
export class SessionContextQueue {
  private pending: string[] = []

  /** Queue lines for the next user message. Blank lines are dropped. */
  add(lines: readonly string[]): void {
    this.pending.push(...cleanHookContext(lines))
  }

  /**
   * Take the pending lines as one wrapped text, or `""` when no line waits.
   * It also gives `""` when `history` already holds a session block with
   * the same text (dedupe on resume). The queue is empty after a take.
   */
  take(history: readonly Message[] = []): string {
    const text = wrapHookContext(this.pending)
    this.pending = []
    if (text && historyHasSessionBlock(history, text)) return ""
    return text
  }
}

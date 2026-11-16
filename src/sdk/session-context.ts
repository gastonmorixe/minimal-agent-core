/**
 * One-shot session context for AgentCore (`addSessionContext`, and the
 * `session.willStart` context after a compaction).
 *
 * Entries wait in a pending list. The next user message that the loop
 * appends takes them one time. The block is part of the message history, so
 * it is persisted and stays in later requests and on resume. The system
 * prompt never changes.
 *
 * Positions: a take splits the entries into a "before" group and an "after"
 * group (see {@link splitHookContext}). Each group is one wrapped text block.
 * In the first user message of a turn, the before block goes before the user
 * text and the after block goes after it. In a later user message (mid-turn,
 * or after a compaction) both blocks go before the content, after the leading
 * `tool_result` blocks, before block first.
 *
 * Dedupe: when a user message in the current history already holds a text
 * block with the same wrapped text, that group gives `""`, so a resume with
 * the same session context adds no second block. The search reads every text
 * block of every user message, so a block before or after the user text
 * counts (a pre-P1 block, which was before the text, counts too). A block
 * does not record its position. So a new before group whose text equals an
 * old after block in the history is not added again, and stays after.
 * Within one take, an after entry with the same text as a before entry is
 * dropped: that text lands one time, in the before group.
 *
 * @module sdk/session-context
 */

import type { ContentBlock, Message } from "../llm/messages.ts"

import {
  type HookContextEntry,
  isHookContextEntry,
  splitHookContext,
  wrapHookContext,
} from "./hook-context.ts"

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

/** The two wrapped session context texts of one take. `""` means no block. */
export interface SessionContextTake {
  before: string
  after: string
}

/** Pending session context entries. */
export class SessionContextQueue {
  private pending: HookContextEntry[] = []

  /** Queue entries for the next user message. Blank and malformed entries are dropped. */
  add(entries: readonly HookContextEntry[]): void {
    for (const e of entries) {
      if (!isHookContextEntry(e)) continue
      if ((typeof e === "string" ? e : e.text).trim().length > 0) this.pending.push(e)
    }
  }

  /**
   * Take the pending entries as two wrapped texts (before and after), each
   * `""` when no entry of that group waits. A group gives `""` also when
   * `history` already holds a block with the same text (dedupe on resume).
   * An after entry whose text is also a before entry is dropped.
   * The queue is empty after a take.
   */
  take(history: readonly Message[] = []): SessionContextTake {
    const { before, after } = splitHookContext(this.pending)
    this.pending = []
    const inBefore = new Set(before)
    return {
      before: dedupe(wrapHookContext(before), history),
      after: dedupe(wrapHookContext(after.filter((t) => !inBefore.has(t))), history),
    }
  }
}

function dedupe(text: string, history: readonly Message[]): string {
  return text && historyHasSessionBlock(history, text) ? "" : text
}

/**
 * Put both groups of a take into a later user message (not the first one of a
 * turn): after the leading `tool_result` blocks, before block first.
 */
export function insertSessionTake(content: ContentBlock[], take: SessionContextTake): void {
  insertSessionContext(content, take.after)
  insertSessionContext(content, take.before)
}

/** The non-empty blocks of a take, before block first. */
export function sessionTakeBlocks(take: SessionContextTake): ContentBlock[] {
  return [take.before, take.after]
    .filter(Boolean)
    .map((text): ContentBlock => ({ type: "text", text }))
}

/**
 * Assemble hook context into the first user message of a turn. `content`
 * holds the leading blocks (tool results, turn markers) and then the user
 * text blocks, which start at `userAt`. Before the user text: the session
 * before block, then the turn before block. After it: the session after
 * block, then the turn after block. Empty groups add no block.
 */
export function placeFirstMessageContext(
  content: ContentBlock[],
  userAt: number,
  session: SessionContextTake,
  turn: readonly unknown[] | undefined,
): void {
  const split = splitHookContext(turn)
  const head = [session.before, wrapHookContext(split.before)].filter(Boolean)
  const tail = [session.after, wrapHookContext(split.after)].filter(Boolean)
  content.splice(userAt, 0, ...head.map((text): ContentBlock => ({ type: "text", text })))
  for (const text of tail) content.push({ type: "text", text })
}

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
 * block with the same policy lines, that group gives `""`, so a resume with
 * the same session context adds no second block. The compare reads the
 * bodies of the `policy` nodes (`sb.find`, design section 4), not the bytes:
 * a block in an older wire form (another escape) with the same lines counts
 * too. The search reads every text
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
import type { SidebandApi } from "../sideband/types.ts"

import {
  groupOrigin,
  type HookContextEntry,
  hookContextBlock,
  isHookContextEntry,
  splitHookContextPlaced,
  wrapHookContext,
} from "./hook-context.ts"

/**
 * Put the context `text` as one text block into user `content`, after the
 * leading `tool_result` blocks (they must stay first) and before the rest.
 * Returns the block, or `null` (and no change) when `text` is empty.
 * The block has the mark `sideband: { kind: "policy", origin? }`
 * ({@link hookContextBlock}).
 */
export function insertSessionContext(
  content: ContentBlock[],
  text: string,
  origin?: string,
): ContentBlock | null {
  if (!text) return null
  const block: ContentBlock = hookContextBlock(text, origin)
  const at = content.findIndex((b) => b.type !== "tool_result")
  content.splice(at === -1 ? content.length : at, 0, block)
  return block
}

/** The read part of the sideband API that the dedupe uses. */
export type SessionContextReader = Pick<SidebandApi, "find" | "strip">

/** The query of a session block: only `policy` nodes. */
const POLICY_ONLY = { kinds: ["policy"] } as const

/**
 * The bodies of the `policy` nodes of `text`, or `null` when `text` holds
 * other content too (a session block holds only policy tags).
 */
function policyBodies(sb: SessionContextReader, text: string): string[] | null {
  const nodes = sb.find(text, POLICY_ONLY)
  if (nodes.length === 0) return null
  if (sb.strip(text, POLICY_ONLY).trim() !== "") return null
  return nodes.map((n) => n.body ?? "")
}

/**
 * True when a user message in `history` has a text block with the same
 * session context as `text`: the same bytes, or the same `policy` bodies in
 * the same order (design section 4: a new escape gives no second block).
 * With no codec, only the same bytes count.
 *
 * Accepted risk (step 6 review m2): a user-typed message (or text block)
 * that holds ONLY policy tags with the same bodies, or the same bytes,
 * matches too, so that session context is not added again. Core cannot
 * limit the match to harness blocks: the session logs of older versions
 * have no `sideband` mark (only blocks that {@link insertSessionContext}
 * writes since design step 12c have it), so a mark-only rule would break
 * the resume dedupe of those sessions. The match needs a whole block of only
 * policy tags with equal bodies, so a real prompt that is mixed text never
 * matches; the cost of a match is one session context block not sent again
 * while the same text is already in the history.
 */
export function historyHasSessionBlock(
  sb: SessionContextReader,
  history: readonly Message[],
  text: string,
): boolean {
  const want = policyBodies(sb, text)
  const same = (other: string): boolean => {
    if (other === text) return true
    if (want === null) return false
    const got = policyBodies(sb, other)
    return got !== null && got.length === want.length && got.every((b, i) => b === want[i])
  }
  for (const m of history) {
    if (m.role !== "user") continue
    if (typeof m.content === "string") {
      if (same(m.content)) return true
      continue
    }
    for (const b of m.content) if (b.type === "text" && same(b.text)) return true
  }
  return false
}

/**
 * The two wrapped session context texts of one take. `""` means no block.
 * `beforeOrigin` and `afterOrigin` are the debug labels of the hooks that
 * wrote each group: they go on the block mark, not in the text.
 */
export interface SessionContextTake {
  before: string
  after: string
  beforeOrigin?: string
  afterOrigin?: string
}

/** The part of the sideband API that a take uses (render and dedupe). */
export type SessionContextSideband = Pick<SidebandApi, "render" | "find" | "strip">

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
   * `sb` renders the `policy` tags and reads the history for the dedupe.
   * The queue is empty after a take.
   */
  take(sb: SessionContextSideband, history: readonly Message[] = []): SessionContextTake {
    const placed = splitHookContextPlaced(this.pending)
    this.pending = []
    const inBefore = new Set(placed.before.map((e) => e.text))
    const after = placed.after.filter((e) => !inBefore.has(e.text))
    const take: SessionContextTake = {
      before: dedupe(sb, wrapHookContext(sb, placed.before), history),
      after: dedupe(sb, wrapHookContext(sb, after), history),
    }
    const beforeOrigin = groupOrigin(placed.before)
    const afterOrigin = groupOrigin(after)
    if (take.before.length > 0 && beforeOrigin !== undefined) take.beforeOrigin = beforeOrigin
    if (take.after.length > 0 && afterOrigin !== undefined) take.afterOrigin = afterOrigin
    return take
  }
}

function dedupe(sb: SessionContextReader, text: string, history: readonly Message[]): string {
  return text && historyHasSessionBlock(sb, history, text) ? "" : text
}

/**
 * Put both groups of a take into a later user message (not the first one of a
 * turn): after the leading `tool_result` blocks, before block first.
 */
export function insertSessionTake(content: ContentBlock[], take: SessionContextTake): void {
  insertSessionContext(content, take.after, take.afterOrigin)
  insertSessionContext(content, take.before, take.beforeOrigin)
}

/** The non-empty blocks of a take, before block first. Each has the `policy` mark. */
export function sessionTakeBlocks(take: SessionContextTake): ContentBlock[] {
  const out: ContentBlock[] = []
  if (take.before) out.push(hookContextBlock(take.before, take.beforeOrigin))
  if (take.after) out.push(hookContextBlock(take.after, take.afterOrigin))
  return out
}

/**
 * Assemble hook context into the first user message of a turn. `content`
 * holds the leading blocks (tool results, turn markers) and then the user
 * text blocks, which start at `userAt`. Before the user text: the session
 * before block, then the turn before block. After it: the session after
 * block, then the turn after block. Empty groups add no block. Each block
 * has the `policy` mark ({@link hookContextBlock}), with the origin label of
 * the hooks that wrote it.
 */
export function placeFirstMessageContext(
  sb: Pick<SidebandApi, "render">,
  content: ContentBlock[],
  userAt: number,
  session: SessionContextTake,
  turn: readonly unknown[] | undefined,
): void {
  const split = splitHookContextPlaced(turn)
  const turnBefore = wrapHookContext(sb, split.before)
  const turnAfter = wrapHookContext(sb, split.after)
  const head: ContentBlock[] = []
  if (session.before) head.push(hookContextBlock(session.before, session.beforeOrigin))
  if (turnBefore) head.push(hookContextBlock(turnBefore, groupOrigin(split.before)))
  content.splice(userAt, 0, ...head)
  if (session.after) content.push(hookContextBlock(session.after, session.afterOrigin))
  if (turnAfter) content.push(hookContextBlock(turnAfter, groupOrigin(split.after)))
}

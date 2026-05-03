/**
 * Session restore — pure functions to reconstruct a conversation from a
 * `<sid>.jsonl` log on disk. No I/O lives here beyond the tiny `loadSession`
 * convenience wrapper at the bottom; everything else is data → data so it's
 * trivially testable.
 *
 * Pipeline:
 *
 *   readFileSync → parseLines → foldRecords → repairTrailingTurn → messages
 *
 * The output `messages` array is in exactly the shape `Agent.messages`
 * uses internally and what we send to `/v1/messages`.
 */

import { readFileSync } from "node:fs"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import {
  type MetaRecord,
  parseLines,
  type SessionRecord,
  sessionFilePath,
} from "./session-store.ts"

// ---------------------------------------------------------------------------
// foldRecords — records → messages
// ---------------------------------------------------------------------------

/**
 * Fold a list of session records (in write order) into the `messages`
 * array shape Anthropic expects. Rules:
 *
 * - `meta` and `note` records are skipped (metadata only).
 * - `user` → push `{role:"user", content}`.
 * - `assistant` → push `{role:"assistant", content}`.
 * - `tool_result` → if the LAST message is `user` whose content is a
 *   block array, append a `tool_result` block to it; otherwise start a
 *   new `{role:"user", content:[<block>]}` message. This mirrors how the
 *   live agent loop assembles tool turns.
 * - `rewind` → truncate `messages[]` so the user message corresponding to
 *   `UserRecord.id === to` is the last message kept. Everything pushed
 *   after that user record (assistant, tool_result, later user) is
 *   dropped. Multiple rewinds compose because each is honored as it is
 *   walked. If `to` does not match any prior user record, the rewind is
 *   logged and skipped (defensive — append-only logs can in theory carry
 *   stale ids after a manual edit).
 */
export function foldRecords(records: SessionRecord[]): Message[] {
  const messages: Message[] = []
  // Map from UserRecord.id → index in `messages[]` of the user message it
  // produced. Maintained alongside `messages` so rewinds can find their
  // truncation point in O(1). Entries pointing past the current end of
  // `messages` are pruned on rewind.
  const userIdToIndex = new Map<string, number>()
  for (const rec of records) {
    switch (rec.kind) {
      case "meta":
      case "note":
        continue
      case "user": {
        const idx = messages.length
        messages.push({ role: "user", content: rec.content })
        if (rec.id) userIdToIndex.set(rec.id, idx)
        break
      }
      case "assistant":
        messages.push({ role: "assistant", content: rec.content })
        break
      case "tool_result": {
        const block: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: rec.tool_use_id,
          content: rec.content,
          is_error: rec.isError,
        }
        const last = messages[messages.length - 1]
        if (last && last.role === "user" && Array.isArray(last.content)) {
          last.content.push(block)
        } else {
          messages.push({ role: "user", content: [block] })
        }
        break
      }
      case "rewind": {
        const targetIdx = userIdToIndex.get(rec.to)
        if (targetIdx === undefined) {
          console.warn(
            `session-restore: rewind to unknown msgId ${rec.to} — skipping`,
          )
          break
        }
        // Keep messages[0..targetIdx] inclusive; drop the rest.
        messages.length = targetIdx + 1
        // Prune id → index entries that now point past the end.
        for (const [id, i] of userIdToIndex) {
          if (i > targetIdx) userIdToIndex.delete(id)
        }
        break
      }
    }
  }
  return messages
}

// ---------------------------------------------------------------------------
// repairTrailingTurn — drop trailing turns that would make the API reject
// ---------------------------------------------------------------------------

/**
 * Repair the message list so the Messages API accepts it. Two classes of
 * problems are removed:
 *
 * 1. Assistant messages whose `tool_use` blocks are not ALL matched by
 *    `tool_result` blocks in the IMMEDIATELY following user message.
 *    These are dropped (whole assistant turn). This catches both the
 *    "crashed mid-tool, no result was ever written" case and old orphan
 *    records that survive in the append-only log after a resume.
 *
 * 2. `tool_result` blocks in user messages whose `tool_use_id` does not
 *    refer to a kept preceding assistant `tool_use`. These are dropped
 *    block-by-block; if the user message becomes empty as a result, the
 *    whole message is dropped.
 *
 * Walks the list forward in a single pass. Idempotent: running repair on
 * an already-clean list is a no-op.
 *
 * Renamed from `repairTrailingTurn` (which only handled the tail). The
 * old name remains as an alias for back-compat.
 */
export function repairMessages(input: Message[]): Message[] {
  // Step 1: collect ids of tool_use blocks in assistant messages that
  // ARE matched by the immediately-following user's tool_results. The
  // assistants we drop are exactly those with one or more unmatched ids.
  const dropAssistantAt = new Set<number>()
  for (let i = 0; i < input.length; i++) {
    const msg = input[i]
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    const toolUseIds = msg.content
      .filter((b): b is ToolUseBlock => b.type === "tool_use")
      .map((b) => b.id)
    if (toolUseIds.length === 0) continue
    const next = input[i + 1]
    const nextResultIds = new Set<string>()
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const b of next.content) {
        if (b.type === "tool_result") nextResultIds.add((b as ToolResultBlock).tool_use_id)
      }
    }
    const allMatched = toolUseIds.every((id) => nextResultIds.has(id))
    if (!allMatched) dropAssistantAt.add(i)
  }

  // Step 2: collect the set of "live" tool_use ids — those declared by
  // assistants we are keeping. tool_result blocks referencing anything
  // outside this set are dropped.
  const liveIds = new Set<string>()
  for (let i = 0; i < input.length; i++) {
    if (dropAssistantAt.has(i)) continue
    const msg = input[i]
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue
    for (const b of msg.content) {
      if (b.type === "tool_use") liveIds.add(b.id)
    }
  }

  // Step 3: build the cleaned list.
  const out: Message[] = []
  for (let i = 0; i < input.length; i++) {
    if (dropAssistantAt.has(i)) continue
    const msg = input[i]
    if (msg.role === "user" && Array.isArray(msg.content)) {
      const filtered = msg.content.filter(
        (b) => b.type !== "tool_result" || liveIds.has((b as ToolResultBlock).tool_use_id),
      )
      if (filtered.length === 0) continue
      out.push({ role: "user", content: filtered })
    } else {
      // Defensive copy of arrays so callers can mutate freely.
      out.push({
        ...msg,
        content: typeof msg.content === "string" ? msg.content : [...msg.content],
      })
    }
  }
  return out
}

/** Back-compat alias for `repairMessages`. */
export const repairTrailingTurn = repairMessages

// ---------------------------------------------------------------------------
// loadSession — top-level convenience: path → { meta, messages, dropped }
// ---------------------------------------------------------------------------

export interface LoadedSession {
  meta: MetaRecord | null
  records: SessionRecord[]
  messages: Message[]
  dropped: { line: number; reason: string }[]
  /** True when `repairTrailingTurn` removed at least one message. */
  repaired: boolean
}

export function loadSessionFromText(text: string): LoadedSession {
  const { records, dropped } = parseLines(text)
  const meta = (records.find((r) => r.kind === "meta") as MetaRecord | undefined) ?? null
  const folded = foldRecords(records)
  const messages = repairMessages(folded)
  // "repaired" = anything changed: a message was dropped OR a message's
  // content shrank (orphan tool_result blocks filtered out).
  let repaired = messages.length !== folded.length
  if (!repaired) {
    for (let i = 0; i < folded.length; i++) {
      const a = folded[i].content
      const b = messages[i].content
      if (Array.isArray(a) && Array.isArray(b) && a.length !== b.length) {
        repaired = true
        break
      }
    }
  }
  return { meta, records, messages, dropped, repaired }
}

export function loadSession(sid: string, dir?: string): LoadedSession {
  const path = sessionFilePath(sid, dir)
  const text = readFileSync(path, "utf-8")
  return loadSessionFromText(text)
}

// ---------------------------------------------------------------------------
// Re-export shape helpers (useful for callers building previews)
// ---------------------------------------------------------------------------

export function firstUserPromptSnippet(records: SessionRecord[], maxLen = 60): string {
  for (const r of records) {
    if (r.kind === "user") {
      const text =
        typeof r.content === "string"
          ? r.content
          : r.content
              .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
              .map((b) => b.text)
              .join(" ")
      const oneLine = text.replace(/\s+/g, " ").trim()
      return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 3)}...` : oneLine
    }
  }
  return ""
}

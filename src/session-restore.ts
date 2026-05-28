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
 * - `assistant` → push `{role:"assistant", content}`. The block array is
 *   pushed verbatim, which means `thinking` blocks (and their
 *   cryptographic `signature` fields) ride back into history unchanged.
 *   That round-trip is what lets the `redact-thinking-2026-02-12` beta
 *   keep working across resume — see `AssistantRecord` in
 *   `session-store.ts` for the persistence-side note.
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
          console.warn(`session-restore: rewind to unknown msgId ${rec.to} — skipping`)
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
 * Repair the message list so the Messages API accepts it. Three classes
 * of problems are removed:
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
 * 3. Consecutive `user` messages in the output. The Anthropic API
 *    rejects `[user, user]` with "messages: roles must alternate". This
 *    pattern arises in append-only logs across multiple resumes: run 1
 *    appends `user(A) + assistant(tool_use)` then crashes; run 2 loads,
 *    surfaces `user(A)` as `pendingDraft`, the user discards it and
 *    types `user(B)`, which appends to the same log; run 3 loads and
 *    repair-step-1 drops the orphan assistant, leaving `[user(A),
 *    user(B), …]`. We drop the EARLIER user (it was never replied to,
 *    and the later one is the conversation the user actually moved on
 *    to). The dropped prompt is unrecoverable here — its retry chance
 *    was at the FIRST resume via `pendingDraft`. Surfacing it at run 3
 *    would be wrong because the user already chose to move on.
 *
 * Walks the list in passes (assistant drop, tool_result filter,
 * consecutive-user collapse). Idempotent: running repair on an
 * already-clean list is a no-op.
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
      // Step 3b: REORDER so all tool_result blocks come first within the
      // user message. The Anthropic API requires tool_result blocks to be
      // the first blocks of the user message that immediately follows an
      // assistant tool_use turn — anything in front of them returns:
      //   "tool_use ids were found without tool_result blocks
      //    immediately after"
      // The agent's runtime already constructs userContent as
      // `[...toolResults, queuedText?, modeAttach?]`, but the session log
      // is append-only and on-disk record order can interleave a user
      // text record between the assistant and its tool_result records
      // (e.g. when a queued user submit's appendUser races with the
      // for-tools loop's appendToolResult). foldRecords then attaches the
      // tool_result onto the existing `[text]` user message, producing
      // `[text, tool_result]`. Sort here — stable so original ordering
      // among tool_results (and among non-tool_result blocks) is preserved.
      const ordered = [
        ...filtered.filter((b) => b.type === "tool_result"),
        ...filtered.filter((b) => b.type !== "tool_result"),
      ]
      out.push({ role: "user", content: ordered })
    } else {
      // Defensive copy of arrays so callers can mutate freely.
      out.push({
        ...msg,
        content: typeof msg.content === "string" ? msg.content : [...msg.content],
      })
    }
  }

  // Step 4: collapse consecutive `user` messages by dropping all but
  // the LAST in each run. The latest user prompt is the one the
  // conversation actually continued from; earlier ones in the same run
  // were orphaned (never replied to), typically because an assistant
  // turn between them was dropped by step 1 (the "crashed mid-tool"
  // pattern across multiple resumes). See the function doc for the
  // full scenario.
  //
  // Walks backwards so the last user in each run is naturally retained
  // and we can drop the earlier ones in place without index juggling.
  const collapsed: Message[] = []
  for (let i = out.length - 1; i >= 0; i--) {
    const cur = out[i]
    const prev = collapsed[collapsed.length - 1] // already-pushed = NEXT in original order
    if (cur.role === "user" && prev?.role === "user") {
      // `cur` is an EARLIER user that's immediately followed by another
      // user in the output. Drop `cur`. We don't merge content: tool_result
      // blocks (load-bearing for the next API call) live in the LATER user
      // message and would be re-ordered destructively, and plain prompts
      // here represent abandoned-then-replaced intent that the user
      // already chose to move past.
      continue
    }
    collapsed.push(cur)
  }
  collapsed.reverse()
  return collapsed
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
  /**
   * Text the user typed into the editor and pressed Enter on, but which
   * never got an assistant reply (the agent aborted, crashed, or was
   * killed before any tokens streamed). Surfaced separately from
   * `messages` so the REPL can prefill the editor with it on resume
   * instead of sending the model a `[..., user, user]` sequence that the
   * API would reject. Detected by `extractPendingDraft` (see below);
   * `null` when no trailing human-authored user text exists. When set,
   * the corresponding message is ALREADY popped from `messages` so
   * `messages` is API-clean on its own.
   */
  pendingDraft: string | null
}

/**
 * Pop the trailing user message from `messages` if it represents a
 * "human typed something, hit Enter, and the agent never replied"
 * situation. Returns the joined text (cursor-restorable into the
 * editor) and mutates `messages` in place. Returns `null` and leaves
 * `messages` untouched in every other case.
 *
 * The check is deliberately strict, mistakenly popping a real message
 * would silently lose conversation history. We require ALL of:
 *
 * 1. `messages` is non-empty AND the last message has `role: "user"`.
 *    (Trailing assistant means the model finished a turn cleanly.)
 * 2. The user message's content is a block array (not a bare string).
 *    Strings are foldRecords' historical shape for plain-text turns;
 *    new turns always use blocks. A string trailing-user is suspicious
 *    enough that we leave it for human inspection rather than pop.
 * 3. NO block in the user message is a `tool_result`. A trailing user
 *    message with tool_results is the "crashed mid-tool" case; that's
 *    already handled by `repairMessages` (the orphan assistant gets
 *    dropped, then the user message gets dropped via empty-content).
 *    If repair somehow left tool_results in place, they're load-bearing,
 *    don't touch.
 * 4. At least one `text` block exists with non-empty text after trim.
 *    An attachment-only user message (e.g. just a `<mode-change>` tag
 *    with no human prose) is runtime plumbing, not a draft.
 *
 * When all four hold, every `text` block's text is joined with `\n\n`
 * (matching how the agent's `appendUser` reassembles split prose) and
 * returned trimmed.
 */
export function extractPendingDraft(messages: Message[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return null
  if (!Array.isArray(last.content)) return null
  const hasToolResult = last.content.some((b) => b.type === "tool_result")
  if (hasToolResult) return null
  const texts = last.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
  if (texts.length === 0) return null
  const joined = texts.join("\n\n").trim()
  if (joined.length === 0) return null
  messages.pop()
  return joined
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
  // Extract the trailing unsent draft (mutates `messages` if found). See
  // `extractPendingDraft` JSDoc for the four-condition guard. This must
  // run AFTER `repairMessages` so the "crashed mid-tool" case (whose
  // user message contains tool_results) is already filtered out and
  // can't be mistaken for a draft.
  const pendingDraft = extractPendingDraft(messages)
  return { meta, records, messages, dropped, repaired, pendingDraft }
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

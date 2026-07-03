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

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"

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
 * True for a `text` content block whose text is empty (or whitespace-only /
 * missing). The Anthropic Messages API rejects these with "messages: text
 * content blocks must be non-empty"; OpenAI-compatible providers emit them
 * (see step 4 of {@link repairMessages}). Non-text blocks are never empty by
 * this definition.
 */
function isEmptyTextBlock(b: ContentBlock): boolean {
  return b.type === "text" && (b.text ?? "").trim().length === 0
}

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
 *    repair-step-1 drops the orphan assistant, leaving `[user(A), user(B), …]`. We drop the EARLIER user (it was never replied to,
 *    and the later one is the conversation the user actually moved on
 *    to). The dropped prompt is unrecoverable here — its retry chance
 *    was at the FIRST resume via `pendingDraft`. Surfacing it at run 3
 *    would be wrong because the user already chose to move on.
 *
 * 4. Empty `text` content blocks (`{type:"text", text:""}`). The
 *    Anthropic API rejects these with "messages: text content blocks
 *    must be non-empty". They are emitted by OpenAI-compatible stream
 *    assemblers (Ollama/OpenAI) whenever a model interleaves a trailing
 *    empty text block after a `tool_use` — the bridge's single-`cur`
 *    model flushes the real text on the `tool_use_start`, then the
 *    deferred `text_stop` manufactures a `""` block (see the "empty text
 *    fallback" in adapter-legacy.ts and client.ts). Those providers
 *    tolerate the empty block, so it lands in the persisted assistant
 *    record; resuming the SAME session under Anthropic then 400s. We
 *    drop every empty text block here so a transcript written under a
 *    permissive provider resumes cleanly under a strict one. If dropping
 *    empties a message entirely, the whole message is dropped too.
 *
 * Walks the list in passes (assistant drop, tool_result + empty-text
 * filter, consecutive-user collapse). Idempotent: running repair on an
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
        (b) =>
          !isEmptyTextBlock(b) &&
          (b.type !== "tool_result" || liveIds.has((b as ToolResultBlock).tool_use_id)),
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
    } else if (Array.isArray(msg.content)) {
      // Assistant (or any array-content) message: strip empty text blocks
      // the API rejects ("text content blocks must be non-empty"). These
      // arise as a trailing `{type:"text", text:""}` after a tool_use when
      // the source was an OpenAI-compatible provider; see step 4 in the
      // function doc. If the message empties out entirely, drop it (step 4's
      // consecutive-user collapse then handles any [user, user] adjacency
      // the drop exposes).
      const filtered = msg.content.filter((b) => !isEmptyTextBlock(b))
      if (filtered.length === 0) continue
      out.push({ ...msg, content: filtered })
    } else {
      // Defensive copy so callers can mutate freely (string content).
      out.push({ ...msg, content: msg.content })
    }
  }

  // Step 4: collapse consecutive `user` messages. Two distinct
  // scenarios produce a `[user, user]` adjacency in `out`:
  //
  // 1. ABANDONED PROMPT across multi-resume. Run 1 appends
  //    `user(A) + assistant(tool_use)` then crashes. Run 2 surfaces
  //    user(A) as `pendingDraft`; the user discards it and types
  //    `user(B)`, which appends to the same log. Run 3 loads,
  //    step 1 drops the orphan assistant, leaving `[user(A), user(B)]`.
  //    user(A) is pure text, never replied to. The user already chose
  //    to move on; we drop user(A).
  //
  // 2. TOOL-RESULT SPLIT in a clean live turn. Sequence on disk:
  //      asst(tool_use X) → tool_result(X) → user("new prompt")
  //    foldRecords synthesizes a user message for the tool_result
  //    (because the preceding message is an assistant) and ALSO pushes
  //    a user message for the explicit user record. Result:
  //      [asst(tool_use X), user([tool_result X]), user([text])]
  //    The earlier user carries the load-bearing tool_result that
  //    pairs with the assistant's tool_use. Dropping it (the original
  //    naive policy) leaves the assistant orphaned and the next API
  //    send 400s with "tool_use ids were found without tool_result
  //    blocks immediately after". Instead: PREPEND any tool_result
  //    blocks from the earlier user onto the later user (preserving
  //    the tool_results-first invariant from step 3b), then drop the
  //    earlier user's shell.
  //
  // Walks backwards so the last user in each run is naturally retained
  // and we can transfer/drop the earlier ones in place without index
  // juggling.
  const collapsed: Message[] = []
  for (let i = out.length - 1; i >= 0; i--) {
    const cur = out[i]
    const prev = collapsed[collapsed.length - 1] // already-pushed = NEXT in original order
    if (cur.role === "user" && prev?.role === "user") {
      // Salvage any tool_result blocks from `cur` (the earlier user)
      // into `prev` (the later user). Non-tool-result content from
      // `cur` is dropped : in scenario 1 it's an abandoned prompt; in
      // scenario 2 the earlier user only carries tool_results anyway.
      if (Array.isArray(cur.content) && Array.isArray(prev.content)) {
        const carriedResults = cur.content.filter((b) => b.type === "tool_result")
        if (carriedResults.length > 0) {
          // Prepend so tool_results stay first in the merged message.
          // `prev.content` already has its own tool_results at the
          // front (step 3b), so we end up with
          //   [...cur.tool_results, ...prev.tool_results, ...prev.rest]
          // which is the order the API requires.
          prev.content = [...carriedResults, ...prev.content]
        }
      }
      continue
    }
    collapsed.push(cur)
  }
  collapsed.reverse()
  return collapsed
}

/** Back-compat alias for `repairMessages`. */
export const repairTrailingTurn = repairMessages

/**
 * Append a fresh user turn to `messages`, coalescing into a trailing `user`
 * message instead of producing a `[user, user]` adjacency (which the
 * Anthropic API rejects with "roles must alternate"). Mutates in place.
 *
 * This is the live-append counterpart to `repairMessages`' consecutive-user
 * collapse. It matters on resume after a force-quit that stranded tool_results
 * without their assistant continuation: `extractPendingDraft` pulls the
 * un-replied prompt into the editor, leaving `user([tool_results])` as the
 * tail. The next submit must merge into that message rather than appending a
 * second user message, keeping tool_results FIRST (the API requires them
 * immediately after the assistant's `tool_use`). The merged shape
 * `[...tool_results, ...text]` also matches the live queued-submit layout, so
 * a later resume folds the on-disk records back to the identical history.
 *
 * In the steady state the last message is an assistant turn (or the history
 * is empty), so a fresh user message is pushed : byte-identical to the old
 * unconditional `messages.push`.
 */
export function appendUserTurn(messages: Message[], content: ContentBlock[]): void {
  const last = messages[messages.length - 1]
  if (last?.role === "user" && Array.isArray(last.content)) {
    const toolResults = last.content.filter((b) => b.type === "tool_result")
    const rest = last.content.filter((b) => b.type !== "tool_result")
    last.content = [...toolResults, ...rest, ...content]
  } else {
    messages.push({ role: "user", content })
  }
}

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
 * Recognize a `text` block that is runtime plumbing the agent's send-seam
 * prepends to a user turn (short-term-memory snapshot, tasks attachment,
 * mode-change chip, memory save-echo, reflection / emergency markers) rather
 * than human-typed prose. These are regenerated on the next submit, so they
 * must never leak into the prefilled editor draft.
 */
function isAttachmentText(text: string): boolean {
  const s = text.trimStart()
  return (
    s.startsWith("<ma::plugin::") ||
    s.startsWith("<ma::agent::") ||
    s.startsWith("<mode-change") ||
    s.startsWith("<memory-saved")
  )
}

/**
 * Extract the trailing "human typed something, hit Enter, and the agent never
 * replied" prompt so the REPL can prefill it back into the editor on resume
 * instead of replaying it into scrollback as a sent-but-unanswered turn.
 * Returns the joined human text (cursor-restorable) and mutates `messages` in
 * place; returns `null` and leaves `messages` untouched in every other case.
 *
 * Requirements:
 *
 * 1. `messages` is non-empty AND the last message has `role: "user"`.
 *    (Trailing assistant means the model finished a turn cleanly.)
 * 2. The user message's content is a block array (not a bare string).
 *    Strings are foldRecords' historical shape for plain-text turns; a string
 *    trailing-user is suspicious enough that we leave it for inspection.
 * 3. At least one `text` block carries non-empty HUMAN text after trim, where
 *    "human" excludes the attachment blocks {@link isAttachmentText} matches.
 *    An attachment-only message is plumbing, not a draft.
 *
 * Tool-result handling: the message may ALSO carry `tool_result` blocks. That
 * happens when a queued submit landed in the same on-disk turn as a tool round
 * (`repairMessages` merges the tool_results forward onto the surviving last
 * user message). Those blocks are load-bearing : they pair with the preceding
 * assistant's `tool_use`, so we KEEP them (rebuild the message with only the
 * tool_results) rather than dropping the whole message and orphaning the
 * assistant. The human text is still pulled out as the draft. When there are
 * no tool_results, the whole message is popped.
 *
 * The human `text` blocks are joined with `\n\n` (matching how `appendUser`
 * reassembles split prose) and returned trimmed.
 */
export function extractPendingDraft(messages: Message[]): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return null
  if (!Array.isArray(last.content)) return null
  const humanTexts = last.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .filter((t) => !isAttachmentText(t))
  const joined = humanTexts.join("\n\n").trim()
  if (joined.length === 0) return null
  // Preserve any load-bearing tool_results so the preceding assistant turn
  // stays valid; otherwise pop the whole message.
  const toolResults = last.content.filter((b) => b.type === "tool_result")
  if (toolResults.length > 0) {
    last.content = toolResults
  } else {
    messages.pop()
  }
  return joined
}

/**
 * Parses raw JSONL transcript text into a resumable session: folds records
 * into messages, repairs structural damage from crashes (orphan tool_use /
 * tool_result pairs), and extracts any pending draft the user typed but never
 * sent. `dropped` and `repaired` report how lossy the load was so callers can
 * warn the user.
 */
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

/**
 * Reads a session transcript from disk by id and runs it through
 * {@link loadSessionFromText}. Throws (ENOENT) when no transcript exists for
 * the id.
 */
export function loadSession(sid: string, dir?: string): LoadedSession {
  const path = sessionFilePath(sid, dir)
  const text = readFileSync(path, "utf-8")
  return loadSessionFromText(text)
}

// ---------------------------------------------------------------------------
// Re-export shape helpers (useful for callers building previews)
// ---------------------------------------------------------------------------

/**
 * One-line preview of the session's first user prompt, whitespace-collapsed
 * and ellipsis-truncated to `maxLen`. Returns `""` when the transcript has no
 * user record. Used by session pickers and resume banners.
 */
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

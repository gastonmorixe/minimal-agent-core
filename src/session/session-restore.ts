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

import { isRuntimeAttachmentText } from "../agent/runtime-attachments.ts"
import type { StructuredData } from "../bus/diagnostic-bus.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import type {
  ContentBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "../llm/messages.ts"
import { appendUserTurn } from "../sdk/conversation-history.ts"
import { withoutThinking } from "../sdk/target-change.ts"
import {
  outcomeTextOf,
  type ToolOutcomeRecordReport,
  validatePersistedToolOutcome,
} from "../sdk/tool-outcome-record.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { SidebandReader } from "../sideband/types.ts"

import {
  type MetaRecord,
  parseLines,
  type SessionRecord,
  sessionFilePath,
} from "./session-store.ts"

export { appendUserTurn }

// ---------------------------------------------------------------------------
// foldRecords — records → messages
// ---------------------------------------------------------------------------

/**
 * How to fold durable `compact` records into model-facing history.
 *
 * - `since-last-compact` (default): drop pre-checkpoint transcript and
 *   inject the compact's replacementMessages, then continue with later
 *   turns. Matches live post-compact `messages[]`.
 * - `full`: ignore compact checkpoints (force full resend, e.g. after
 *   switching to a larger-window model). Display folds always use full.
 * - `ignore-last-n`: skip the last N compact checkpoints (0 = same as
 *   since-last-compact; large N approaches full).
 */
export type CompactSendPolicy =
  | { mode: "since-last-compact" }
  | { mode: "full" }
  | { mode: "ignore-last-n"; n: number }

/**
 * Fold a list of session records (in write order) into the `messages`
 * array shape Anthropic expects. Rules:
 *
 * - `meta`, `note`, `attach`, `detach`, and `compact` records are skipped
 *   for **display** (metadata only; compact never deletes history).
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
 *
 * Prefer {@link foldRecordsForDisplay} / {@link foldRecordsForModel} at
 * call sites so intent is explicit. This name remains the display fold
 * (full history) for back-compat.
 */
export function foldRecords(records: SessionRecord[]): Message[] {
  return foldRecordsForDisplay(records)
}

/**
 * Full transcript for UI / `--resume` replay. Never applies compact
 * checkpoints: jsonl stays append-only and the user sees everything.
 */
export function foldRecordsForDisplay(
  records: SessionRecord[],
  diagnostics?: Diagnostics,
): Message[] {
  return foldRecordsInternal(records, { applyCompacts: false, diagnostics, reportOutcome: true })
    .messages
}

/**
 * Compact checkpoints positioned against the display-fold message list.
 * `afterMessageIndex` is `messages.length` at the compact record in the
 * same walk as {@link foldRecordsForDisplay} (tool_result merge/new-user
 * and rewind included).
 */
export interface CompactDisplayBoundary {
  afterMessageIndex: number
  record: Extract<SessionRecord, { kind: "compact" }>
}

/**
 * Compact boundaries in `records` order, for TUI replay. Each entry names the
 * transcript position (`afterMessageIndex`) where a compact checkpoint sits
 * plus the record itself, so resume can paint the boundary instead of a fake
 * message. Model history is left untouched (`applyCompacts: false`).
 *
 * @param records - Session records in write order.
 * @returns One boundary per compact record, oldest first.
 */
export function compactDisplayBoundaries(records: SessionRecord[]): CompactDisplayBoundary[] {
  return foldRecordsInternal(records, { applyCompacts: false, collectCompactBoundaries: true })
    .compactBoundaries
}

/**
 * Model-facing history. By default starts from the last durable compact
 * checkpoint (replacementMessages + later turns). Pass `policy` to force
 * a full resend or ignore the last N compacts. Fold warnings go to
 * `diagnostics` (S20). Default: the process bus, no session id.
 */
export function foldRecordsForModel(
  records: SessionRecord[],
  policy: CompactSendPolicy = { mode: "since-last-compact" },
  diagnostics?: Diagnostics,
): Message[] {
  const base = { diagnostics, discardSwitchedThinking: true }
  if (policy.mode === "full") {
    return foldRecordsInternal(records, { ...base, applyCompacts: false }).messages
  }
  const skipLastCompacts = policy.mode === "ignore-last-n" ? Math.max(0, policy.n) : 0
  return foldRecordsInternal(records, { ...base, applyCompacts: true, skipLastCompacts }).messages
}

/**
 * The target of the newest target-switch record, or `null` when the session
 * never changed its target. A resume uses it over the `meta` record.
 */
export function lastTargetSwitch(
  records: SessionRecord[],
): Extract<SessionRecord, { kind: "target_switch" }> | null {
  const found = records.findLast((r) => r.kind === "target_switch")
  return found?.kind === "target_switch" ? found : null
}

/**
 * Checkpoint messages named by a compact row `meta`. The fold adds them and
 * repair keeps the mark across its copies. A message outside this set falls
 * back to the marker text match.
 */
const checkpointMessages = new WeakSet<Message>()

/**
 * The one restore check of a stored `outcome` (SPEC v6.1 D8 rules 5, 6 and
 * 8), for a `tool_result` record and for a `tool_result` block in a compact
 * `replacementMessages` copy. It checks the shape, the caps and the offsets
 * against the text of `block.content` ({@link validatePersistedToolOutcome}).
 * A valid value goes on the block as `outcome`. Else the block gets no
 * `outcome` key (an old key is removed). `content` does not change.
 *
 * @param block - The restored block. Changed in place.
 * @param stored - The stored `outcome` value, or `undefined`.
 * @param report - Optional diagnostic sink (over-cap and data drops).
 * @param tool - Optional tool name for the diagnostic data.
 */
function restoreToolResultOutcome(
  block: ToolResultBlock,
  stored: unknown,
  report: ToolOutcomeRecordReport | undefined,
  tool: string | undefined,
): void {
  // Restore never throws on bad stored data: `outcomeTextOf` is safe for a
  // bad `content`, and the try catches each other read of the stored value.
  // A `content` that is not a string and not an array (for example `null`)
  // gets no outcome. On an error the block gets no outcome; the rest of the
  // record stays.
  let outcome: ReturnType<typeof validatePersistedToolOutcome>
  try {
    const content: unknown = block.content
    outcome =
      stored === undefined || (typeof content !== "string" && !Array.isArray(content))
        ? undefined
        : validatePersistedToolOutcome(stored, outcomeTextOf(content), report, tool)
  } catch {
    outcome = undefined
  }
  if (outcome === undefined) delete block.outcome
  else block.outcome = outcome
}

/** True for a content item that is a non-null object (stored data can hold `null`). */
function isBlockObject(b: unknown): b is { type?: unknown } {
  return typeof b === "object" && b !== null
}

/**
 * Remove each item that is not a non-null object from a stored array
 * `content` (bad stored data: a torn or hand-edited JSONL line). The code
 * after the fold (`repairMessages`) reads `b.type` on each item, and a `null`
 * item throws there. Gives the same array when all items are objects, and
 * the value itself when it is not an array (that path does not iterate it).
 */
function withoutBadItems<T>(content: T): T {
  if (!Array.isArray(content)) return content
  return (content.every(isBlockObject) ? content : content.filter(isBlockObject)) as T
}

/**
 * Record the tool name of each `tool_use` item of a stored `content`, for the
 * diagnostic data of a dropped outcome. Safe for bad stored data: a
 * `content` that is not an array, and an item that is not a non-null object
 * or has no string `id` and `name`, are skipped. Never throws.
 */
function recordToolNames(content: unknown, toolNames: Map<string, string>): void {
  if (!Array.isArray(content)) return
  for (const b of content as unknown[]) {
    if (!isBlockObject(b) || b.type !== "tool_use") continue
    const { id, name } = b as { id?: unknown; name?: unknown }
    if (typeof id === "string" && typeof name === "string") toolNames.set(id, name)
  }
}

function foldRecordsInternal(
  records: SessionRecord[],
  opts: {
    applyCompacts: boolean
    skipLastCompacts?: number
    collectCompactBoundaries?: boolean
    diagnostics?: Diagnostics | undefined
    /**
     * Report a stored outcome that restore drops for an E14 cap. Only the
     * display fold sets it, so one load gives one diagnostic for each record.
     */
    reportOutcome?: boolean
    /** Drop the thinking that a target switch discarded (model folds only). */
    discardSwitchedThinking?: boolean
  },
): { messages: Message[]; compactBoundaries: CompactDisplayBoundary[] } {
  const diagnostics = opts.diagnostics ?? processDiagnostics()
  const warnOutcome: ToolOutcomeRecordReport = (id, data) =>
    diagnostics.warn(id, "", data as StructuredData)
  const reportOutcome: ToolOutcomeRecordReport | undefined = opts.reportOutcome
    ? warnOutcome
    : undefined
  // tool_use id -> tool name, for the diagnostic data of a dropped outcome.
  const toolNames = new Map<string, string>()
  const messages: Message[] = []
  const compactBoundaries: CompactDisplayBoundary[] = []
  // Map from UserRecord.id → index in `messages[]` of the user message it
  // produced. Maintained alongside `messages` so rewinds can find their
  // truncation point in O(1). Entries pointing past the current end of
  // `messages` are pruned on rewind.
  const userIdToIndex = new Map<string, number>()

  // Which compact records to honor: all but the last `skipLastCompacts`.
  let compactOrdinal = 0
  let totalCompacts = 0
  if (opts.applyCompacts) {
    for (const r of records) {
      if (r.kind === "compact") totalCompacts++
    }
  }
  const skipLast = opts.skipLastCompacts ?? 0
  const applyThroughOrdinal = totalCompacts - skipLast // exclusive upper bound of skipped tail

  // The model fold drops the thinking of each assistant record before the
  // last target switch that discarded thinking (see `TargetSwitchRecord`).
  let lastDiscardAt = -1
  if (opts.discardSwitchedThinking) {
    lastDiscardAt = records.findLastIndex((r) => r.kind === "target_switch" && r.discardedThinking)
  }
  let at = -1
  const beforeSwitch = (role: Message["role"]): boolean =>
    role === "assistant" && at < lastDiscardAt

  for (const rec of records) {
    at++
    switch (rec.kind) {
      case "meta":
      case "note":
      case "history_edit":
      case "round_checkpoint":
      case "target_switch":
      case "attach":
      case "detach":
        continue
      case "compact": {
        if (opts.collectCompactBoundaries) {
          compactBoundaries.push({ afterMessageIndex: messages.length, record: rec })
        }
        if (!opts.applyCompacts) continue
        const ord = compactOrdinal++
        // Skip last N: only apply when ord < applyThroughOrdinal.
        if (ord >= applyThroughOrdinal) continue
        // Replace model history with the checkpoint replacement + clear
        // user id map (pre-compact ids are no longer in messages).
        messages.length = 0
        userIdToIndex.clear()
        for (const m of rec.replacementMessages) {
          // Bad stored items (`null`, a number) are removed (see withoutBadItems).
          const stored = withoutBadItems(m.content)
          const restored: Message = {
            role: m.role,
            content:
              typeof stored === "string"
                ? [{ type: "text", text: stored }]
                : // Deep copy: the restored history must not alias the stored
                  // JSONL record (later turns mutate their own blocks).
                  structuredClone(
                    Array.isArray(stored) && beforeSwitch(m.role)
                      ? withoutThinking(stored)
                      : stored,
                  ),
          }
          // SPEC v6.1 D8: the same outcome check as a tool_result record.
          // Only a model fold applies a compact, so this fold reports the
          // drops of the copies (the display fold reports the records).
          // Bad stored data (a `null` item, an item with no `type`) is
          // skipped here and kept in the content as before W2.
          if (Array.isArray(restored.content)) {
            recordToolNames(restored.content, toolNames)
            for (const b of restored.content as unknown[]) {
              if (!isBlockObject(b) || b.type !== "tool_result") continue
              const block = b as ToolResultBlock
              restoreToolResultOutcome(
                block,
                block.outcome,
                warnOutcome,
                toolNames.get(block.tool_use_id),
              )
            }
          }
          // A row with `meta` names its checkpoint: the first replacement.
          if (rec.meta && messages.length === 0) checkpointMessages.add(restored)
          messages.push(restored)
        }
        break
      }
      case "user": {
        const idx = messages.length
        messages.push({ role: "user", content: withoutBadItems(rec.content) })
        if (rec.id) userIdToIndex.set(rec.id, idx)
        break
      }
      case "assistant": {
        // Record the tool names before the early break, from the full record.
        // Safe for bad stored data (`content: null`, a `null` item).
        recordToolNames(rec.content, toolNames)
        // A target switch discarded this thinking in the live session.
        // A content that is not an array (bad stored data) is kept as is.
        // Bad stored items are removed (see withoutBadItems).
        const stored = withoutBadItems(rec.content)
        const isArray = Array.isArray(stored)
        const content = isArray && beforeSwitch("assistant") ? withoutThinking(stored) : stored
        // Only thinking: no message. `repairMessages` joins the user messages.
        if (isArray && content.length === 0 && stored.length > 0) break
        messages.push(
          rec.providerMessageId
            ? { role: "assistant", content, providerMessageId: rec.providerMessageId }
            : { role: "assistant", content },
        )
        break
      }
      case "tool_result": {
        // SPEC v6.1 D8 rules 5, 6 and 8: a valid stored `outcome` goes on the
        // block as metadata. A bad shape is dropped from the block, with no
        // diagnostic (the record is not rewritten). A value over a cap is
        // dropped with one `tool-outcome.record-dropped`. No record value: no key.
        const block: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: rec.tool_use_id,
          content: rec.content,
          is_error: rec.isError,
          ...(rec.sideband && { sideband: rec.sideband }),
        }
        restoreToolResultOutcome(block, rec.outcome, reportOutcome, toolNames.get(rec.tool_use_id))
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
          diagnostics.warn(
            "session-restore.rewind-unknown",
            `rewind to unknown msgId ${rec.to}; skipping`,
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
  return { messages, compactBoundaries }
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
 * True when the assistant at `i` is the last one and only a user message of
 * `tool_result` blocks follows it: the tool round a kill cut off. Resume
 * keeps it, and the core adds the missing results (decision 31).
 */
function isCutOffToolTurn(input: Message[], i: number): boolean {
  if (i === input.length - 1) return true
  const next = input[i + 1]
  return (
    i === input.length - 2 &&
    next.role === "user" &&
    Array.isArray(next.content) &&
    next.content.every((b) => b.type === "tool_result")
  )
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
 *    `opts.keepCutOffToolCalls` keeps the last tool round a kill cut off
 *    (see {@link isCutOffToolTurn}). Use it only for a turn that resumes.
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
 *    fallback" in the old adapter-legacy.ts and client.ts). Those providers
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
export function repairMessages(
  input: Message[],
  opts?: {
    keepCutOffToolCalls?: boolean
    /**
     * The sideband reader that finds a compaction checkpoint in old history
     * (design step 8). A checkpoint that this fold made is known without
     * it. Default `NO_SIDEBAND`: an old checkpoint text is not detected, so
     * the collapse drops its text like a plain earlier user.
     */
    sideband?: SidebandReader
  },
): Message[] {
  const sb = opts?.sideband ?? NO_SIDEBAND
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
    if (!allMatched && !(opts?.keepCutOffToolCalls && isCutOffToolTurn(input, i))) {
      dropAssistantAt.add(i)
    }
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
      const kept: Message = { role: "user", content: ordered }
      if (checkpointMessages.has(msg)) checkpointMessages.add(kept)
      out.push(kept)
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
      const kept: Message = { ...msg, content: filtered }
      if (checkpointMessages.has(msg)) checkpointMessages.add(kept)
      out.push(kept)
    } else {
      // Defensive copy so callers can mutate freely (string content).
      const kept: Message = { ...msg, content: msg.content }
      if (checkpointMessages.has(msg)) checkpointMessages.add(kept)
      out.push(kept)
    }
  }

  // Step 4: collapse consecutive `user` messages. Three distinct
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
  // 3. DURABLE COMPACT CHECKPOINT. `foldRecordsForModel` injects the
  //    compact's replacementMessages (often a single user checkpoint)
  //    then continues with later user turns. That yields
  //    `[user(checkpoint), user(next prompt), …]`. Dropping the
  //    checkpoint would erase the whole point of compact. Merge the
  //    checkpoint text into the later user as a leading text block.
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
      // Exception: compact checkpoints (scenario 3) keep their text.
      if (checkpointMessages.has(cur) || isCompactionCheckpointMessage(cur, sb)) {
        mergeUserContentInto(prev, cur, { keepText: true })
      } else if (Array.isArray(cur.content) && Array.isArray(prev.content)) {
        const carriedResults = cur.content.filter((b) => b.type === "tool_result")
        if (carriedResults.length > 0) {
          // Prepend so tool_results stay first in the merged message.
          // `prev.content` already has its own tool_results at the
          // front (step 3b), so we end up with
          //   [...cur.tool_results, ...prev.tool_results, ...prev.rest]
          // which is the order the API requires.
          prev.content = [...carriedResults, ...prev.content]
        }
      } else if (Array.isArray(cur.content) && typeof prev.content === "string") {
        // Later user is plain string; still salvage tool_results if any.
        const carriedResults = cur.content.filter((b) => b.type === "tool_result")
        if (carriedResults.length > 0) {
          prev.content = [...carriedResults, { type: "text", text: prev.content }]
        }
      }
      continue
    }
    collapsed.push(cur)
  }
  collapsed.reverse()
  return collapsed
}

/** The sideband kind of the compact checkpoint tag. */
const COMPACTION_KIND = "compaction"

/**
 * True when a user message is a durable/local compact checkpoint marker: a
 * text block with the `compaction` block mark, or a text with a
 * `compaction` node (the codec reads each form). With `NO_SIDEBAND` only
 * the block mark counts.
 */
function isCompactionCheckpointMessage(msg: Message, sb: SidebandReader): boolean {
  if (msg.role !== "user") return false
  const q = { kinds: [COMPACTION_KIND] }
  if (typeof msg.content === "string") return sb.has(msg.content, q)
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(
    (b) =>
      b.type === "text" &&
      (b.sideband?.kind === COMPACTION_KIND || (typeof b.text === "string" && sb.has(b.text, q))),
  )
}

/**
 * Merge earlier user content into later user for consecutive-user collapse.
 * Always salvages tool_result blocks. When `keepText`, also keeps text
 * blocks from the earlier message (compact checkpoints).
 */
function mergeUserContentInto(later: Message, earlier: Message, opts: { keepText: boolean }): void {
  const earlierBlocks: ContentBlock[] =
    typeof earlier.content === "string"
      ? earlier.content.length > 0
        ? [{ type: "text", text: earlier.content }]
        : []
      : Array.isArray(earlier.content)
        ? earlier.content
        : []
  const toolResults = earlierBlocks.filter((b) => b.type === "tool_result")
  const textBlocks = opts.keepText ? earlierBlocks.filter((b) => b.type === "text") : []
  if (toolResults.length === 0 && textBlocks.length === 0) return

  if (typeof later.content === "string") {
    later.content = [
      ...toolResults,
      ...textBlocks,
      ...(later.content.length > 0 ? [{ type: "text" as const, text: later.content }] : []),
    ]
    return
  }
  if (Array.isArray(later.content)) {
    // tool_results first, then checkpoint text, then later content.
    later.content = [...toolResults, ...textBlocks, ...later.content]
  }
}

/** Back-compat alias for `repairMessages`. */
export const repairTrailingTurn = repairMessages

// ---------------------------------------------------------------------------
// loadSession — top-level convenience: path → { meta, messages, dropped }
// ---------------------------------------------------------------------------

export interface LoadedSession {
  meta: MetaRecord | null
  records: SessionRecord[]
  /**
   * Model-facing history (honors durable compact checkpoints by default).
   * This is what the agent should load into `messages[]` for the next send.
   */
  messages: Message[]
  /**
   * Full display history for UI / `--resume` scrollback replay. Never
   * applies compact checkpoints so the user still sees the full log.
   * Not API-repaired (replay is presentation-only).
   */
  displayMessages: Message[]
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
 * mode-change chip, memory save-echo, emergency markers) rather
 * than human-typed prose. These are regenerated on the next submit, so they
 * must never leak into the prefilled editor draft. A block with a
 * `sideband` mark is plumbing. Else the codec reads the tag name at the
 * start of the text ({@link isRuntimeAttachmentText}).
 */
function isAttachmentBlock(b: TextBlock, sb: SidebandReader): boolean {
  return b.sideband !== undefined || isRuntimeAttachmentText(b.text, sb)
}

/**
 * Add the block mark to old history (design step 12c). A session log from
 * before step 12c has no `sideband` mark on the harness text blocks (session
 * context, turn attachments). A user text block with no mark gets the mark
 * `sideband: { kind }` only when the codec reads the block as whole tags of
 * one known kind: `leadingKind` gives a registered kind that is not
 * from-model (`kindInfo`), and the text has nothing out of the nodes of that
 * kind (`strip`). A block of several `policy` lines is one kind. A marker
 * with prose after its tag, or a block with typed text, gets no mark. With
 * `NO_SIDEBAND` (no codec) no block gets a mark. A marked block keeps its
 * mark. The bytes do not change: the mark is metadata only.
 *
 * Accepted risk: a user-typed block that holds only harness tags of one
 * known kind gets the mark too (the same match as the session context
 * dedupe, `historyHasSessionBlock`).
 *
 * @returns The number of blocks that got a mark.
 */
export function markRestoredSidebandBlocks(messages: Message[], sb: SidebandReader): number {
  let count = 0
  for (const m of messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    // A new array and new blocks: the model fold can share its block objects
    // with the display fold and the records, which keep no mark.
    let out: ContentBlock[] | undefined
    m.content.forEach((b, i) => {
      if (b.type !== "text" || b.sideband !== undefined) return
      const kind = wholeTagKind(b.text, sb)
      if (kind === undefined) return
      out ??= [...(m.content as ContentBlock[])]
      out[i] = Object.assign({}, b, { sideband: { kind } })
      count++
    })
    if (out) m.content = out
  }
  return count
}

/** The kind of `text` when it is only nodes of one known harness kind, else undefined. */
function wholeTagKind(text: string, sb: SidebandReader): string | undefined {
  const kind = sb.leadingKind(text)
  if (kind === undefined) return undefined
  const info = sb.kindInfo(kind)
  if (info === undefined || info.direction === "from-model") return undefined
  return sb.strip(text, { kinds: [kind] }).trim() === "" ? kind : undefined
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
export function extractPendingDraft(
  messages: Message[],
  sb: SidebandReader = NO_SIDEBAND,
): string | null {
  const last = messages[messages.length - 1]
  if (!last || last.role !== "user") return null
  if (!Array.isArray(last.content)) return null
  const humanTexts = last.content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .filter((b) => !isAttachmentBlock(b, sb))
    .map((b) => b.text)
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
 * warn the user. Fold warnings go to `opts.diagnostics` (S20).
 */
export function loadSessionFromText(
  text: string,
  opts?: { modelPolicy?: CompactSendPolicy; diagnostics?: Diagnostics; sideband?: SidebandReader },
): LoadedSession {
  const sb = opts?.sideband ?? NO_SIDEBAND
  const { records, dropped } = parseLines(text)
  const meta = (records.find((r) => r.kind === "meta") as MetaRecord | undefined) ?? null
  // Model-facing history honors durable compact checkpoints by default so
  // resume does not full-resend pre-compact turns. Display/replay uses the
  // full fold so UI still shows everything.
  const diagnostics = opts?.diagnostics
  const displayMessages = foldRecordsForDisplay(records, diagnostics)
  const folded = foldRecordsForModel(
    records,
    opts?.modelPolicy ?? { mode: "since-last-compact" },
    diagnostics,
  )
  // Decision 31: a turn with a mid-turn round checkpoint resumes. Keep the
  // tool calls a kill cut off, so resume can close them with a note.
  const messages = repairMessages(folded, {
    keepCutOffToolCalls: lastTurnRoundCheckpoint(records) !== null,
    sideband: sb,
  })
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
  const pendingDraft = extractPendingDraft(messages, sb)
  // Old history has no block marks: mark the whole harness tag blocks of the
  // model history (design step 12c). Display messages stay as stored.
  markRestoredSidebandBlocks(messages, sb)
  return { meta, records, messages, displayMessages, dropped, repaired, pendingDraft }
}

/**
 * Reads a session transcript from disk by id and runs it through
 * {@link loadSessionFromText}. Throws (ENOENT) when no transcript exists for
 * the id. Fold warnings go to `opts.diagnostics` (S20).
 */
export function loadSession(
  sid: string,
  dir?: string,
  opts?: { diagnostics?: Diagnostics; sideband?: SidebandReader },
): LoadedSession {
  const path = sessionFilePath(sid, dir)
  const text = readFileSync(path, "utf-8")
  return loadSessionFromText(text, {
    ...(opts?.diagnostics ? { diagnostics: opts.diagnostics } : {}),
    ...(opts?.sideband ? { sideband: opts.sideband } : {}),
  })
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

// ---------------------------------------------------------------------------
// Round checkpoint resume (S50)
// ---------------------------------------------------------------------------

/**
 * The latest round checkpoint of the session's last turn (the records after
 * its last `user` record), or `null` when that turn wrote none, or wrote
 * only its terminal reset.
 *
 * A turn that settles (any outcome but `waiting`) writes a final `round: 0`
 * checkpoint once it is done, even if it ran several rounds and checkpointed
 * mid-turn (`AgentCore`'s round-checkpoint reset, S50 resume safety) — there
 * is nothing left to resume. So a non-null result here means that turn's
 * LATEST checkpoint is still mid-turn: the turn was cut short by a crash, a
 * restart, or a permanent error that paused it. Pass the result as
 * `AgentCoreConfig.initialCheckpoint`. A host must not continue it by
 * itself: it waits for the user. On the user's request (`/continue`), call
 * `AgentCore.run(input, {resume: true})`, or `noteSessionResumed()` then
 * `run("")`, to continue it at the next round. A new message instead starts
 * a new turn, and that turn clears the checkpoint when it settles.
 */
export function lastTurnRoundCheckpoint(
  records: SessionRecord[],
): { round: number; streaks: { maxTokens: number; interrupted: number } } | null {
  let lastUserAt = -1
  for (let i = 0; i < records.length; i++) {
    if (records[i].kind === "user") lastUserAt = i
  }
  if (lastUserAt < 0) return null
  let latest: Extract<SessionRecord, { kind: "round_checkpoint" }> | null = null
  for (let i = lastUserAt + 1; i < records.length; i++) {
    const r = records[i]
    if (r.kind === "round_checkpoint") latest = r
  }
  if (!latest || latest.round <= 0) return null
  return {
    round: latest.round,
    streaks: { maxTokens: latest.maxTokensStreak, interrupted: latest.interruptedStreak },
  }
}

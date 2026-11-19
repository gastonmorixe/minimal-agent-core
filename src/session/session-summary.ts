/**
 * Per-session summary for the session catalog: the title (first real user
 * text), the token usage, the turn count, the end time, and the status.
 *
 * The summary goes into the sidecar `index-meta.jsonl` as a summary line
 * (`kind: "summary"`) with the same `sid` as the session line in
 * `index.jsonl` (see `IndexSummaryRecord`). A listing then reads only the
 * index, not the session files. The store writes one line
 * when a session closes (`SessionStore.appendDetach`). The catalog writes one
 * line, lazily, for an older session that has none (`session-catalog.ts`).
 *
 * Every function here is pure except {@link appendIndexSummary}, which only
 * appends one line to `index-meta.jsonl`.
 *
 * @module session-summary
 */

import { appendFileSync } from "node:fs"

import { hasBilledTokens, usageRecordToCanonical } from "../llm/codec/usage-record.ts"
import type { ContentBlock } from "../llm/messages.ts"
import { findModel, findModelForProvider } from "../llm/model-registry.ts"
import { calculateUsageCost } from "../llm/pricing.ts"

import {
  type AssistantRecord,
  type DetachRecord,
  INDEX_SUMMARY_VERSION,
  type IndexSummaryRecord,
  type MetaRecord,
  type SessionRecord,
} from "./session-store.ts"
import { computeSessionUsage } from "./session-usage.ts"

/** The summary fields of an index summary line, without `kind`, `sid` and `v`. */
export type SessionSummary = Omit<IndexSummaryRecord, "kind" | "sid" | "v">

/** Default maximum length of a title, in characters. */
export const DEFAULT_TITLE_MAX_LEN = 200

/**
 * A block `<ma::x::y ...>...</ma::x::y>`. The name must match. The open tag
 * must not end with `/>` (a self-closing tag is not an open tag), and the
 * body has no open tag of the same name, so the innermost block of a nested
 * pair goes first (see the loop in {@link stripInjectedContext}).
 */
const MA_BLOCK_RE = /<(ma::[\w:.-]+)(?:\s[^>]*[^/>])?\s*>((?:(?!<\1[\s/>])[\s\S])*?)<\/\1\s*>/g
/** A self-closing tag `<ma::x::y ... />`. */
const MA_SELF_CLOSING_RE = /<ma::[\w:.-]+(?:\s[^>]*?)?\/>/g
/**
 * An open tag with no close tag, and the rest of its line (for example an
 * unclosed `<ma::agent::policy>Current local time: …` line before the
 * prompt). With no newline after the tag, only the tag goes (lone tag).
 */
const MA_UNCLOSED_LINE_RE = /<ma::[\w:.-]+(?:\s[^>]*[^/>])?\s*>[^\n]*\n/g
/** A lone open or close tag that the patterns above did not remove. */
const MA_LONE_TAG_RE = /<\/?ma::[\w:.-]+(?:\s[^>]*)?>/g
/** Most nested block levels that {@link stripInjectedContext} removes. */
const MAX_BLOCK_PASSES = 8
/** Other injected host context blocks. */
const SYSTEM_BLOCK_RE = /<(system-reminder|system|context)>[\s\S]*?<\/\1>/g
/**
 * The marker between a sub-agent role preamble and its task (sub-agents
 * plugin `composePrompt`): `<preamble>\n\n---\n\nYour task:\n\n<task>`.
 */
const TASK_MARKER_RE = /\n-{3,}\s*\n+\s*Your task:\s*\n/
/** A `---` rule line (the sub-agent prompt puts one before the result protocol). */
const SECTION_RULE_RE = /\n-{3,}[ \t]*\n/

/** Remove injected `<ma::…>` tags and blocks, and other injected context, from a text. */
export function stripInjectedContext(text: string): string {
  // Self-closing tags first: else the block pattern could take one as an open tag.
  let out = text.replace(MA_SELF_CLOSING_RE, " ")
  // Nested blocks: remove the innermost level, then the next, until stable.
  for (let i = 0; i < MAX_BLOCK_PASSES; i++) {
    const next = out.replace(MA_BLOCK_RE, " ")
    if (next === out) break
    out = next
  }
  return out
    .replace(MA_UNCLOSED_LINE_RE, "\n")
    .replace(MA_LONE_TAG_RE, " ")
    .replace(SYSTEM_BLOCK_RE, " ")
}

/** Collapse whitespace to one line and cut to `maxLen` characters with `…`. */
function oneLine(text: string, maxLen: number): string {
  const line = text.replace(/\s+/g, " ").trim()
  if (maxLen <= 0) return ""
  return line.length > maxLen ? `${line.slice(0, Math.max(0, maxLen - 1))}…` : line
}

/** The text of a user record, block by block (text blocks only). */
function userTexts(content: string | ContentBlock[]): string[] {
  if (typeof content === "string") return [content]
  const out: string[] = []
  for (const b of content) if (b.type === "text") out.push(b.text)
  return out
}

/**
 * The first real user text of a session, on one line.
 *
 * It skips injected `<ma::…>` blocks and tags (policy, mode change, …),
 * injected system context blocks, and a sub-agent role preamble (the part
 * before `Your task:`). A user record with only injected text is skipped,
 * and the next user record is used. Returns `""` when no user record has
 * real text. Pure.
 *
 * @param records - The parsed records of one session.
 * @param maxLen - The maximum length in characters. Default {@link DEFAULT_TITLE_MAX_LEN}.
 * @returns The title, whitespace collapsed, cut with `…`.
 */
export function firstRealUserText(
  records: readonly SessionRecord[],
  maxLen: number = DEFAULT_TITLE_MAX_LEN,
): string {
  for (const r of records) {
    if (r.kind !== "user") continue
    let text = userTexts(r.content)
      .map(stripInjectedContext)
      .filter((t) => t.trim().length > 0)
      // "\n", not " ": the task marker can start at a block boundary.
      .join("\n")
    // A leading "\n" lets a task that starts with `---` match the marker.
    const marker = TASK_MARKER_RE.exec(`\n${text}`)
    if (marker) {
      // Keep the task only: drop the preamble and the protocol after it.
      text = text.slice(Math.max(0, marker.index + marker[0].length - 1))
      const end = SECTION_RULE_RE.exec(text)
      if (end) text = text.slice(0, end.index)
    }
    const line = oneLine(text, maxLen)
    if (line.length > 0) return line
  }
  return ""
}

/** The ISO time of the last record that has a time. `""` when none has one. */
export function lastRecordTime(records: readonly SessionRecord[]): string {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if ("ts" in r && typeof r.ts === "string" && r.ts.length > 0) return r.ts
    if (r.kind === "meta" && r.createdAt) return r.createdAt
  }
  return ""
}

/**
 * The billed cost in USD of all assistant turns with saved usage. The model
 * of a turn is the meta model, or the model of the last `target_switch`
 * before it. `undefined` when no turn has a known price.
 */
export function sessionCostUsd(records: readonly SessionRecord[]): number | undefined {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta")
  let modelId = meta?.model
  let provider = meta?.provider
  let total = 0
  let priced = false
  for (const r of records) {
    if (r.kind === "target_switch") {
      modelId = r.model
      provider = r.providerId ?? provider
      continue
    }
    if (r.kind !== "assistant") continue
    const turn = r as AssistantRecord
    if (!hasBilledTokens(turn.usage)) continue
    if (!modelId) continue
    const entry = provider
      ? (findModelForProvider(modelId, provider) ?? findModel(modelId))
      : findModel(modelId)
    if (!entry?.pricing) continue
    total += calculateUsageCost(usageRecordToCanonical(turn.usage), entry.pricing).totalUSD
    priced = true
  }
  return priced ? total : undefined
}

/**
 * True when the latest `attach` has no `detach` after it with the same pid:
 * a process can still write to the session. A summary of such a session is
 * not final.
 */
export function hasOpenAttach(records: readonly SessionRecord[]): boolean {
  let openPid: number | null = null
  for (const r of records) {
    if (r.kind === "attach") openPid = r.pid
    else if (r.kind === "detach" && openPid !== null && r.pid === openPid) openPid = null
  }
  return openPid !== null
}

/**
 * Exit codes of a stop by a user or a supervisor: 128 + the signal number
 * (https://www.gnu.org/software/bash/manual/html_node/Exit-Status.html) of
 * SIGHUP (1, a closed terminal), SIGINT (2, Ctrl-C) and SIGTERM (15). The
 * CLI exits with these codes from its signal handlers
 * (`process.exit(128 + n)`), so the detach record has `reason: "exit"`.
 */
export const STOP_SIGNAL_EXIT_CODES: ReadonlySet<number> = new Set([129, 130, 143])

/**
 * The status from the last `detach` record. `done` for no detach, a clean
 * exit (code 0), and a stop by SIGHUP, SIGINT or SIGTERM (exit code in
 * {@link STOP_SIGNAL_EXIT_CODES}, or a `signal` detach with no other code):
 * closing a terminal or stopping a worker is not a failure (P1 review N1).
 * `failed` for an `error` detach and for any other non-zero exit code.
 */
export function detachStatus(
  reason: DetachRecord["reason"] | undefined,
  exitCode?: number,
): "done" | "failed" {
  if (reason === undefined) return "done"
  if (reason === "error") return "failed"
  if (exitCode === undefined) return reason === "exit" || reason === "signal" ? "done" : "failed"
  return exitCode === 0 || STOP_SIGNAL_EXIT_CODES.has(exitCode) ? "done" : "failed"
}

/** Options of {@link computeSessionSummary}. */
export interface SessionSummaryOptions {
  /** The model for the usage estimate. Default: the meta model. */
  modelId?: string
  /** The maximum title length. Default {@link DEFAULT_TITLE_MAX_LEN}. */
  titleMaxLen?: number
}

/**
 * Compute the summary of one session from its parsed records. Pure, except
 * that the cost reads the model registry. The status comes from the last
 * `detach` record (no detach: `done`, because a missing detach record, for
 * example after a SIGKILL, is not proof of a failure).
 *
 * @param records - The parsed records of one session.
 * @param opts - See {@link SessionSummaryOptions}.
 */
export function computeSessionSummary(
  records: readonly SessionRecord[],
  opts: SessionSummaryOptions = {},
): SessionSummary {
  const list = records as SessionRecord[]
  const usage = computeSessionUsage(list, opts.modelId ? { modelId: opts.modelId } : {})
  let turns = 0
  let lastDetach: DetachRecord | undefined
  for (const r of records) {
    if (r.kind === "user") turns += 1
    else if (r.kind === "detach") lastDetach = r
  }
  const costUsd = sessionCostUsd(records)
  return {
    title: firstRealUserText(records, opts.titleMaxLen ?? DEFAULT_TITLE_MAX_LEN),
    tokens: usage.tokens,
    estimated: usage.estimated,
    ...(costUsd !== undefined ? { costUsd } : {}),
    turns,
    endedAt: lastRecordTime(records),
    status: detachStatus(lastDetach?.reason, lastDetach?.exitCode),
  }
}

/** Build an index summary line from a summary, with the current version `v`. */
export function toIndexSummaryRecord(sid: string, summary: SessionSummary): IndexSummaryRecord {
  return { kind: "summary", sid, v: INDEX_SUMMARY_VERSION, ...summary }
}

/**
 * Append one summary line to the sidecar `index-meta.jsonl` (see
 * `indexMetaFilePath`). One `appendFileSync` call with one line: the file
 * is opened with `O_APPEND`, so the line goes to the end as one write.
 * Best-effort: returns `false` on an error, never throws.
 *
 * @param indexPath - The full path of `index-meta.jsonl`. (Name kept for
 *   the API: an older build passed `index.jsonl`.)
 * @param line - The summary line.
 */
export function appendIndexSummary(indexPath: string, line: IndexSummaryRecord): boolean {
  try {
    appendFileSync(indexPath, `${JSON.stringify(line)}\n`)
    return true
  } catch {
    return false
  }
}

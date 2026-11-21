// FORMAT v1
//
// Append-only JSONL session log. One file per session at
// `~/.minimal-agent/sessions/<sid>.jsonl`. The first record is always a
// `meta` record. Every subsequent record represents one observable event
// at a turn boundary (user message submitted, assistant turn completed,
// tool result produced, free-form note). Mid-stream tokens NEVER touch
// disk — we commit at boundaries only, so a `kill -9` mid-turn loses the
// in-flight turn but never corrupts prior history.
//
// Each line is a single `JSON.stringify(record)` followed by `\n`. A torn
// last line (write interrupted before `\n`) is detected and dropped on
// load by `parseLines` below; earlier lines are never silently dropped.
//
// The sid is the same UUID returned by `getSessionId()` from
// `src/metadata.ts` — i.e. the value also sent in the
// `x-claude-code-session-id` HTTP header. This keeps file id, API id, and
// `.net-dbg/` capture id aligned.
//
// FORMAT-CHANGE POLICY: bump the `// FORMAT vN` marker in this file AND
// add a `formatVersion` field to the `meta` record. Old sessions remain
// readable forever — `foldRecords` is responsible for understanding the
// version mix.

import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname as osHostname } from "node:os"
import { join } from "node:path"

import type { CompactMeta } from "../../plugin-api/src/types/compaction.ts"
import type { PersistedToolOutcome } from "../../plugin-api/src/types/tool-outcome-record.ts"
import { resolveSessionsDir } from "../agent/agent-paths.ts"
import type { UsageRecord } from "../llm/codec/usage-record.ts"
import type { ContentBlock, ToolResultBlock } from "../llm/messages.ts"
import { subagentIdentity } from "../runtime/host-session-facts.ts"

import { assertSafeSessionId } from "./session-id-safety.ts"
import {
  appendIndexSummary as appendIndexSummaryLine,
  computeSessionSummary,
  toIndexSummaryRecord,
} from "./session-summary.ts"

/**
 * The largest session file that `appendDetach` reads to write its index
 * summary line. A larger file gets its summary later, from the catalog,
 * so the exit path stays fast.
 */
export const SUMMARY_ON_CLOSE_MAX_BYTES = 8 * 1024 * 1024

// ---------------------------------------------------------------------------
// Record types
// ---------------------------------------------------------------------------

export interface MetaRecord {
  kind: "meta"
  formatVersion: 1
  sid: string
  createdAt: string
  model: string
  cwd: string
  /** Hash of the active system prompt at session start. Resume warns on mismatch. */
  systemHash: string
  /** Hash of the tool list (names + descriptions + schemas) at session start. */
  toolsHash: string
  agentVersion: string
  /**
   * Fork ancestry — present when this session was created by `--resume <sid>`.
   * Both fields are written together by {@link SessionStore.fork}; old sessions
   * (and brand-new ones from {@link SessionStore.open}) have neither.
   *
   * `parentSid` is the immediate parent only — multi-step fork chains
   * (A → B → C) require walking the chain via `loadSession` if you need
   * full ancestry. Kept intentionally simple: one parent pointer is enough
   * for audit + provenance, full chain reconstruction is a downstream
   * concern.
   */
  parentSid?: string
  /** ISO 8601 timestamp the fork was created. Pairs with {@link parentSid}. */
  forkedAt?: string
  /**
   * Provider id that ran this session (e.g. `"anthropic"`, `"opencode"`,
   * `"wafer"`). Written at session open/fork time so usage-stats can
   * disambiguate models registered by multiple providers. Absent on old
   * sessions written before this field existed.
   */
  provider?: string
  /**
   * Named credential pin (`--credential-name`) used for this session.
   * Written at open/fork so `--resume` can re-select the same stored
   * account when CLI/config omit the pin. Absent on old sessions.
   */
  credentialName?: string
  /** True when this session is an archived original branch created by history editing. */
  backup?: boolean
  /** Active session whose pre-edit timeline this archival session preserves. */
  backupOfSid?: string
}

export interface UserRecord {
  kind: "user"
  ts: string
  /** Same shape we push onto `Agent.messages` — string OR content blocks. */
  content: string | ContentBlock[]
  /**
   * Stable unique id for this user prompt. Generated at write time. Used as
   * the target by `RewindRecord.to`. Optional for backward compat with
   * sessions written before this field existed.
   */
  id?: string
}

export interface AssistantRecord {
  kind: "assistant"
  ts: string
  /**
   * The full block array from the assistant turn, persisted verbatim.
   * Includes every `ContentBlock` variant the model emitted:
   * `text`, `tool_use`, AND `thinking` (`ThinkingBlock` in `client.ts`).
   *
   * Thinking blocks are persisted with their cryptographic `signature`
   * intact. The signature is what the `redact-thinking-2026-02-12` beta
   * needs to verify on the next request, so a resumed session can re-send
   * its full prior turn (including thinking) and the API will accept it
   * as a continuation rather than rejecting the message. Restore is
   * lossless: `session-restore.ts` pushes `content` back onto
   * `messages[]` as-is, no filtering on block type.
   *
   * When `thinking.display === "omitted"` the model still emits a
   * thinking block with an empty `thinking` field and a populated
   * `signature` — both fields survive the round trip.
   */
  content: ContentBlock[]
  stopReason: string | null
  /** Billed usage of this response. Thinking and the cache TTL split included. */
  usage?: UsageRecord
  /**
   * Provider-assigned response id (e.g. Anthropic `msg_…`), restored onto
   * `Message.providerMessageId` on resume. Absent on older sessions, on
   * providers without an id, and on turns that did not reach `message_stop`.
   */
  providerMessageId?: string
}

export interface ToolResultRecord {
  kind: "tool_result"
  ts: string
  tool_use_id: string
  content: string | ContentBlock[]
  isError: boolean
  /**
   * Absolute path to the raw, pre-clamp body of this tool call, when the
   * agent's per-session blob store decided to persist it. Present only
   * when the body exceeded `plugins.blob-store.minBytesToPersist` OR was
   * clamped by the universal truncation guardrail (`src/tools/truncation.ts`).
   * Absent when `content` IS the full output, when the store is
   * disabled, or when the write failed (best-effort).
   *
   * The path stays valid for the lifetime of the session blobs
   * directory (`<sid>.blobs/`). LRU eviction may delete it: callers
   * MUST handle ENOENT as a normal stale-pointer case. See
   * `src/blob-store.ts`.
   *
   * Additive field: missing from records written before the blob store
   * landed; `parseLines` reads them unchanged.
   */
  rawPath?: string
  /** Size in bytes of the persisted blob. Paired with `rawPath`. */
  rawBytes?: number
  /**
   * sha256 hex digest of the persisted blob, truncated to 16 chars.
   * Used during session resume to detect "this blob on disk no longer
   * matches what we recorded" drift. NOT a cryptographic guarantee.
   */
  rawSha256?: string
  /** Metadata only: marks rendered sideband text. Written only when present. */
  sideband?: { kind: string }
  /**
   * Structure of the final text (SPEC v6.1 D8): body end, annotation spans,
   * data. Holds no text and no presentation field (S29). Written only when
   * the caller gives it (4th argument of `appendToolResult`). Absent on
   * records before M2 and on the skip path. Restore checks it against
   * `content` (`validatePersistedToolOutcome`) and drops a bad value.
   */
  outcome?: PersistedToolOutcome
  // Spec S29: a tool_result record carries no presentation fields. Records
  // written before S29 can also hold pre-rendered `display`,
  // `displayHeader`, and `displayFooter` strings. `parseLines` keeps them
  // on the object unchanged, and core ignores them. A host replay may read
  // them from an old record. New writes never add them.
}

export interface NoteRecord {
  kind: "note"
  ts: string
  text: string
}

/**
 * Durable context-compaction checkpoint.
 *
 * Append-only. Prior user/assistant/tool_result records stay on disk forever
 * so UI / `--resume` can still render the full transcript. Model-facing
 * send paths fold from this checkpoint via
 * {@link foldRecordsForModel} (default: since last compact).
 *
 * `replacementMessages` is the portable post-compact history the model
 * should see as of this checkpoint (typically a checkpoint user message
 * plus optional retained tail). Later conversation records after this
 * line continue the model history.
 */
export interface CompactRecord {
  kind: "compact"
  ts: string
  /** Stable id for this checkpoint (optional, for diagnostics). */
  id?: string
  reason: "manual" | "auto" | "exceeded"
  /** Remote provider compact vs local prune/checkpoint. */
  compactKind: "remote" | "local"
  messagesBefore: number
  messagesAfter: number
  /**
   * Model-facing replacement history at the compact boundary.
   * `content` is a string on older records and ContentBlock[] on current
   * writes (tool_use / tool_result / media stay intact). Restore accepts both.
   */
  replacementMessages: Array<{
    role: "user" | "assistant" | "system"
    content: string | ContentBlock[]
  }>
  /** Optional encrypted remote compaction payload (OpenAI/Codex). */
  encryptedContent?: string
  /**
   * Structured record of a tail or local compaction. Absent on remote rows
   * and on rows written before it existed. Written last.
   */
  meta?: CompactMeta
}

/**
 * Rewind marker. When folding records into the live `messages[]`, encountering
 * a rewind drops every message after the target user prompt (the prompt with
 * `id === to` is KEPT). Multiple rewinds compose: each operates on the
 * already-folded message list at that point in the log.
 *
 * The rewind itself is metadata — it is NOT a message. `droppedCount` is
 * informational (used by the replay renderer to show "M messages discarded").
 */
export interface RewindRecord {
  kind: "rewind"
  ts: string
  /** `UserRecord.id` of the prompt to rewind to. That prompt is kept. */
  to: string
  /** Number of dropped records, for replay/UX. Not load-bearing. */
  droppedCount: number
}

/**
 * Durable audit marker emitted immediately before a replacement prompt follows
 * a history edit. The selected original prompt is excluded from the active
 * JSONL, so this record links the edited timeline to its full backup.
 */
export interface HistoryEditRecord {
  kind: "history_edit"
  ts: string
  targetUserId: string
  backupSid: string
  droppedRecordCount: number
}

/**
 * Round checkpoint (S50). Written after each completed round of the
 * in-flight turn (one model send + its tool calls, when the loop is about
 * to send another round) so a crash or a restart can resume the turn
 * instead of replaying it.
 *
 * Pure metadata: never folded into model or display history
 * ({@link foldRecordsForModel} / {@link foldRecordsForDisplay} skip it), and
 * never counted as conversation content. The round that completes the turn
 * (no further round follows) writes none — nothing is left to resume.
 *
 * `round` and the two streak counters mirror `AgentCore`'s in-memory
 * `Streaks` state (`src/sdk/stop-policy.ts`) at the checkpoint.
 */
export interface RoundCheckpointRecord {
  kind: "round_checkpoint"
  ts: string
  round: number
  maxTokensStreak: number
  interruptedStreak: number
}

/**
 * The live target after a change (`AgentCore.switchTarget`, `setModel`,
 * `setEffort`, or an automatic model adoption): the
 * credential/provider/model/effort the session sends to from here on.
 *
 * Metadata, never folded into the model history as a message. With
 * `discardedThinking`, {@link foldRecordsForModel} drops the `thinking` and
 * `redacted_thinking` blocks of each earlier assistant record: a thinking
 * block belongs to the target that made it. The display fold keeps them.
 * The newest record is the target of a resume.
 */
export interface TargetSwitchRecord {
  kind: "target_switch"
  ts: string
  providerId?: string
  credentialName?: string
  model: string
  effort?: string
  discardedThinking: boolean
}

/**
 * Process-attach marker. Written once on session open (new OR resume) so any
 * other process can answer "is an agent currently attached to this session?"
 *
 * Liveness is determined by probing the live OS (kill(pid,0) + start-time
 * match), NOT by trusting this record alone. PIDs get reused; `startTime`
 * pins identity beyond the pid. `hostname` guards against home dirs on
 * network shares / sync'd folders where the pid is meaningless to us.
 *
 * See `src/session-liveness.ts` for the query side.
 */
export interface AttachRecord {
  kind: "attach"
  ts: string
  pid: number
  ppid: number
  /** ISO 8601, our own pid's start time at startup (`/proc` on Linux, else `ps -o lstart=`). */
  startTime: string
  hostname: string
  agentVersion: string
}

/**
 * Best-effort clean-shutdown marker. Pairs with the latest AttachRecord by
 * pid. MAY be missing (SIGKILL, crash, power loss) — readers MUST NOT treat
 * its absence as "still alive". It is purely an optimization that lets the
 * reader skip the OS probe.
 */
export interface DetachRecord {
  kind: "detach"
  ts: string
  pid: number
  reason: "exit" | "signal" | "error"
  exitCode?: number
}

export type SessionRecord =
  | MetaRecord
  | UserRecord
  | AssistantRecord
  | ToolResultRecord
  | NoteRecord
  | CompactRecord
  | RewindRecord
  | HistoryEditRecord
  | RoundCheckpointRecord
  | TargetSwitchRecord
  | AttachRecord
  | DetachRecord

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Root directory: `<agent-home>/sessions/`, honoring `MINIMAL_AGENT_HOME`.
 *
 * Routed through the single resolver in `src/agent-paths.ts` so the host's own
 * session store agrees with the home that `publishAgentHomeEnv` advertises to
 * plugins. Hardcoding `~/.minimal-agent` here would split-brain a relocated
 * setup: plugins (which read the env var) would write under the new root while
 * the host read sessions from the old one.
 */
export function defaultSessionsDir(): string {
  return resolveSessionsDir()
}

/** Full path for a session's JSONL log. */
export function sessionFilePath(sid: string, dir: string = defaultSessionsDir()): string {
  assertSafeSessionId(sid, "session log")
  return join(dir, `${sid}.jsonl`)
}

/** Index file for fast listing without scanning every session file. */
export function indexFilePath(dir: string = defaultSessionsDir()): string {
  return join(dir, "index.jsonl")
}

/**
 * Sidecar of `index.jsonl` for the summary and tombstone lines (P1 review
 * N4). `index.jsonl` keeps only session lines, so older builds, which read
 * each line of `index.jsonl` as a session, never see a summary or
 * tombstone line. Readers merge the two files (`readParsedSessionIndex`).
 */
export function indexMetaFilePath(dir: string = defaultSessionsDir()): string {
  return join(dir, "index-meta.jsonl")
}

// ---------------------------------------------------------------------------
// Index records (one line per session, written at session open)
// ---------------------------------------------------------------------------

export interface IndexRecord {
  sid: string
  createdAt: string
  cwd: string
  model: string
  argv?: string[]
  /** Archived original timeline created by a history edit. */
  backup?: boolean
  /** Active session whose original timeline this backup preserves. */
  backupOfSid?: string
  /** Lead session id when this session is a sub-agent worker (`MINIMAL_AGENT_SUBAGENT_LEAD`). */
  leadSid?: string
  /** Sub-agent id given by the lead, for example `A2` (`MINIMAL_AGENT_SUBAGENT_ID`). */
  agentId?: string
  /** Sub-agent role (agent type), for example `worker` or `explorer` (`MINIMAL_AGENT_SUBAGENT_ROLE`). */
  role?: string
  /**
   * Set by the reader only (never written to `index.jsonl`): the lineage
   * fields come from a sidecar `kind: "lineage"` line (see
   * {@link IndexLineageRecord}), not from the session line.
   */
  lineageSource?: IndexLineageSource
}

/** How a backfilled lineage line was found. */
export type IndexLineageSource =
  /** The lead transcript has "running in background as session <sid>". */
  | "transcript"
  /** The child attach `ppid` is the pid of one live lead (same host, time). */
  | "ppid"

/**
 * A lineage line in the sidecar `index-meta.jsonl`: the inferred lead of an
 * old sub-agent session whose index line has no `leadSid` (written before
 * the lineage fields existed; see `backfillLineage`). The reader merges it
 * into the session row only when the session line has no `leadSid`: the
 * recorded lineage always wins. A tombstone of the sid removes the earlier
 * lineage lines. Readers that do not know this kind skip it.
 */
export interface IndexLineageRecord {
  kind: "lineage"
  /** Format version (1). */
  v: number
  sid: string
  leadSid: string
  agentId?: string
  role?: string
  source: IndexLineageSource
  /** ISO time of the backfill. */
  at: string
}

/** True when a parsed index line is a valid lineage line. */
export function isIndexLineageRecord(line: unknown): line is IndexLineageRecord {
  if (typeof line !== "object" || line === null) return false
  const r = line as Partial<Record<keyof IndexLineageRecord, unknown>>
  return (
    r.kind === "lineage" &&
    typeof r.sid === "string" &&
    typeof r.leadSid === "string" &&
    r.leadSid.length > 0 &&
    r.leadSid !== r.sid &&
    (r.source === "transcript" || r.source === "ppid")
  )
}

/**
 * A summary line. New lines go to the sidecar `index-meta.jsonl` (see
 * {@link indexMetaFilePath}); an older build of this version wrote them to
 * `index.jsonl`, and readers still accept them there. It has the same
 * `sid` as the session line, and `kind: "summary"`. A session can have
 * more than one summary line: the last one wins (a sidecar line wins over
 * an `index.jsonl` line). Readers that list sessions must skip these lines
 * (see {@link isIndexSummaryRecord}).
 */
export interface IndexSummaryRecord {
  kind: "summary"
  sid: string
  /**
   * Summary format version ({@link INDEX_SUMMARY_VERSION} for new lines).
   * The catalog trusts all fields of an older line except a `failed`
   * status: it computes such a line again from the session file. Version 1
   * gave `failed` to a kill with no detach record; version 2 gave `failed`
   * to an exit by SIGHUP, SIGINT or SIGTERM (exit code 129, 130, 143).
   */
  v?: number
  /** First real user text, one line (see `firstRealUserText`). */
  title: string
  /** Headline token count (`computeSessionUsage().tokens`). */
  tokens: number
  /** True when part of `tokens` is an estimate. */
  estimated: boolean
  /**
   * True when part of the token count is not known: a turn with no billed
   * usage and no estimator for its model (`computeSessionUsage().tokensUnknown`).
   * Then `tokens` holds only the known part. The catalog and the session
   * store do not write such a summary to the sidecar, so that a later
   * estimator (for example from a plugin) can compute it. Absent when the
   * count is known.
   */
  tokensUnknown?: boolean
  /** Billed cost in USD. Absent when no model price is known. */
  costUsd?: number
  /** Number of `user` records (prompts) in the session. */
  turns: number
  /** ISO time of the last record of the session file. */
  endedAt: string
  /**
   * `failed` only when the last run of the session wrote a `detach` record
   * with an error, or with a non-zero exit code that is not a stop by
   * SIGHUP, SIGINT or SIGTERM (129, 130, 143: `done`, see `detachStatus`).
   * A session with no detach record after its last `attach` (for example a
   * sub-agent worker that was SIGKILLed after it wrote its result) is
   * `done`: a missing detach is not proof of a failure.
   */
  status: "done" | "failed"
}

/**
 * The current {@link IndexSummaryRecord.v}. A `failed` line with a lower
 * version is computed again by the catalog; other old lines are used.
 */
export const INDEX_SUMMARY_VERSION = 3

/**
 * A tombstone line: `cleanupIfUnused` appends it to `index-meta.jsonl` (see
 * {@link indexMetaFilePath}), and does not rewrite the index. It removes the
 * earlier session and summary lines of `sid` (see `parseSessionIndexText`).
 * A session line of the same sid after the tombstone is a new session and
 * is kept. An older build wrote tombstones into `index.jsonl`; there, line
 * order gives "earlier".
 */
export interface IndexTombstoneRecord {
  kind: "tombstone"
  sid: string
  /** ISO time of the cleanup. */
  at: string
  /**
   * Size in bytes of `index.jsonl` at the cleanup. The tombstone removes the
   * session lines of `sid` that start before this offset. Absent: it removes
   * all session lines of `sid`.
   */
  indexBytes?: number
}

/** True when a parsed index line is a tombstone line. */
export function isIndexTombstoneRecord(line: unknown): line is IndexTombstoneRecord {
  return (
    typeof line === "object" &&
    line !== null &&
    (line as { kind?: unknown }).kind === "tombstone" &&
    typeof (line as { sid?: unknown }).sid === "string"
  )
}

/** One parsed line of `index.jsonl` or `index-meta.jsonl`. */
export type IndexLine = IndexRecord | IndexSummaryRecord | IndexTombstoneRecord | IndexLineageRecord

/** True when a parsed index line is a summary line, not a session line. */
export function isIndexSummaryRecord(line: unknown): line is IndexSummaryRecord {
  return (
    typeof line === "object" && line !== null && (line as { kind?: unknown }).kind === "summary"
  )
}

/** Sub-agent lineage stamped on a new index line. */
export interface IndexLineage {
  leadSid?: string
  agentId?: string
  role?: string
}

/**
 * True when `sid` is the session that this process was spawned to run as a
 * sub-agent: `MINIMAL_AGENT_SUBAGENT_SID` equals `sid` (when it is set), or
 * the process argv pins it with `--session-id <sid>` / `--session-id=<sid>`
 * (the sub-agents spawn plan does this). An inherited sub-agent env in
 * another process (a `ma` run from a worker shell) or another session of
 * the worker (a fork) does not match.
 */
export function isPinnedSubagentSid(
  sid: string,
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = process.argv,
): boolean {
  const envSid = env.MINIMAL_AGENT_SUBAGENT_SID?.trim()
  if (envSid) return envSid === sid
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session-id" && argv[i + 1] === sid) return true
    if (argv[i] === `--session-id=${sid}`) return true
  }
  return false
}

/**
 * The lineage fields that are set, ready to spread into an {@link IndexRecord}.
 * With no explicit `lineage`, the sub-agent env is used only for the pinned
 * sub-agent session `sid` (see {@link isPinnedSubagentSid}).
 */
function lineageFields(sid: string, lineage: IndexLineage | null | undefined): IndexLineage {
  const src =
    lineage === undefined ? (isPinnedSubagentSid(sid) ? subagentIdentity() : null) : lineage
  if (!src) return {}
  return {
    ...(src.leadSid ? { leadSid: src.leadSid } : {}),
    ...(src.agentId ? { agentId: src.agentId } : {}),
    ...(src.role ? { role: src.role } : {}),
  }
}

// ---------------------------------------------------------------------------
// Parse helpers (also used by session-restore)
// ---------------------------------------------------------------------------

/** Return whether a record counts as durable conversation content. */
function isConversationRecord(rec: SessionRecord): boolean {
  return (
    rec.kind === "user" ||
    rec.kind === "assistant" ||
    rec.kind === "tool_result" ||
    rec.kind === "note" ||
    rec.kind === "compact" ||
    rec.kind === "rewind" ||
    rec.kind === "history_edit"
  )
}

/**
 * Parse a JSONL blob into records. Lines that fail to parse are dropped
 * with a soft warning (returned in `dropped`); the *last* line is the
 * common case (torn write at crash time) and is always tolerated.
 */
export function parseLines(text: string): {
  records: SessionRecord[]
  dropped: { line: number; reason: string }[]
} {
  const records: SessionRecord[] = []
  const dropped: { line: number; reason: string }[] = []
  const lines = text.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.length === 0) continue
    try {
      const parsed = JSON.parse(line) as SessionRecord
      if (typeof parsed !== "object" || parsed === null || typeof parsed.kind !== "string") {
        dropped.push({ line: i + 1, reason: "not a record object" })
        continue
      }
      records.push(parsed)
    } catch (err) {
      dropped.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { records, dropped }
}

// ---------------------------------------------------------------------------
// Process identity helpers (used by AttachRecord + session-liveness)
// ---------------------------------------------------------------------------

/**
 * Userland clock-tick rate for `/proc/<pid>/stat` field 22. Linux fixes
 * `USER_HZ` at 100 for the userland ABI on every architecture Bun targets,
 * and Bun exposes no `sysconf(_SC_CLK_TCK)`.
 */
const LINUX_CLK_TCK = 100

/**
 * Read a process's start time from procfs, with no subprocess: field 22 of
 * `/proc/<pid>/stat` (`starttime`, clock ticks since boot) plus `btime` from
 * `/proc/stat` (boot time, epoch seconds). Floored to whole seconds, the
 * same value `ps -o lstart=` prints, so records written by either path
 * compare equal. Returns null when procfs is missing or unparsable.
 *
 * @param pid - Process to inspect.
 * @param readFile - Injected reader (tests). Default reads utf8 from disk.
 */
export function readLinuxProcStartTime(
  pid: number,
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): string | null {
  try {
    const stat = readFile(`/proc/${pid}/stat`)
    // `comm` (field 2) is parenthesized and may hold spaces or `)`, so split
    // after the LAST `)`. The remainder starts at field 3 (state).
    const close = stat.lastIndexOf(")")
    if (close < 0) return null
    const fields = stat.slice(close + 2).split(" ")
    const ticks = Number(fields[19]) // field 22, counted from field 3
    const btimeLine = readFile("/proc/stat")
      .split("\n")
      .find((l) => l.startsWith("btime "))
    const btime = Number(btimeLine?.slice(6).trim())
    if (!Number.isInteger(ticks) || ticks < 0 || !Number.isInteger(btime) || btime <= 0) {
      return null
    }
    const seconds = btime + Math.floor(ticks / LINUX_CLK_TCK)
    return new Date(seconds * 1000).toISOString()
  } catch {
    return null
  }
}

/**
 * Read a process's wall-clock start time. Returns null if the process does
 * not exist or no source works. The string is normalized to ISO 8601 (whole
 * seconds) so on-disk values compare with strict equality.
 *
 * Linux reads `/proc` first, so a slim image without procps still gets
 * PID-reuse detection. macOS, and Linux without procfs, fall back to
 * `ps -o lstart=`. The kernel records the start at process creation and
 * never updates it, so this is stable against later wall-clock skew.
 */
export function readProcessStartTime(pid: number): string | null {
  if (process.platform === "linux") {
    const fromProc = readLinuxProcStartTime(pid)
    if (fromProc != null) return fromProc
  }
  return readPsStartTime(pid)
}

/**
 * Start time from `ps -o lstart=` (macOS + fallback), ISO 8601, or null.
 * `ps` runs with `TZ=UTC LC_ALL=C` and the output is parsed as UTC, so the
 * result never depends on the host time zone, locale, or the JS runtime's
 * own zone (bun test forces UTC in-process while a child keeps local time).
 */
export function readPsStartTime(pid: number): string | null {
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    })
    if (r.status !== 0) return null
    const raw = (r.stdout ?? "").trim()
    if (!raw) return null
    const t = new Date(`${raw} UTC`).getTime()
    if (!Number.isFinite(t)) return null
    return new Date(t).toISOString()
  } catch {
    return null
  }
}

let _ownStartTime: string | null = null

/**
 * Capture our own process start time once and cache it. Falls back to
 * "now" if neither procfs nor `ps` works; in that case PID-reuse detection becomes
 * a no-op for this session, but `kill(0)` liveness still works.
 */
export function getOwnStartTime(): string {
  if (_ownStartTime != null) return _ownStartTime
  _ownStartTime = readProcessStartTime(process.pid) ?? new Date().toISOString()
  return _ownStartTime
}

/** Test-only: reset the cached start time. */
export function _resetOwnStartTimeForTest(): void {
  _ownStartTime = null
}

/**
 * Rewrite the leading `meta` line to add `credentialName` when missing.
 * Used by same-sid resume (`existsOk`) so an old session can gain the pin
 * without forking. Never overwrites an existing pin. Best-effort: no-op
 * when the first record is not meta or already has any credentialName.
 */
function backfillMetaCredentialName(
  path: string,
  text: string,
  records: SessionRecord[],
  credentialName: string,
): void {
  const meta = records[0]
  if (!meta || meta.kind !== "meta") return
  if (meta.credentialName) return
  const updated: MetaRecord = { ...meta, credentialName }
  const nl = text.indexOf("\n")
  const rest = nl === -1 ? "" : text.slice(nl + 1)
  writeFileSync(path, `${JSON.stringify(updated)}\n${rest}`)
}

// ---------------------------------------------------------------------------
// SessionStore — append-only writer
// ---------------------------------------------------------------------------

/**
 * Append-only writer for a single session file. Use `SessionStore.open(...)`
 * to create+initialize (writes `meta` + index entry). Use the static
 * `SessionStore.load(sid)` (in `session-restore.ts`) for read-only access.
 *
 * Every `append*` call writes one line synchronously and flushes. We
 * deliberately use `appendFileSync` rather than a buffered writer: each
 * record represents a turn-boundary event, of which there are O(turns)
 * per session, not O(tokens). Throughput is not the bottleneck;
 * correctness on `kill -9` is.
 */
export class SessionStore {
  readonly sid: string
  readonly path: string
  readonly agentVersion: string
  private readonly dir: string
  /**
   * Has this session ever carried real conversation content?
   *
   * Flipped to true by any `append{User,Assistant,ToolResult,Note,Rewind}`
   * call, and pre-seeded by `fork()` when the parent already had
   * conversation records (so a resume-and-immediately-quit does NOT count
   * as "unused"). `appendAttach`/`appendDetach` do NOT flip this — they're
   * process bookkeeping, not conversation.
   *
   * Read by {@link cleanupIfUnused} to decide whether the on-disk artifacts
   * for this session can be removed at shutdown.
   */
  private hasConversation = false

  private constructor(sid: string, dir: string, agentVersion: string) {
    this.sid = sid
    this.dir = dir
    this.agentVersion = agentVersion
    this.path = sessionFilePath(sid, dir)
  }

  /**
   * Open a brand-new session file, write the `meta` record, and append a
   * line to `index.jsonl`. If a file at this sid already exists,
   * `existsOk: false` (default) throws — this is almost certainly a bug
   * (sid collision or accidental reuse). Pass `existsOk: true` from a
   * resume path that wants to keep appending to an existing file.
   */
  static open(opts: {
    sid: string
    model: string
    cwd: string
    systemHash: string
    toolsHash: string
    agentVersion: string
    argv?: string[]
    dir?: string
    existsOk?: boolean
    provider?: string
    credentialName?: string
    /** Override the timestamp; tests use this for determinism. */
    now?: () => Date
    /**
     * Sub-agent lineage for the new index line. Default: read from the
     * process env (`subagentIdentity()`). `null` writes none.
     */
    lineage?: IndexLineage | null
  }): SessionStore {
    const dir = opts.dir ?? defaultSessionsDir()
    mkdirSync(dir, { recursive: true })
    const store = new SessionStore(opts.sid, dir, opts.agentVersion)
    const now = (opts.now ?? (() => new Date()))()
    const createdAt = now.toISOString()

    const fileExists = (() => {
      try {
        readFileSync(store.path, "utf-8")
        return true
      } catch {
        return false
      }
    })()

    if (fileExists && !opts.existsOk) {
      throw new Error(
        `SessionStore.open: file already exists at ${store.path} (pass existsOk:true to append)`,
      )
    }

    if (!fileExists) {
      const meta: MetaRecord = {
        kind: "meta",
        formatVersion: 1,
        sid: opts.sid,
        createdAt,
        model: opts.model,
        cwd: opts.cwd,
        systemHash: opts.systemHash,
        toolsHash: opts.toolsHash,
        agentVersion: opts.agentVersion,
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.credentialName ? { credentialName: opts.credentialName } : {}),
      }
      writeFileSync(store.path, `${JSON.stringify(meta)}\n`, { flag: "wx" })

      const indexRecord: IndexRecord = {
        sid: opts.sid,
        createdAt,
        cwd: opts.cwd,
        model: opts.model,
        argv: opts.argv,
        ...lineageFields(opts.sid, opts.lineage),
      }
      appendFileSync(indexFilePath(dir), `${JSON.stringify(indexRecord)}\n`)
    } else if (opts.existsOk) {
      const text = readFileSync(store.path, "utf-8")
      const { records } = parseLines(text)
      store.hasConversation = records.some(isConversationRecord)
      // Same-sid resume keeps creation meta (model/hashes) intact, but may
      // backfill a missing credentialName so later resumes can re-pin without
      // re-passing --credential-name. Never overwrite an existing pin.
      if (opts.credentialName) {
        backfillMetaCredentialName(store.path, text, records, opts.credentialName)
      }
    }

    return store
  }

  /**
   * Fork an existing session into a new session file.
   *
   * Reads `srcSid.jsonl`, copies every conversation record (user / assistant /
   * tool_result / note / rewind) into a brand-new `dstSid.jsonl` under a fresh
   * `meta` record that records the parent linkage (`parentSid` + `forkedAt`).
   * The parent file is NEVER modified — fork is non-destructive.
   *
   * Filtered OUT of the copy:
   *   - the parent's `meta` record (we write our own, with the new sid/hashes)
   *   - any `attach` / `detach` records (those are per-process pointers and
   *     belong to other processes; the new fork's own attach is written
   *     separately by the caller via `appendAttach()`)
   *
   * Preserved in the copy, in original write order:
   *   - `user`, `assistant`, `tool_result`, `note`, `rewind`
   *
   * `existsOk` defaults to false — fork into an existing dstSid throws (sid
   * collision is almost certainly a bug).
   *
   * Why fork instead of continue-in-place? When `--resume <X>` is invoked,
   * the rest of the agent (banner, logs, plugin sessionId, tasks/scratch
   * files, the goodbye banner's `--resume <id>` hint) ALL use the fresh
   * per-process UUID. The session JSONL was the odd one out, silently
   * appending to the parent file under the old sid — so the goodbye
   * banner's resume hint pointed to a file that did not exist. Forking
   * aligns the store with the rest of the agent: one consistent sid that
   * actually round-trips through `--resume`.
   *
   * Sidecar files (`<srcSid>.tasks.jsonl`, `<srcSid>.scratch.md`,
   * `<srcSid>.draft`, anything else of the form `<srcSid>.<ext>`) are
   * ALSO copied across to the new sid as part of the fork, so a resumed
   * session sees the same per-sid state the parent had. The blob
   * DIRECTORY (`<srcSid>.blobs/`) is intentionally NOT copied: tool
   * results in the conversation log carry absolute paths into the
   * parent's blob dir, so blobs survive resume by reference. See the
   * implementation block below for the exact rule.
   */
  static fork(opts: {
    srcSid: string
    dstSid: string
    model: string
    cwd: string
    systemHash: string
    toolsHash: string
    agentVersion: string
    argv?: string[]
    dir?: string
    provider?: string
    credentialName?: string
    /** Allow forking onto an existing dstSid file. Default false. */
    existsOk?: boolean
    /** Override the timestamp; tests use this for determinism. */
    now?: () => Date
    /** Sub-agent lineage for the new index line. Default: the process env. `null` writes none. */
    lineage?: IndexLineage | null
  }): SessionStore {
    const dir = opts.dir ?? defaultSessionsDir()
    mkdirSync(dir, { recursive: true })
    const store = new SessionStore(opts.dstSid, dir, opts.agentVersion)
    const now = (opts.now ?? (() => new Date()))()
    const createdAt = now.toISOString()

    const dstExists = (() => {
      try {
        readFileSync(store.path, "utf-8")
        return true
      } catch {
        return false
      }
    })()

    if (dstExists && !opts.existsOk) {
      throw new Error(
        `SessionStore.fork: destination already exists at ${store.path} (pass existsOk:true to append)`,
      )
    }

    // Read parent. Missing parent is a fatal error — caller should have
    // verified the parent exists before requesting a fork.
    const srcPath = sessionFilePath(opts.srcSid, dir)
    const srcText = readFileSync(srcPath, "utf-8")
    const { records: srcRecords } = parseLines(srcText)

    // Build the fork file: new meta on top, then every preserved record
    // verbatim in original order. `attach`/`detach` are dropped because
    // they reference other processes; the caller writes its own attach
    // via `appendAttach()` after fork() returns.
    const meta: MetaRecord = {
      kind: "meta",
      formatVersion: 1,
      sid: opts.dstSid,
      createdAt,
      model: opts.model,
      cwd: opts.cwd,
      systemHash: opts.systemHash,
      toolsHash: opts.toolsHash,
      agentVersion: opts.agentVersion,
      parentSid: opts.srcSid,
      forkedAt: createdAt,
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.credentialName ? { credentialName: opts.credentialName } : {}),
    }
    const lines: string[] = [JSON.stringify(meta)]
    for (const r of srcRecords) {
      switch (r.kind) {
        case "meta":
        case "attach":
        case "detach":
          continue
        default:
          lines.push(JSON.stringify(r))
          // Any preserved record (user/assistant/tool_result/note/rewind)
          // counts as conversation. A forked session that already carries
          // history must NOT be eligible for cleanup-on-exit even if the
          // resumed REPL session itself adds nothing new.
          store.hasConversation = true
      }
    }
    // `wx` ensures we never silently overwrite a dst that appeared
    // between the existence check and the write (TOCTOU). When existsOk
    // is true we accept overwrite, so use the plain write path.
    if (dstExists && opts.existsOk) {
      writeFileSync(store.path, `${lines.join("\n")}\n`)
    } else {
      writeFileSync(store.path, `${lines.join("\n")}\n`, { flag: "wx" })
    }

    // Index entry for the new fork. Mirrors `open()` — discoverable by
    // `--resume last` and surfaced in any session listing. We do NOT add
    // an `argv`-shaped marker for "this was a fork"; the meta record
    // carries `parentSid` already, which is the canonical source.
    const indexRecord: IndexRecord = {
      sid: opts.dstSid,
      createdAt,
      cwd: opts.cwd,
      model: opts.model,
      argv: opts.argv,
      ...lineageFields(opts.dstSid, opts.lineage),
    }
    appendFileSync(indexFilePath(dir), `${JSON.stringify(indexRecord)}\n`)

    // Per-sid sidecar files (tasks plugin, memory short-term scratch,
    // input draft, future plugins) live in the same directory under the
    // SAME `<sid>.<ext>` prefix and are looked up at runtime by the
    // CURRENT sid. Without copying them across the fork, a resumed
    // session sees an empty tasks list, empty short-term scratchpad,
    // empty draft, etc. — even though the conversation log has been
    // forked verbatim. The model is then forced to reconcile a turn
    // history that references task ids it cannot find, scratchpad
    // entries that no longer exist, etc.
    //
    // Copy any sibling FILE that starts with `<srcSid>.` (other than
    // the JSONL itself, which fork just wrote in its new form) to the
    // matching `<dstSid>.<suffix>` path. Directories are skipped —
    // notably `<srcSid>.blobs/`, which is intentionally NOT duplicated:
    // tool-result records carry ABSOLUTE paths into the parent's blob
    // directory, so blobs already survive resume by reference and
    // copying them would waste disk without any correctness gain.
    //
    // Per-sidecar failures are best-effort: we don't want a single
    // unreadable scratch file (or weird filesystem error) to abort the
    // whole resume. The JSONL is the authoritative state; missing
    // sidecars just degrade to empty, which was the pre-fix behavior.
    try {
      const srcJsonlBasename = `${opts.srcSid}.jsonl`
      const srcPrefix = `${opts.srcSid}.`
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (entry.name === srcJsonlBasename) continue
        if (!entry.name.startsWith(srcPrefix)) continue
        const suffix = entry.name.slice(opts.srcSid.length) // includes the leading "."
        const srcPath = join(dir, entry.name)
        const dstPath = join(dir, `${opts.dstSid}${suffix}`)
        try {
          copyFileSync(srcPath, dstPath)
        } catch {
          // best-effort per sidecar; silent on copy failure
        }
      }
    } catch {
      // best-effort directory scan; if the sessions dir is unreadable
      // here, the JSONL writes above would have failed first
    }

    return store
  }

  /**
   * Append an `attach` record marking that THIS process is now attached
   * to this session. Call once, immediately after `open()` — and again
   * (cheap, idempotent in effect) on every resume.
   *
   * The recorded `startTime` is captured at first call to
   * {@link getOwnStartTime} and cached for the life of the process.
   */
  appendAttach(now: Date = new Date()): void {
    const rec: AttachRecord = {
      kind: "attach",
      ts: now.toISOString(),
      pid: process.pid,
      ppid: typeof process.ppid === "number" ? process.ppid : 0,
      startTime: getOwnStartTime(),
      hostname: osHostname(),
      agentVersion: this.agentVersion,
    }
    this.write(rec)
  }

  /**
   * Append a best-effort clean-shutdown marker. Failure to write (e.g.
   * because we're already in `process.exit`) is swallowed — readers do
   * NOT depend on this record for correctness.
   *
   * After the marker, append a `kind: "summary"` line to `index-meta.jsonl`
   * (title, tokens, turns, end time, status) so a session listing does not
   * read the session file. Best-effort too: see {@link appendIndexSummary}.
   */
  appendDetach(reason: DetachRecord["reason"], exitCode?: number, now: Date = new Date()): void {
    const rec: DetachRecord = {
      kind: "detach",
      ts: now.toISOString(),
      pid: process.pid,
      reason,
      ...(exitCode != null ? { exitCode } : {}),
    }
    try {
      this.write(rec)
    } catch {
      // Best-effort. Don't crash mid-shutdown.
      return
    }
    this.appendIndexSummary()
  }

  /**
   * Read this session file, compute its summary, and append a summary line
   * to `index-meta.jsonl`. Skipped for a file larger than
   * {@link SUMMARY_ON_CLOSE_MAX_BYTES} (the catalog computes it later, on
   * demand). Never throws. Returns `true` when a line was written.
   */
  appendIndexSummary(): boolean {
    try {
      if (statSync(this.path).size > SUMMARY_ON_CLOSE_MAX_BYTES) return false
      const { records } = parseLines(readFileSync(this.path, "utf-8"))
      const meta = records.find((r): r is MetaRecord => r.kind === "meta")
      const summary = computeSessionSummary(records, meta?.model ? { modelId: meta.model } : {})
      // A token count that is not known stays out of the sidecar: a later
      // estimator can compute it (the catalog computes it on demand).
      if (summary.tokensUnknown) return false
      return appendIndexSummaryLine(
        indexMetaFilePath(this.dir),
        toIndexSummaryRecord(this.sid, summary),
      )
    } catch {
      return false
    }
  }

  /**
   * Append a `user` record. Call this immediately after pushing onto
   * `Agent.messages`. Returns the freshly-generated `id` so callers (e.g.
   * the rewind picker) can reference this prompt later.
   */
  appendUser(content: string | ContentBlock[], now: Date = new Date()): string {
    const id = randomUUID()
    this.write({ kind: "user", ts: now.toISOString(), content, id })
    this.hasConversation = true
    return id
  }

  /** Append an `assistant` record. Call after a complete assistant turn. */
  appendAssistant(
    content: ContentBlock[],
    stopReason: string | null,
    usage?: AssistantRecord["usage"],
    now: Date = new Date(),
    meta?: { providerMessageId?: string },
  ): void {
    const rec: AssistantRecord = {
      kind: "assistant",
      ts: now.toISOString(),
      content,
      stopReason,
      usage,
    }
    if (meta?.providerMessageId) rec.providerMessageId = meta.providerMessageId
    this.write(rec)
    this.hasConversation = true
  }

  /**
   * Append a `tool_result` record. Call after every tool execution incl.
   * abort. The optional `rawBlob` parameter is populated by the agent
   * when the per-session blob store persisted the pre-clamp body of
   * this call (see `src/blob-store.ts`). It is recorded in the JSONL so
   * session resume / dump can find the raw bytes on disk again.
   *
   * The record carries no presentation fields (spec S29). A host replay
   * derives its own view from the stored record.
   *
   * The optional `outcome` is the persisted outcome of this result in
   * record form (SPEC v6.1 D8 rule 7). The caller converts one time
   * (`attachPersistedOutcome` in `src/sdk/tool-outcome-record.ts`) and gives
   * the same record that the live block holds. Only this argument gives it:
   * the store does not read `block.outcome`. Written only when present.
   */
  appendToolResult(
    block: ToolResultBlock,
    now: Date = new Date(),
    rawBlob?: { path: string; bytes: number; sha256: string },
    outcome?: PersistedToolOutcome,
  ): void {
    const rec: ToolResultRecord = {
      kind: "tool_result",
      ts: now.toISOString(),
      tool_use_id: block.tool_use_id,
      content: block.content,
      isError: !!block.is_error,
    }
    if (block.sideband) rec.sideband = { kind: block.sideband.kind }
    if (outcome) rec.outcome = outcome
    if (rawBlob) {
      rec.rawPath = rawBlob.path
      rec.rawBytes = rawBlob.bytes
      rec.rawSha256 = rawBlob.sha256
    }
    this.write(rec)
    this.hasConversation = true
  }

  /** Free-form annotation (mode change, error, manual marker). */
  appendNote(text: string, now: Date = new Date()): void {
    this.write({ kind: "note", ts: now.toISOString(), text })
    this.hasConversation = true
  }

  /**
   * Append a durable compact checkpoint. Does NOT delete prior history;
   * model folds from this marker via {@link foldRecordsForModel}.
   */
  appendCompact(
    rec: Omit<CompactRecord, "kind" | "ts" | "meta"> & {
      ts?: string
      /** Meta without `at`: the writer sets `at` equal to the row `ts`. */
      meta?: Omit<CompactMeta, "at">
    },
    now: Date = new Date(),
  ): void {
    const ts = rec.ts ?? now.toISOString()
    const row: CompactRecord = {
      kind: "compact",
      ts,
      reason: rec.reason,
      compactKind: rec.compactKind,
      messagesBefore: rec.messagesBefore,
      messagesAfter: rec.messagesAfter,
      replacementMessages: rec.replacementMessages,
    }
    if (rec.id !== undefined) row.id = rec.id
    if (rec.encryptedContent !== undefined) row.encryptedContent = rec.encryptedContent
    if (rec.meta !== undefined) row.meta = { ...rec.meta, at: ts }
    this.write(row)
    this.hasConversation = true
  }

  /**
   * Append a `rewind` record marking the session as rewound to the user
   * prompt with id `toMsgId`. Append-only: the dropped records remain on
   * disk; `foldRecords` honors this marker on read to produce the effective
   * conversation. `droppedCount` is informational (for replay UX).
   */
  appendRewind(toMsgId: string, droppedCount: number, now: Date = new Date()): void {
    this.write({ kind: "rewind", ts: now.toISOString(), to: toMsgId, droppedCount })
    this.hasConversation = true
  }

  /** Append an audit link after a strict history-edit cut. */
  appendHistoryEdit(
    targetUserId: string,
    backupSid: string,
    droppedRecordCount: number,
    now: Date = new Date(),
  ): void {
    this.write({
      kind: "history_edit",
      ts: now.toISOString(),
      targetUserId,
      backupSid,
      droppedRecordCount,
    })
    this.hasConversation = true
  }

  /** Spec alias for {@link appendRewind}. */
  recordRewind(toMsgId: string, droppedCount: number, now: Date = new Date()): void {
    this.appendRewind(toMsgId, droppedCount, now)
  }

  /**
   * Append a round checkpoint (S50). Pure metadata: it does not mark the
   * session as having real conversation (the round's own records already
   * did that), so it never keeps an otherwise-empty session from cleanup.
   */
  appendRoundCheckpoint(
    checkpoint: { round: number; maxTokensStreak: number; interruptedStreak: number },
    now: Date = new Date(),
  ): void {
    this.write({
      kind: "round_checkpoint",
      ts: now.toISOString(),
      round: checkpoint.round,
      maxTokensStreak: checkpoint.maxTokensStreak,
      interruptedStreak: checkpoint.interruptedStreak,
    })
  }

  /**
   * Append a target-switch record. Pure metadata, like a round checkpoint:
   * it does not mark the session as having real conversation.
   */
  appendTargetSwitch(
    target: Omit<TargetSwitchRecord, "kind" | "ts">,
    now: Date = new Date(),
  ): void {
    this.write({
      kind: "target_switch",
      ts: now.toISOString(),
      ...(target.providerId !== undefined ? { providerId: target.providerId } : {}),
      ...(target.credentialName !== undefined ? { credentialName: target.credentialName } : {}),
      model: target.model,
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      discardedThinking: target.discardedThinking,
    })
  }

  /**
   * Remove the on-disk artifacts for this session iff it never carried any
   * real conversation (user/assistant/tool_result/note/rewind). The
   * intended caller is the process-exit handler in the host entry point: an
   * "opened-and-closed" REPL with no actual exchange leaves nothing
   * worth listing, and stale entries clutter `--sessions` and
   * `--resume last` resolution.
   *
   * Removes, in best-effort order:
   *   1. the JSONL log at `this.path`
   *   2. the index entry: a tombstone line goes to `index-meta.jsonl`
   *      (append only; `index.jsonl` is not rewritten)
   *   3. any sidecar files of the form `<sid>.<suffix>` in the sessions
   *      directory (tasks plugin, memory scratch, draft buffer, …)
   *   4. the `<sid>.blobs/` directory if present (lazy-created by the
   *      blob store; usually absent on unused sessions)
   *
   * Returns `true` when the cleanup ran, `false` when this session has
   * real conversation and was preserved. Per-step failures are swallowed:
   * cleanup is opportunistic, not load-bearing. Readers apply the
   * tombstone (`parseSessionIndexText`); a lost tombstone leaves a stale
   * index entry, which the missing-file filter in `readSessionIndex` and
   * the catalog drop.
   */
  cleanupIfUnused(): boolean {
    if (this.hasConversation) return false

    // 1) JSONL log
    try {
      unlinkSync(this.path)
    } catch {
      // best-effort
    }

    // 2) Index entry: append a tombstone line to the sidecar
    // `index-meta.jsonl`, do not rewrite index.jsonl. Other processes
    // append to the index at any time with no lock. A read + rewrite
    // (O_TRUNC) lost their lines and could leave NUL holes (P1 review M1).
    // One small O_APPEND write is atomic for the offset, so a tombstone
    // cannot lose or corrupt another line. `indexBytes` (the index size
    // now) limits the tombstone to the session lines before it, so a later
    // re-use of the sid is kept. Readers apply it in
    // `parseSessionIndexText`; older builds never read the sidecar and
    // drop the sid anyway because its file is gone.
    try {
      let indexBytes: number | undefined
      try {
        indexBytes = statSync(indexFilePath(this.dir)).size
      } catch {
        // No index: the tombstone removes all lines of the sid.
      }
      const tombstone: IndexTombstoneRecord = {
        kind: "tombstone",
        sid: this.sid,
        at: new Date().toISOString(),
        ...(indexBytes !== undefined ? { indexBytes } : {}),
      }
      appendFileSync(indexMetaFilePath(this.dir), `${JSON.stringify(tombstone)}\n`)
    } catch {
      // best-effort
    }

    // 3) Sidecars: any sibling FILE named `<sid>.<suffix>`. Skip
    // directories here — those are handled in step 4.
    try {
      const prefix = `${this.sid}.`
      for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue
        if (!entry.name.startsWith(prefix)) continue
        try {
          unlinkSync(join(this.dir, entry.name))
        } catch {
          // per-sidecar best-effort
        }
      }
    } catch {
      // best-effort directory scan
    }

    // 4) `<sid>.blobs/` directory (lazy-created; usually absent here).
    try {
      rmSync(join(this.dir, `${this.sid}.blobs`), { recursive: true, force: true })
    } catch {
      // best-effort
    }

    return true
  }

  private write(rec: SessionRecord): void {
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`)
  }
}

// ---------------------------------------------------------------------------
// Hashing helpers (used by index.ts to compute systemHash/toolsHash)
// ---------------------------------------------------------------------------

/**
 * Stable short hash for arbitrary input. Not cryptographic — just enough
 * to detect drift between session-save-time and resume-time. FNV-1a 32-bit
 * rendered as 8 hex chars; collisions are fine because we only use it to
 * say "warn the user that something changed".
 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Core domain types for the sub-agents plugin.
 *
 * Design posture (see `private/subagent-research-and-plan/research/05-pattern-decisions.md`):
 *
 * - **Discriminated Union State** for {@link SubagentStatus}: a worker's
 *   lifecycle is a tagged union so illegal states are unrepresentable (a
 *   `done` worker carries a result; a `failed` one an error; a `running` one a
 *   live pid). No status-string-plus-nullable-fields soup.
 * - **Branded types** for {@link SubagentId} and {@link SessionId} so a handle
 *   id ("A2") and a session uuid can never be swapped at a call site.
 * - **Result** for fallible operations, so failures are typed values, not
 *   thrown exceptions (no dependency; a 6-line local helper).
 *
 * This module is PURE types + tiny constructors. No I/O, no process, no clock.
 *
 * @module sub-agents/lib/types
 */

// ---------------------------------------------------------------------------
// Branded ids
// ---------------------------------------------------------------------------

/**
 * A short, human-facing worker handle the model uses to address a worker,
 * e.g. `"A2"` or `"W07"`. Branded so it can't be passed where a
 * {@link SessionId} is expected.
 */
export type SubagentId = string & { readonly __brand: "SubagentId" }

/** A minimal-agent session id (uuid v4). Branded; distinct from {@link SubagentId}. */
export type SessionId = string & { readonly __brand: "SessionId" }

/** Brand a raw string as a {@link SubagentId} (no validation; ids are minted internally). */
export function subagentId(s: string): SubagentId {
  return s as SubagentId
}

/** Brand a raw string as a {@link SessionId}. */
export function sessionId(s: string): SessionId {
  return s as SessionId
}

// ---------------------------------------------------------------------------
// Result (typed failure, not exceptions)
// ---------------------------------------------------------------------------

/** A success/failure value. `E` defaults to `string` (a human-readable reason). */
export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E }

/** Construct a success. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Construct a failure. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ---------------------------------------------------------------------------
// Spawn knobs
// ---------------------------------------------------------------------------

/**
 * Context isolation tier (a Strategy selector — see `spawn-plan.ts`):
 * - `fresh`: a new session, clean context (task + worker system prompt only).
 * - `fork`: inherit the lead's conversation via `SessionStore.fork`
 *   (cache-sharing, sees the lead's context).
 */
export type Isolation = "fresh" | "fork"

/**
 * Filesystem isolation tier:
 * - `inherit-cwd`: the worker runs in the lead's cwd (disjoint-files discipline).
 * - `scratch`: a dedicated scratch dir quarantines the worker's file output.
 */
export type Workspace = "inherit-cwd" | "scratch"

/** A worker effort/runtime budget. All optional; the supervisor trips a stop when exceeded. */
export interface Budget {
  /** Max agentic turns before the worker is stopped. */
  readonly maxTurns?: number
  /** Wall-clock deadline in seconds from spawn. */
  readonly deadlineSec?: number
  /** Soft token ceiling (advisory; surfaced, not hard-enforced mid-call). */
  readonly maxTokens?: number
}

// ---------------------------------------------------------------------------
// Live progress + result digest
// ---------------------------------------------------------------------------

/** Live progress for a running worker, refreshed by the supervisor heartbeat. */
export interface Progress {
  /** Tool calls the worker has made so far. */
  readonly tools: number
  /** Tokens the worker has consumed so far. */
  readonly tokens: number
  /** Name of the most recent tool, for the widget's "what's it doing" column. */
  readonly lastTool?: string
  /** A one-line digest of the worker's most recent activity. */
  readonly lastActivity?: string
}

/** The zero progress value a worker starts with. */
export const ZERO_PROGRESS: Progress = { tools: 0, tokens: 0 }

/**
 * The distilled deliverable a worker returns. This is the ONLY worker content
 * that crosses back into the lead's context, and it is bounded.
 */
export interface ResultDigest {
  /** The worker's final synthesis, clipped. */
  readonly short: string
  /** Total tokens the worker spent. */
  readonly tokens: number
  /** Total tool calls the worker made. */
  readonly tools: number
  /** Paths/refs to artifacts the worker wrote (passed by reference, not value). */
  readonly artifacts?: readonly string[]
}

// ---------------------------------------------------------------------------
// Lifecycle status (discriminated union — illegal states unrepresentable)
// ---------------------------------------------------------------------------

/**
 * A worker's lifecycle state. Tagged by `kind`; each variant carries exactly
 * the data valid in that state.
 *
 * ```
 * queued ──▶ running ──┬─▶ done     (clean finish, has a result)
 *                      ├─▶ failed   (crash / non-zero exit / timeout)
 *                      └─▶ stopped  (lead canceled it)
 * ```
 */
export type SubagentStatus =
  | { readonly kind: "queued" }
  | {
      readonly kind: "running"
      readonly pid: number
      readonly startedAt: string
      readonly progress: Progress
    }
  | { readonly kind: "done"; readonly endedAt: string; readonly result: ResultDigest }
  | {
      readonly kind: "failed"
      readonly endedAt: string
      readonly error: string
      readonly exitCode?: number
    }
  | { readonly kind: "stopped"; readonly endedAt: string; readonly reason?: string }

/** All terminal status kinds (no further transitions). */
export type TerminalKind = "done" | "failed" | "stopped"

/** True when a status is terminal (worker finished, one way or another). */
export function isTerminal(s: SubagentStatus): boolean {
  switch (s.kind) {
    case "done":
    case "failed":
    case "stopped":
      return true
    case "queued":
    case "running":
      return false
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** True when a worker is still consuming resources (queued or running). */
export function isActive(s: SubagentStatus): boolean {
  return !isTerminal(s)
}

// ---------------------------------------------------------------------------
// The durable handle (one record per worker)
// ---------------------------------------------------------------------------

/**
 * A worker handle, persisted append-only in `<leadSid>.subagents.jsonl`. This
 * is the supervisor's source of truth; the model addresses workers by
 * {@link SubagentRecord.id}.
 */
export interface SubagentRecord {
  /** Short handle, e.g. `"A2"`. Unique within a lead's fleet. */
  readonly id: SubagentId
  /** The worker's own minimal-agent session id (its `<sid>.jsonl`). */
  readonly sid: SessionId
  /** Short display name for the widget/transcript (defaults to `type`). */
  readonly label: string
  /** Definition name (e.g. `"reviewer"`) or `"inline"`. */
  readonly type: string
  /** Resolved model id the worker runs on. */
  readonly model: string
  /** The delegation prompt (objective + boundaries). */
  readonly task: string
  /** Context isolation tier used at spawn. */
  readonly isolation: Isolation
  /** Filesystem isolation tier used at spawn. */
  readonly workspace: Workspace
  /** ISO timestamp the worker was spawned. */
  readonly spawnedAt: string
  /** Current lifecycle state. */
  readonly status: SubagentStatus
  /** Optional runtime budget. */
  readonly budget?: Budget
  /** Linked tasks-plugin task hash, when the worker owns a task. */
  readonly taskId?: string
  /** Nesting depth (the lead is depth 0; its direct workers are depth 1). */
  readonly depth: number
  /** The lead session that spawned this worker (lineage). */
  readonly leadSid: SessionId
}

/** Per-status counts across a fleet. */
export interface FleetStats {
  readonly total: number
  readonly queued: number
  readonly running: number
  readonly done: number
  readonly failed: number
  readonly stopped: number
  /** Sum of tokens across all workers (running progress + finished results). */
  readonly tokens: number
}

/** Compute {@link FleetStats} over a set of records. Pure. */
export function fleetStats(records: readonly SubagentRecord[]): FleetStats {
  let queued = 0
  let running = 0
  let done = 0
  let failed = 0
  let stopped = 0
  let tokens = 0
  for (const r of records) {
    switch (r.status.kind) {
      case "queued":
        queued++
        break
      case "running":
        running++
        tokens += r.status.progress.tokens
        break
      case "done":
        done++
        tokens += r.status.result.tokens
        break
      case "failed":
        failed++
        break
      case "stopped":
        stopped++
        break
      default: {
        const _exhaustive: never = r.status
        throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
      }
    }
  }
  return { total: records.length, queued, running, done, failed, stopped, tokens }
}

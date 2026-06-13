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
  /**
   * True when `short` was DISTILLED from the worker's final assistant message
   * rather than read from a structured result sentinel the worker wrote on
   * purpose. The work still counts as `done`, but the lead should know the
   * summary is best-effort (no explicit `artifacts`, counts inferred from
   * progress). Absent/false ⇒ a real sentinel.
   */
  readonly distilled?: boolean
  /**
   * True when the worker itself reported it could NOT finish (via
   * `ReportResult({incomplete:true})`, or a hand-written `INCOMPLETE:` sentinel
   * prefix). The supervisor must route this to an `incomplete` status, never
   * launder it into `done`: the summary is still salvaged for the lead, but the
   * work is unverified and any linked todo is canceled, not ticked green.
   */
  readonly incomplete?: boolean
}

// ---------------------------------------------------------------------------
// Lifecycle status (discriminated union — illegal states unrepresentable)
// ---------------------------------------------------------------------------

/**
 * A worker's lifecycle state. Tagged by `kind`; each variant carries exactly
 * the data valid in that state.
 *
 * ```
 * queued ──▶ running ──┬─▶ done        (clean finish WITH a real deliverable)
 *                      ├─▶ incomplete  (clean exit but NO deliverable captured)
 *                      ├─▶ failed      (crash / non-zero exit / timeout)
 *                      └─▶ stopped     (lead canceled it)
 * ```
 *
 * `incomplete` is the honest middle ground between `done` and `failed`: the
 * process exited 0 but the deliverable contract was not met — either it produced
 * no result sentinel and no distillable final message, OR a contracted
 * `expectArtifacts` path is missing/empty. It MUST NOT be laundered into `done`:
 * a missing deliverable is a signal the lead has to act on, not a silent success.
 * It carries the counts so the widget can show effort spent, a `reason` the lead
 * can read, and — crucially — any `salvage` synthesis the worker DID produce
 * (its sentinel text or distilled final message) so a contract miss never throws
 * away the work. The lead still re-spawns/verifies, but reads the findings first.
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
      readonly kind: "incomplete"
      readonly endedAt: string
      /** Why no deliverable was captured (e.g. "exited without result sentinel"). */
      readonly reason: string
      /** Tokens spent before the worker exited (from live progress). */
      readonly tokens: number
      /** Tool calls made before the worker exited. */
      readonly tools: number
      /**
       * Best-effort synthesis SALVAGED from the worker even though the
       * deliverable contract was not met — the text of its result sentinel or,
       * failing that, its distilled final assistant message. Present when the
       * worker DID produce findings but failed to materialize a contracted
       * `expectArtifacts` path: the status is still `incomplete` (the file
       * contract is a hard gate), but the lead gets the work back via
       * `AgentResult` instead of being forced to mine the worker's transcript.
       * Absent when the worker was truly silent (no sentinel, no final text).
       */
      readonly salvage?: string
      /** Artifact paths the worker's sentinel CLAIMED, if any (for the lead to verify/locate). */
      readonly artifacts?: readonly string[]
    }
  | {
      readonly kind: "failed"
      readonly endedAt: string
      readonly error: string
      readonly exitCode?: number
    }
  | { readonly kind: "stopped"; readonly endedAt: string; readonly reason?: string }

/** All terminal status kinds (no further transitions). */
export type TerminalKind = "done" | "incomplete" | "failed" | "stopped"

/** True when a status is terminal (worker finished, one way or another). */
export function isTerminal(s: SubagentStatus): boolean {
  switch (s.kind) {
    case "done":
    case "incomplete":
    case "failed":
    case "stopped":
      return true
    case "queued":
    case "running":
      return false
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
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
  /**
   * Absolute paths this worker MUST produce to count as `done` (FIX 4).
   * Persisted on the handle so the supervisor's async probe (a later tick than
   * the spawn) can stat them at terminal time. Empty/absent ⇒ no contract.
   */
  readonly expectArtifacts?: readonly string[]
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
  readonly incomplete: number
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
  let incomplete = 0
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
      case "incomplete":
        incomplete++
        tokens += r.status.tokens
        break
      case "failed":
        failed++
        break
      case "stopped":
        stopped++
        break
      default: {
        throw new Error(`unhandled status kind: ${String(r.status satisfies never)}`)
      }
    }
  }
  return { total: records.length, queued, running, done, incomplete, failed, stopped, tokens }
}

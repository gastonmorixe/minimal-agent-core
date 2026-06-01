/**
 * The supervisor tick — a PURE reducer at the heart of the fleet.
 *
 * `supervisorTick(input) -> { records, effects, changed }`. Given the current
 * fleet, the probes the shell gathered this tick (is each worker's pid alive?
 * did it produce a result? how much progress?), and the wall clock, it
 * computes the next fleet AND a list of {@link Effect} DESCRIPTIONS the shell
 * executes (inject a digest, emit a bus event, kill a timed-out pid).
 *
 * No IO, no clock, no bus, no spawn. The heartbeat handler (`handlers/
 * heartbeat.ts`) is the imperative shell that gathers probes, calls this, runs
 * the effects, and persists the fleet. This split is what makes the lifecycle
 * state machine exhaustively unit-testable. Mirrors `schedule/lib/scheduler`.
 *
 * @module sub-agents/lib/supervisor
 */

import {
  isTerminal,
  type Progress,
  type ResultDigest,
  type SubagentId,
  type SubagentRecord,
  type SubagentStatus,
} from "./types.ts"

/** What the shell observed about one worker this tick. */
export interface WorkerProbe {
  /** Is the worker's process still running? */
  readonly alive: boolean
  /** The worker's exit code, when it has exited. */
  readonly exitCode?: number
  /** A parsed result digest, when the worker finished and the shell read it. */
  readonly result?: ResultDigest
  /** Live progress (tools/tokens/last activity), when the worker is running. */
  readonly progress?: Progress
}

/** A side-effect the shell must execute after the tick. Discriminated union. */
export type Effect =
  | { readonly type: "inject"; readonly text: string; readonly source: string }
  | { readonly type: "emit"; readonly channel: string; readonly payload: unknown }
  | { readonly type: "stop"; readonly id: SubagentId; readonly pid: number; readonly reason: string }

/** Input to {@link supervisorTick}. */
export interface TickInput {
  readonly records: readonly SubagentRecord[]
  /** Probe per worker id (only active workers need probing). */
  readonly probes: ReadonlyMap<string, WorkerProbe>
  /** ISO timestamp for status stamps. */
  readonly now: string
  /** Epoch ms for budget math. */
  readonly nowMs: number
}

/** Output of {@link supervisorTick}. */
export interface TickOutput {
  readonly records: SubagentRecord[]
  readonly effects: Effect[]
  /** True when any record changed (the shell should persist + repaint). */
  readonly changed: boolean
}

/** A short, bounded digest line injected into the lead when a worker finishes. */
export function completionDigest(r: SubagentRecord): string {
  switch (r.status.kind) {
    case "done": {
      const short = clip(r.status.result.short, 220)
      return `Sub-agent ${r.id} (${r.label}) finished: ${short} — pull the full result with AgentResult ${r.id}.`
    }
    case "failed":
      return `Sub-agent ${r.id} (${r.label}) failed: ${clip(r.status.error, 160)}.`
    case "stopped":
      return `Sub-agent ${r.id} (${r.label}) was stopped${r.status.reason ? `: ${clip(r.status.reason, 120)}` : ""}.`
    case "queued":
    case "running":
      return `Sub-agent ${r.id} (${r.label}) is ${r.status.kind}.`
    default: {
      const _exhaustive: never = r.status
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** Deadline check: has a running worker blown its `budget.deadlineSec`? */
function deadlineExceeded(r: SubagentRecord, startedAt: string, nowMs: number): boolean {
  const sec = r.budget?.deadlineSec
  if (sec === undefined || sec <= 0) return false
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return false
  return nowMs - startMs > sec * 1000
}

/**
 * Advance one record given its probe. Returns the next status (or the same
 * reference when unchanged) plus any effects the transition produced.
 */
function step(
  r: SubagentRecord,
  probe: WorkerProbe | undefined,
  now: string,
  nowMs: number,
): { status: SubagentStatus; effects: Effect[] } {
  // Terminal states never change.
  if (isTerminal(r.status)) return { status: r.status, effects: [] }

  const s = r.status
  // queued: only the shell's spawn moves it to running (with a pid). If a
  // probe says the process is already gone before we ever saw it running,
  // treat it as a failed launch.
  if (s.kind === "queued") {
    if (probe && !probe.alive) {
      const status: SubagentStatus = {
        kind: "failed",
        endedAt: now,
        error: "worker exited before it started running",
        ...(probe.exitCode !== undefined ? { exitCode: probe.exitCode } : {}),
      }
      return { status, effects: terminalEffects(r, status, now) }
    }
    return { status: s, effects: [] }
  }

  // running: the interesting transitions.
  // 1. Budget tripped → ask the shell to kill, mark failed(timeout).
  if (deadlineExceeded(r, s.startedAt, nowMs)) {
    const status: SubagentStatus = { kind: "failed", endedAt: now, error: "timed out (budget deadline exceeded)" }
    return {
      status,
      effects: [
        { type: "stop", id: r.id, pid: s.pid, reason: "deadline" },
        ...terminalEffects(r, status, now),
      ],
    }
  }
  // 2. No probe this tick → leave unchanged (transient: shell couldn't read).
  if (!probe) return { status: s, effects: [] }
  // 3. Still alive → refresh progress (no terminal effects).
  if (probe.alive) {
    if (!probe.progress) return { status: s, effects: [] }
    return { status: { ...s, progress: probe.progress }, effects: [] }
  }
  // 4. Exited. Result present → done. Non-zero exit and no result → failed.
  //    Clean exit but no parsed result → done with a placeholder summary.
  if (probe.result) {
    const status: SubagentStatus = { kind: "done", endedAt: now, result: probe.result }
    return { status, effects: terminalEffects(r, status, now) }
  }
  if (probe.exitCode !== undefined && probe.exitCode !== 0) {
    const status: SubagentStatus = { kind: "failed", endedAt: now, error: `exited with code ${probe.exitCode}`, exitCode: probe.exitCode }
    return { status, effects: terminalEffects(r, status, now) }
  }
  const status: SubagentStatus = {
    kind: "done",
    endedAt: now,
    result: { short: "(finished; no summary captured)", tokens: s.progress.tokens, tools: s.progress.tools },
  }
  return { status, effects: terminalEffects(r, status, now) }
}

/** Effects emitted on any active→terminal transition: a bus signal + a lead digest. */
function terminalEffects(r: SubagentRecord, next: SubagentStatus, _now: string): Effect[] {
  const withStatus: SubagentRecord = { ...r, status: next }
  const effects: Effect[] = [
    { type: "emit", channel: "subagent.didReport", payload: { id: r.id, sid: r.sid, status: next.kind } },
    { type: "emit", channel: "subagent.didExit", payload: { id: r.id, sid: r.sid, status: next.kind } },
    { type: "inject", text: completionDigest(withStatus), source: `subagent:${r.id}` },
  ]
  // Tasks-plugin linkage (decoupled, via the bus): if this worker owns a todo,
  // tick it green on a clean finish, or cancel it (with a reason) otherwise.
  // The `tasks` plugin subscribes to `subagent.taskUpdate` and applies it.
  if (r.taskId) {
    const status = next.kind === "done" ? "done" : "canceled"
    const reason =
      next.kind === "failed" ? next.error : next.kind === "stopped" ? next.reason : undefined
    effects.push({
      type: "emit",
      channel: "subagent.taskUpdate",
      payload: { taskId: r.taskId, status, ...(reason ? { reason } : {}), bySubagent: r.id },
    })
  }
  return effects
}

/**
 * Run one supervisor tick over the whole fleet. Pure.
 */
export function supervisorTick(input: TickInput): TickOutput {
  const out: SubagentRecord[] = []
  const effects: Effect[] = []
  let changed = false
  for (const r of input.records) {
    const probe = input.probes.get(r.id)
    const { status, effects: fx } = step(r, probe, input.now, input.nowMs)
    if (status !== r.status) {
      changed = true
      out.push({ ...r, status })
    } else {
      out.push(r)
    }
    for (const e of fx) effects.push(e)
  }
  return { records: out, effects, changed }
}

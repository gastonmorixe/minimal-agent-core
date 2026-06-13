/**
 * The supervisor tick — a PURE reducer at the heart of the fleet.
 *
 * `supervisorTick(input) -> { records, effects, changed }`. Given the current
 * fleet, the probes the shell gathered this tick (is each worker's pid alive?
 * did it produce a result? how much progress?), and the wall clock, it
 * computes the next fleet AND a list of {@link Effect} DESCRIPTIONS the shell
 * executes (inject a digest, emit a bus event, kill a timed-out pid).
 *
 * No IO, no clock, no bus, no spawn. The heartbeat handler
 * (`handlers/heartbeat.ts`) is the imperative shell that gathers probes, calls this, runs
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
  /** A parsed result digest from the structured sentinel, when present. */
  readonly result?: ResultDigest
  /**
   * The worker's distilled FINAL assistant message, used ONLY as a fallback when
   * no structured `result` sentinel was written. Lower precedence than `result`.
   */
  readonly distilled?: string
  /**
   * Of the worker's contracted `expectArtifacts`, the paths that are missing or
   * empty. Non-empty ⇒ the deliverable contract was not met (FIX 4).
   */
  readonly missingArtifacts?: readonly string[]
  /**
   * A crash signature mined from the worker's stdout/stderr log (FIX A): the
   * real cause of a startup/runtime death (bad model, missing beta, ENOENT, …).
   * Present ONLY when the worker exited producing no sentinel and no distillable
   * final message AND the log showed a fatal error. When set, the reducer reports
   * `failed` with this cause instead of laundering a crash into a generic
   * `incomplete · exited without a result`.
   */
  readonly crash?: string
  /** Live progress (tools/tokens/last activity), when the worker is running. */
  readonly progress?: Progress
}

/** A side-effect the shell must execute after the tick. Discriminated union. */
export type Effect =
  | { readonly type: "inject"; readonly text: string; readonly source: string }
  | { readonly type: "emit"; readonly channel: string; readonly payload: unknown }
  | {
      readonly type: "stop"
      readonly id: SubagentId
      readonly pid: number
      readonly reason: string
    }

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
    case "incomplete": {
      const salvaged = r.status.salvage
        ? ` Its findings WERE salvaged (it produced a summary but not the required file) — read them with AgentResult ${r.id} before deciding, you may not need a full re-run.`
        : ` Inspect it with AgentResult ${r.id} and re-spawn if you still need the work.`
      return `Sub-agent ${r.id} (${r.label}) finished ⚠ INCOMPLETE — deliverable contract not met (${clip(r.status.reason, 120)}). Not a clean success.${salvaged}`
    }
    case "failed":
      return `Sub-agent ${r.id} (${r.label}) failed: ${clip(r.status.error, 160)}.`
    case "stopped":
      return `Sub-agent ${r.id} (${r.label}) was stopped${r.status.reason ? `: ${clip(r.status.reason, 120)}` : ""}.`
    case "queued":
    case "running":
      return `Sub-agent ${r.id} (${r.label}) is ${r.status.kind}.`
    default: {
      throw new Error(`unhandled status kind: ${String(r.status satisfies never)}`)
    }
  }
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/**
 * Strip a leading `INCOMPLETE:` marker (and surrounding whitespace) from a
 * salvaged summary so the lead reads the findings, not the routing marker. The
 * status kind already carries the "incomplete" signal. Returns undefined when
 * nothing useful is left.
 */
function stripIncompleteMarker(short: string): string | undefined {
  const out = short.replace(/^\s*INCOMPLETE:\s*/, "").trim()
  return out.length > 0 ? out : undefined
}

/**
 * Hard wall-clock ceiling applied to EVERY running worker when its budget does
 * not set an explicit `deadlineSec` (B-083). Budgets are almost never set, so
 * without a default a worker that wedges mid-finalize (e.g. frozen at its
 * `ReportResult` write) stays `running` forever and permanently holds a
 * concurrency slot (it keeps counting toward `maxConcurrent` via `isActive`).
 * 30 min is generous enough that a legitimate long-running worker is not killed,
 * but a truly stuck one is eventually reaped. An explicit `budget.deadlineSec`
 * always overrides this.
 */
export const DEFAULT_DEADLINE_SEC = 30 * 60 // 30 minutes

/**
 * Shorter no-progress window after which a worker would be treated as stalled.
 *
 * FOLLOW-UP (B-083, stall watchdog): a true stall watchdog needs a
 * last-progress timestamp on the record (e.g. `Progress.lastProgressAt` or a
 * `SubagentRecord` field the heartbeat stamps when tools/tokens advance). The
 * current `Progress` type ({@link types.ts}) carries `tools`/`tokens`/`lastTool`/
 * `lastActivity` but NO timestamp, and this reducer is pure (it only gets `now`
 * each tick), so it cannot measure "no progress for N seconds" without that
 * field. Rather than invent a whole tracking system here, the watchdog is left
 * as a follow-up: add a progress timestamp, then gate a stall kill on it through
 * the SAME terminal path as the deadline below. The default hard deadline
 * (above) already stops the unbounded slot leak in the meantime.
 */
export const DEFAULT_STALL_SEC = 5 * 60 // 5 minutes (reserved for the follow-up watchdog)

/**
 * The effective wall-clock deadline (seconds) for a worker: its explicit
 * `budget.deadlineSec` when set and positive, else the hard {@link
 * DEFAULT_DEADLINE_SEC} (B-083). A non-positive budget is treated as "unset".
 */
function effectiveDeadlineSec(r: SubagentRecord): number {
  const explicit = r.budget?.deadlineSec
  return explicit !== undefined && explicit > 0 ? explicit : DEFAULT_DEADLINE_SEC
}

/**
 * Deadline check: has a running worker blown its effective deadline? Unlike the
 * old check, an UNBUDGETED worker is no longer exempt — it falls back to
 * {@link DEFAULT_DEADLINE_SEC} so a wedged worker is eventually killed (B-083).
 */
function deadlineExceeded(r: SubagentRecord, startedAt: string, nowMs: number): boolean {
  const startMs = Date.parse(startedAt)
  if (!Number.isFinite(startMs)) return false
  return nowMs - startMs > effectiveDeadlineSec(r) * 1000
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

  // From here only `running` is possible (terminal states returned via the
  // `isTerminal` guard above; `queued` returned just now). This explicit check
  // also narrows `s` to the running variant for the type system.
  if (s.kind !== "running") return { status: s, effects: [] }

  // running: the interesting transitions.
  // 1. Deadline tripped → ask the shell to kill, mark failed(timeout). This now
  //    fires for UNBUDGETED workers too, via the DEFAULT_DEADLINE_SEC fallback
  //    in `deadlineExceeded` (B-083): a worker wedged mid-finalize (e.g. stuck at
  //    ReportResult) used to be exempt and leaked its concurrency slot forever.
  //    Routed through the SAME stop + terminalEffects path as an explicit budget
  //    so the pid is actually killed and the record transitions to failed WITH
  //    terminal effects emitted (no B-087-style bypass).
  if (deadlineExceeded(r, s.startedAt, nowMs)) {
    const hadBudget = (r.budget?.deadlineSec ?? 0) > 0
    const status: SubagentStatus = {
      kind: "failed",
      endedAt: now,
      error: hadBudget
        ? "timed out (budget deadline exceeded)"
        : `timed out (no progress; exceeded ${DEFAULT_DEADLINE_SEC}s default hard deadline — likely wedged)`,
    }
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
  // 4. Exited. Decide the terminal status.
  //    a. A non-zero exit → failed (it crashed), regardless of any artifacts.
  //       Prefer the log's crash signature (the REAL cause: bad model, missing
  //       beta, ENOENT) over the bare exit code, so the lead reads "why" not
  //       just "code 1".
  if (probe.exitCode !== undefined && probe.exitCode !== 0) {
    const error = probe.crash
      ? `${probe.crash} (exit ${probe.exitCode})`
      : `exited with code ${probe.exitCode}`
    const status: SubagentStatus = { kind: "failed", endedAt: now, error, exitCode: probe.exitCode }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    a'. FIX A: the exit code is UNKNOWABLE in production (Bun.spawn is
  //        detached; the supervisor only has pid-liveness, not a wait status).
  //        So a boot crash arrives here with exitCode `undefined` but a crash
  //        signature in the log. Treat a found signature as a failure with the
  //        real cause — this is the fix for the "incomplete · exited without a
  //        result" mislabel that hid the `long context beta` 400 behind a
  //        generic message. Only fires when the worker produced nothing usable
  //        (the probe only reads the log in that case).
  if (probe.crash && !probe.result && !(probe.distilled && probe.distilled.trim().length > 0)) {
    const status: SubagentStatus = { kind: "failed", endedAt: now, error: probe.crash }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    b. CONTRACT CHECK (FIX 4): the worker declared `expectArtifacts` and some
  //       are missing/empty → INCOMPLETE, even if it wrote a sentinel or a final
  //       message. A claimed-but-absent deliverable is the strongest failure
  //       signal; never launder it into done.
  //
  //       FIX 5 (the A2/A3 data-loss bug): the contract miss is a HARD gate, but
  //       it must NOT throw away the synthesis the worker actually produced. If
  //       the worker wrote a result sentinel (or left a distillable final
  //       message), SALVAGE that text onto the `incomplete` status so the lead
  //       reads the findings via AgentResult instead of being forced to mine the
  //       worker's raw transcript. Sentinel text wins over distilled (same
  //       precedence as the done path). We still report `incomplete` and still
  //       cancel any linked todo — the deliverable genuinely wasn't met.
  const missing = probe.missingArtifacts
  if (missing && missing.length > 0) {
    const total = r.expectArtifacts?.length ?? missing.length
    const salvage = (probe.result?.short ?? probe.distilled)?.trim() || undefined
    const claimed = probe.result?.artifacts
    const status: SubagentStatus = {
      kind: "incomplete",
      endedAt: now,
      reason: `missing ${missing.length}/${total} required artifact(s): ${missing.join(", ")}`,
      tokens: s.progress.tokens,
      tools: s.progress.tools,
      ...(salvage ? { salvage } : {}),
      ...(claimed && claimed.length > 0 ? { artifacts: claimed } : {}),
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    c0. The worker SELF-REPORTED incompletion (ReportResult({incomplete:true})
  //        or a hand-written `INCOMPLETE:` sentinel). Honor it: route to
  //        `incomplete`, never launder an honest "I could not finish" into
  //        `done`. We still salvage the worker's summary (minus the marker
  //        prefix) so the lead reads the findings, and surface any claimed
  //        artifacts. A linked todo is canceled, not ticked green.
  if (probe.result?.incomplete) {
    const salvage = stripIncompleteMarker(probe.result.short)
    const claimed = probe.result.artifacts
    const status: SubagentStatus = {
      kind: "incomplete",
      endedAt: now,
      reason: "worker reported it could not finish",
      tokens: s.progress.tokens,
      tools: s.progress.tools,
      ...(salvage ? { salvage } : {}),
      ...(claimed && claimed.length > 0 ? { artifacts: claimed } : {}),
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    c. A parsed result sentinel → done. (FIX 3: when the sentinel's OWN
  //       declared `artifacts[]` are missing on disk, the shell probe has already
  //       prepended a "⚠ N/M artifacts missing" warning to `result.short`, so the
  //       lead is told without the reducer needing filesystem access.)
  if (probe.result) {
    const status: SubagentStatus = { kind: "done", endedAt: now, result: probe.result }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    d. Clean exit, no sentinel, BUT a distillable final message → done. The
  //       worker said something useful as its last turn; surface it rather than
  //       lose it. Marked `distilled` so the lead can tell it apart from a real
  //       structured sentinel.
  if (probe.distilled && probe.distilled.trim().length > 0) {
    const status: SubagentStatus = {
      kind: "done",
      endedAt: now,
      result: {
        short: probe.distilled.trim(),
        tokens: s.progress.tokens,
        tools: s.progress.tools,
        distilled: true,
      },
    }
    return { status, effects: terminalEffects(r, status, now) }
  }
  //    e. Clean exit but NO deliverable AND no final text → INCOMPLETE. The
  //       critical fix: a missing deliverable is NOT laundered into `done`.
  const status: SubagentStatus = {
    kind: "incomplete",
    endedAt: now,
    reason: "exited without a result sentinel or any final message",
    tokens: s.progress.tokens,
    tools: s.progress.tools,
  }
  return { status, effects: terminalEffects(r, status, now) }
}

/** Effects emitted on any active→terminal transition: a bus signal + a lead digest. */
function terminalEffects(r: SubagentRecord, next: SubagentStatus, _now: string): Effect[] {
  const withStatus: SubagentRecord = { ...r, status: next }
  const effects: Effect[] = [
    {
      type: "emit",
      channel: "subagent.didReport",
      payload: { id: r.id, sid: r.sid, status: next.kind },
    },
    {
      type: "emit",
      channel: "subagent.didExit",
      payload: { id: r.id, sid: r.sid, status: next.kind },
    },
    { type: "inject", text: completionDigest(withStatus), source: `subagent:${r.id}` },
  ]
  // Tasks-plugin linkage (decoupled, via the bus): if this worker owns a todo,
  // tick it green on a clean finish, or cancel it (with a reason) otherwise.
  // The `tasks` plugin subscribes to `subagent.taskUpdate` and applies it.
  if (r.taskId) {
    // Only a real `done` ticks the linked todo green. `incomplete` (no
    // deliverable) is a FAILURE signal, so it cancels the todo with the reason
    // rather than laundering it into success.
    const status = next.kind === "done" ? "done" : "canceled"
    const reason =
      next.kind === "failed"
        ? next.error
        : next.kind === "incomplete"
          ? `no deliverable: ${next.reason}`
          : next.kind === "stopped"
            ? next.reason
            : undefined
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

/**
 * Supervisor shell: the imperative wrapper that drives one {@link supervisorTick}.
 *
 * It gathers a probe per active worker (injected OS), runs the PURE tick,
 * persists the fleet when it changed, executes the resulting {@link Effect}s
 * (emit a bus event, inject a digest as a between-turns prompt, kill a
 * timed-out pid), and returns the live widget string. All side-effects are
 * injected so this is unit-testable without a real process or bus; the
 * heartbeat handler supplies the real implementations.
 *
 * @module sub-agents/lib/supervisor-shell
 */

import { buildPresenceRows, writeLeadPresence } from "./presence.ts"
import { type ProbeDeps, probeWorker } from "./spawn.ts"
import { type SubagentStore } from "./store.ts"
import { type Effect, supervisorTick, type WorkerProbe } from "./supervisor.ts"
import { isActive } from "./types.ts"
import { renderWidget } from "./widget.ts"

/** Injected collaborators for {@link runSupervisor}. */
export interface SupervisorDeps {
  readonly store: SubagentStore
  readonly probeDeps: ProbeDeps
  /** Emit on the plugin bus (the heartbeat passes `ctx.emit`). */
  readonly emit: (channel: string, payload?: unknown) => void
  /** Kill a pid (for budget-tripped workers). */
  readonly kill: (pid: number) => void
  /** Where child `.result.json` sentinels live. */
  readonly sessionsDir: string
  readonly leadSid: string
  readonly now: () => Date
  /** Live-area tick (drives the breathing spinner). */
  readonly tick: number
  readonly ansi: boolean
  readonly tokenBudget?: number
  readonly maxRows?: number
  /** When set, publish presence rows (lead + fleet) into this mesh directory. */
  readonly presenceDir?: string
  /** Lead process id, for the lead's presence row. */
  readonly leadPid?: number
  readonly leadModel?: string
  readonly leadCwd?: string
}

/**
 * Run one supervisor pass. Returns the widget string to paint, or `null` when
 * no worker is active (the live area collapses).
 */
export function runSupervisor(deps: SupervisorDeps): string | null {
  const records = deps.store.all()

  // Probe every active worker (skip terminal ones — nothing to observe).
  const probes = new Map<string, WorkerProbe>()
  for (const r of records) {
    if (!isActive(r.status)) continue
    if (r.status.kind === "running") {
      probes.set(
        r.id,
        probeWorker(
          {
            pid: r.status.pid,
            resultPath: `${deps.sessionsDir}/${r.sid}.result.json`,
            transcriptPath: `${deps.sessionsDir}/${r.sid}.jsonl`,
            logPath: `${deps.sessionsDir}/${r.sid}.log`,
            ...(r.expectArtifacts && r.expectArtifacts.length > 0
              ? { expectArtifacts: r.expectArtifacts }
              : {}),
          },
          deps.probeDeps,
        ),
      )
    }
    // queued: no pid yet; the tick leaves it unless a probe says otherwise.
  }

  const now = deps.now()
  const out = supervisorTick({
    records,
    probes,
    now: now.toISOString(),
    nowMs: now.getTime(),
  })

  if (out.changed) deps.store.replaceAll(out.records)
  for (const e of out.effects) runEffect(e, deps)

  // Publish presence (the agent-mesh): the lead reports itself + its fleet.
  // Best-effort — a write failure must never break the supervisor.
  if (deps.presenceDir) {
    try {
      const rows = buildPresenceRows(
        {
          sid: deps.leadSid,
          pid: deps.leadPid ?? 0,
          ...(deps.leadModel ? { model: deps.leadModel } : {}),
          ...(deps.leadCwd ? { cwd: deps.leadCwd } : {}),
        },
        out.records,
        now.toISOString(),
      )
      writeLeadPresence(deps.presenceDir, deps.leadSid, rows)
    } catch {
      // ignore
    }
  }

  return renderWidget(out.records, {
    ansi: deps.ansi,
    tick: deps.tick,
    nowMs: now.getTime(),
    leadSid: deps.leadSid,
    ...(deps.tokenBudget !== undefined ? { tokenBudget: deps.tokenBudget } : {}),
    ...(deps.maxRows !== undefined ? { maxRows: deps.maxRows } : {}),
  })
}

/** Execute one effect via the injected side-effects. */
function runEffect(e: Effect, deps: SupervisorDeps): void {
  switch (e.type) {
    case "emit":
      deps.emit(e.channel, e.payload)
      break
    case "inject":
      // Report-back to the lead rides the existing prompt.inject port: it
      // lands BETWEEN turns and survives resume.
      deps.emit("prompt.inject", { text: e.text, source: e.source })
      break
    case "stop":
      try {
        deps.kill(e.pid)
      } catch {
        // pid already gone — the next tick reaps it.
      }
      break
    default: {
      throw new Error(`unhandled effect: ${String(e satisfies never)}`)
    }
  }
}

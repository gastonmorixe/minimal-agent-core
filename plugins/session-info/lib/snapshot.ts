/**
 * `SessionInfo` snapshot shape + pure formatter.
 *
 * This module is the testable core of the SessionInfo tool: a plain data
 * shape ({@link SessionInfoSnapshot}) plus a total, side-effect-free
 * {@link formatSessionInfo} that turns it into the compact, model-facing
 * report. All the impure reads (process env, session-token globals, the
 * quota cache, the model registry) live in `./gather.ts` so this file stays
 * trivial to unit-test with hand-built snapshots.
 *
 * Design note: SessionInfo is the runtime-STATE counterpart to the ModelInfo
 * tool's static CAPABILITIES. ModelInfo answers "what can this model do";
 * SessionInfo answers "what is my situation right now" : how full the context
 * is, the live effort/reasoning settings, quota headroom, cumulative usage and
 * cost, the (possibly drifted) working directory, and how long the run has been
 * going. The two are deliberately separate tools because capabilities are
 * stable per model while this state changes every turn.
 *
 * @module plugins/session-info/lib/snapshot
 */

/** One rate-limit / usage window, normalized for display. */
export interface QuotaLine {
  /** Provider's window label, e.g. `"5h"`, `"7d"`. */
  label: string
  /** Utilization as a whole-number percent (0..100+). */
  utilizationPct: number
  /** Milliseconds until this window resets, when the provider reports it. */
  resetInMs?: number
}

/** Cumulative token usage for the session. */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
}

/**
 * Everything the SessionInfo tool reports, already resolved to plain values.
 * Optional fields are omitted (not zeroed) when the underlying source is cold
 * or unknown, so the formatter can degrade gracefully instead of printing
 * misleading zeros.
 */
export interface SessionInfoSnapshot {
  // Identity ---------------------------------------------------------------
  sessionId: string
  pid: number
  hostname: string
  agentVersion?: string
  /** Opt-in per-session agent display name (MINIMAL_AGENT_AGENT_NAME), when set. */
  agentName?: string

  // Live model + settings --------------------------------------------------
  modelId: string
  modelLabel: string
  providerId: string
  /** Selected effort level (provider pass-through), when set. */
  effort?: string
  /** `--fast` / MINIMAL_AGENT_FAST is on. */
  fast: boolean
  /** Reasoning/thinking traits the model supports, e.g. `["adaptive"]`. */
  reasoning: string[]

  // Context pressure -------------------------------------------------------
  /** Current context footprint (last turn's input side). The headline number. */
  contextSize: number
  /** Max input tokens for the model, when known. */
  contextWindow?: number
  /** API responses observed this session. */
  turns: number
  usage: UsageTotals
  /** Rough cumulative cost in USD, when registry pricing is available. */
  estCostUSD?: number

  // Provider quota ---------------------------------------------------------
  quota: QuotaLine[]

  // Session environment ----------------------------------------------------
  /** LIVE working directory (process.cwd()), which can differ from boot. */
  cwd: string
  /** Process start epoch ms, when resolvable (for uptime). */
  startedAtMs?: number
  /** Snapshot time, epoch ms. Passed in so the formatter stays pure. */
  nowMs: number
}

const n = (x: number): string => Math.round(x).toLocaleString("en-US")

/** "2h 13m", "45m 6s", "12s". Always at most two units; "0s" for non-positive. */
export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s"
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m) parts.push(`${m}m`)
  if (sec) parts.push(`${sec}s`)
  return parts.slice(0, 2).join(" ") || "0s"
}

function pct(frac: number): number {
  return Math.round(frac * 100)
}

/**
 * Render a snapshot into the compact multi-line report the tool returns.
 * Pure and total: every optional field degrades to a sensible shorter line.
 */
export function formatSessionInfo(s: SessionInfoSnapshot): string {
  const lines: string[] = []

  const idTail = [`pid ${s.pid}`, s.hostname, s.agentVersion ? `agent v${s.agentVersion}` : null]
    .filter(Boolean)
    .join(" · ")
  lines.push(`Session: ${s.sessionId} · ${idTail}`)

  if (s.agentName) lines.push(`Name: ${s.agentName}`)

  const modelTail = [
    s.effort ? `effort ${s.effort}` : null,
    s.fast ? "fast" : null,
    s.reasoning.length ? `reasoning ${s.reasoning.join("/")}` : null,
  ].filter(Boolean)
  lines.push(
    `Model: ${s.modelLabel} (${s.modelId}) · ${s.providerId}${
      modelTail.length ? ` · ${modelTail.join(" · ")}` : ""
    }`,
  )

  if (s.contextWindow && s.contextWindow > 0) {
    const frac = s.contextSize / s.contextWindow
    const free = Math.max(0, s.contextWindow - s.contextSize)
    lines.push(
      `Context: ${n(s.contextSize)} / ${n(s.contextWindow)} tokens (${pct(frac)}% full · ${n(
        free,
      )} free) · ${n(s.turns)} turns`,
    )
  } else {
    lines.push(`Context: ${n(s.contextSize)} tokens in context · ${n(s.turns)} turns`)
  }

  if (s.quota.length) {
    const q = s.quota
      .map((w) => {
        const reset =
          w.resetInMs !== undefined ? ` (resets in ${humanizeDuration(w.resetInMs)})` : ""
        return `${w.label} ${w.utilizationPct}%${reset}`
      })
      .join(" · ")
    lines.push(`Quota: ${q}`)
  }

  const cost = s.estCostUSD !== undefined ? ` · ~$${s.estCostUSD.toFixed(2)}` : ""
  lines.push(
    `Usage so far: in ${n(s.usage.input)}, out ${n(s.usage.output)}, cache-read ${n(
      s.usage.cacheRead,
    )}, cache-write ${n(s.usage.cacheCreate)}${cost}`,
  )

  lines.push(`Working dir: ${s.cwd}`)

  if (s.startedAtMs !== undefined) {
    const uptime = humanizeDuration(s.nowMs - s.startedAtMs)
    lines.push(`Uptime: ${uptime} (started ${new Date(s.startedAtMs).toLocaleString()})`)
  }

  return lines.join("\n")
}

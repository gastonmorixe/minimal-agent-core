/**
 * Impure data collection for the SessionInfo tool.
 *
 * Reads live runtime state from the host's stable, read-only APIs : the same
 * sources the `quota-status` footer uses : and resolves them into a plain
 * {@link SessionInfoSnapshot} that `./snapshot.ts` can format without touching
 * any global. Kept separate from the formatter so the pure rendering stays
 * unit-testable.
 *
 * Decoupling choices (so this plugin commits independently of the in-flight
 * plugin-context seams):
 *  - Identity (session id, pid, version) comes from `process` + the
 *    `MINIMAL_AGENT_*` env the host exports at boot. The session id and pid do
 *    not change mid-session, so this is exact.
 *  - The current model is read OPPORTUNISTICALLY from the host's model-info
 *    seam when present (correct across mid-session switches) via a local
 *    structural type, so this file does not compile-depend on that seam's
 *    types. When the seam is absent it falls back to the boot model env + the
 *    model registry.
 *  - Quota goes through `resolveProviderSessionInfo`, which is cache-only and
 *    non-blocking, so the tool never stalls on the network.
 *  - "Started" is THIS run's process start (`process.uptime()`) : instant, no
 *    `ps`/file probe. A resume counts as a new run, the honest answer for "how
 *    long have I been going".
 *
 * @module plugins/session-info/lib/gather
 */

import { hostname } from "node:os"

import type { TUIContext } from "@minimal-agent/plugin-api/types/plugin"

import { resolveProviderSessionInfo } from "../../../src/llm/provider-session.ts"
import { getSessionTokens } from "../../../src/session-tokens.ts"

import type { QuotaLine, SessionInfoSnapshot } from "./snapshot.ts"

/**
 * The subset of the host's live model snapshot this tool reads. A structural
 * subset of the model-info seam's return type, declared locally so this plugin
 * does not compile-depend on that (currently in-flight) seam.
 */
interface LiveModelInfo {
  modelId: string
  displayName: string
  providerId: string
  contextWindow: number
  thinking: { adaptive: boolean; extended: boolean; interleaved: boolean }
  pricing: {
    inputPerMTok: number
    outputPerMTok: number
    cacheWritePerMTok: number
    cacheReadPerMTok: number
  }
}

interface ModelBits {
  modelId: string
  modelLabel: string
  providerId: string
  contextWindow?: number
  reasoning: string[]
  pricing?: { in: number; out: number; cacheWrite: number; cacheRead: number }
}

function reasoningOf(t: { adaptive: boolean; extended: boolean; interleaved: boolean }): string[] {
  return [
    t.adaptive && "adaptive",
    t.extended && "extended",
    t.interleaved && "interleaved",
  ].filter(Boolean) as string[]
}

/**
 * Fast-mode truth for the snapshot. The host mirrors the RESOLVED fast
 * state (CLI `--fast` OR env) into `MINIMAL_AGENT_FAST` at boot, so the
 * env var is authoritative for "was fast requested". Cross-check the
 * model's `speedFast` capability so the footer never claims a fast tier
 * the model doesn't have (the client gates the wire the same way):
 * requested + unsupported renders as not-fast, matching what is sent.
 *
 * The capability lookup goes through the host's `models:read` capability
 * (`ctx.host.models`), not a `src/` registry import. When the capability is
 * absent or the model is unregistered, we report the request as-is (the
 * server decides) — the same "honest fallback" as before.
 */
function resolveFastState(ctx: TUIContext, modelId: string): boolean {
  if (process.env.MINIMAL_AGENT_FAST !== "1") return false
  try {
    const e = ctx.host?.models?.resolve(modelId)
    // Unregistered model OR no models capability: report the request as-is.
    return e ? e.capabilities.speedFast : true
  } catch {
    // resolve() throws on an unregistered id: report the request as-is.
    return true
  }
}

/**
 * Resolve the current model's display/pricing/reasoning. Prefers the host's
 * live model-info seam (read defensively, no type coupling); falls back to the
 * boot model env + the registry.
 */
function resolveModelBits(ctx: TUIContext): ModelBits {
  const seam = (ctx as { queryModelInfo?: () => LiveModelInfo | undefined }).queryModelInfo
  const info = seam?.()
  const _providerId = info?.providerId ?? process.env.MINIMAL_AGENT_PROVIDER
  if (info) {
    return {
      modelId: info.modelId,
      modelLabel: info.displayName,
      providerId: info.providerId,
      contextWindow: info.contextWindow,
      reasoning: reasoningOf(info.thinking),
      pricing: {
        in: info.pricing.inputPerMTok,
        out: info.pricing.outputPerMTok,
        cacheWrite: info.pricing.cacheWritePerMTok,
        cacheRead: info.pricing.cacheReadPerMTok,
      },
    }
  }

  const modelId = process.env.MINIMAL_AGENT_MODEL || "unknown"
  try {
    const e = ctx.host?.models?.resolve(modelId)
    if (!e) return { modelId, modelLabel: modelId, providerId: "unknown", reasoning: [] }
    return {
      modelId,
      modelLabel: e.displayName,
      providerId: e.providerId,
      contextWindow: e.capabilities.contextWindow,
      reasoning: reasoningOf(e.capabilities.thinking),
      pricing: {
        in: e.pricing.inputUSD,
        out: e.pricing.outputUSD,
        cacheWrite: e.pricing.cacheWriteUSD,
        cacheRead: e.pricing.cacheReadUSD,
      },
    }
  } catch {
    return { modelId, modelLabel: modelId, providerId: "unknown", reasoning: [] }
  }
}

/** Collect a full live snapshot of the current session/context state. */
export async function gatherSessionInfo(ctx: TUIContext): Promise<SessionInfoSnapshot> {
  const nowMs = Date.now()
  const bits = resolveModelBits(ctx)

  const tok = getSessionTokens()
  const usage = {
    input: tok.input,
    output: tok.output,
    cacheRead: tok.cacheRead,
    cacheCreate: tok.cacheCreate,
  }
  const estCostUSD = bits.pricing
    ? (usage.input * bits.pricing.in +
        usage.output * bits.pricing.out +
        usage.cacheCreate * bits.pricing.cacheWrite +
        usage.cacheRead * bits.pricing.cacheRead) /
      1_000_000
    : undefined

  // Quota: cache-only, non-blocking. Also a backstop for contextWindow.
  let quota: QuotaLine[] = []
  let contextWindow = bits.contextWindow
  try {
    const sess = await resolveProviderSessionInfo(bits.modelId, { providerId: bits.providerId })
    if (!contextWindow && sess.contextWindow) contextWindow = sess.contextWindow
    quota = (sess.quota?.windows ?? []).map((w) => ({
      label: w.id,
      utilizationPct: Math.round(w.utilization * 100),
      resetInMs: w.resetAtMs !== undefined ? Math.max(0, w.resetAtMs - nowMs) : undefined,
    }))
  } catch {
    // Provider has no session metadata, or the cache is cold : quota stays [].
  }

  return {
    sessionId: process.env.MINIMAL_AGENT_SESSION_ID || "unknown",
    pid: process.pid,
    hostname: hostname(),
    agentVersion: process.env.MINIMAL_AGENT_VERSION || undefined,
    modelId: bits.modelId,
    modelLabel: bits.modelLabel,
    providerId: bits.providerId,
    effort: process.env.MINIMAL_AGENT_EFFORT || undefined,
    fast: resolveFastState(ctx, bits.modelId),
    reasoning: bits.reasoning,
    contextSize: tok.contextSize,
    contextWindow,
    turns: tok.turns,
    usage,
    estCostUSD,
    quota,
    cwd: process.cwd(),
    startedAtMs: nowMs - Math.round(process.uptime() * 1000),
    nowMs,
  }
}

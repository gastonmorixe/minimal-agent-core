/**
 * Anthropic session metadata (quota windows + context window + label).
 *
 * Implements the provider-neutral `ProviderPlugin.fetchSessionInfo` seam. The
 * status bar / startup call the CORE resolver (`src/llm/provider-session.ts`),
 * which routes here for Anthropic models — so the quota footer no longer
 * imports Anthropic internals directly.
 *
 * Data path (mirrors the old `quota-status` handler, now owned by the provider):
 *   1. Cache-first: the in-process `quota-cache` is written by every successful
 *      Anthropic response (chat + this probe), so within a freshness window we
 *      return it with NO network call.
 *   2. Cold/stale: a bounded `checkQuota` probe through the SHARED, resilient
 *      network client (so the TTFB guard + abort escalation apply, and a stuck
 *      probe is torn down by the live-area scheduler's per-slot timeout via
 *      `ctx.signal`).
 *
 * The Anthropic `anthropic-ratelimit-unified-*` header shape is parsed HERE
 * (the provider owns its wire format); the renderer only ever sees neutral
 * {@link QuotaWindow}s.
 *
 * @module llm/providers/anthropic/session-info
 */

import { getAuth } from "../../src/auth.ts"
import { checkQuota } from "../../src/client.ts"
import { modelShortLabel } from "../../src/llm/model-label.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"
import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "../../src/llm/provider-plugin.ts"
import type { NetworkClient } from "../../src/network/index.ts"
import { getLastRateLimits } from "../../src/quota-cache.ts"

/** Trust a cached snapshot newer than this without re-probing. */
const FRESHNESS_MS = 60_000

/**
 * Parse Anthropic's `anthropic-ratelimit-unified-<window>-<field>` headers into
 * neutral {@link QuotaWindow}s. Drops the synthetic `fallback`/`representative`
 * entries and `overage` (a power-user-only readout). Sorted 5h, 7d, then the
 * rest. Windows without a utilization value are dropped.
 */
export function parseAnthropicQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
  const wins = new Map<string, { id: string; utilization?: number; resetAtMs?: number }>()
  for (const [k, v] of rl) {
    const m = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (!m) continue
    const name = m[1]!
    const field = m[2]!
    if (name === "fallback" || name === "representative" || name === "overage") continue
    if (!wins.has(name)) wins.set(name, { id: name })
    const w = wins.get(name)!
    if (field === "utilization") w.utilization = Number(v)
    else if (field === "reset") w.resetAtMs = Number(v) * 1000
  }
  const order = (n: string) => (n === "5h" ? 0 : n === "7d" ? 1 : 2)
  return [...wins.values()]
    .filter((w) => w.utilization != null)
    .sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))
    .map((w) => ({ id: w.id, utilization: w.utilization as number, resetAtMs: w.resetAtMs }))
}

/**
 * Parse Anthropic's `anthropic-ratelimit-unified-overage-status` header into
 * the neutral overage DTO. Values seen: `"off"` → `{ active: false }`,
 * `"allowed"` → `{ active: true }`. Returns `undefined` when the header is
 * absent (no overage concept reported this tick). Unlike the quota windows,
 * overage carries no utilization, so it never becomes a {@link QuotaWindow}.
 */
export function parseAnthropicOverage(
  rl: ReadonlyMap<string, string>,
): { active: boolean } | undefined {
  const ov = rl.get("anthropic-ratelimit-unified-overage-status")
  if (ov == null) return undefined
  return { active: ov === "allowed" }
}

function contextWindowFor(modelId: string): number | undefined {
  try {
    return resolveModel(modelId).capabilities.contextWindow
  } catch {
    return undefined
  }
}

/**
 * Resolve Anthropic session metadata. Returns `null` only if even the context
 * window is unknowable; otherwise returns at least context + label so the
 * footer keeps the context bar when quota can't be fetched.
 */
export async function fetchAnthropicSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  const contextWindow = contextWindowFor(ctx.modelId)
  const modelLabel = modelShortLabel(ctx.modelId)

  // 1) Cache-first.
  let rl: ReadonlyMap<string, string> | null = null
  const cached = getLastRateLimits()
  if (cached && Date.now() - cached.at < FRESHNESS_MS) {
    rl = cached.rateLimits
  } else {
    // 2) Cold/stale: bounded probe through the shared transport. `getAuth`
    //    failure (no creds) just means no quota this tick — the footer falls
    //    back to context-only. `checkQuota` already swallows its own errors
    //    and returns `{ ok: false }`, and honors `ctx.signal`.
    let auth: Awaited<ReturnType<typeof getAuth>> | null = null
    try {
      auth = await getAuth()
    } catch {
      auth = null
    }
    if (auth) {
      const res = await checkQuota(auth, ctx.networkClient as NetworkClient | undefined, ctx.signal)
      if (res.ok) rl = res.rateLimits
    }
  }

  const windows = rl ? parseAnthropicQuotaWindows(rl) : []
  const overage = rl ? parseAnthropicOverage(rl) : undefined
  // Surface a quota snapshot when there's anything to report — windows OR an
  // overage readout (overage can be present even when no window crossed a
  // threshold). Both absent ⇒ no quota concept this tick (context-only footer).
  const quota = windows.length > 0 || overage ? { windows, overage } : undefined
  return {
    contextWindow,
    modelLabel,
    quota,
  }
}

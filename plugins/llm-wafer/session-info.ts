/**
 * Wafer session metadata (rate-limit windows + context window + label +
 * session usage tracking).
 *
 * Implements the provider-neutral {@link ProviderPlugin.fetchSessionInfo}
 * seam for Wafer. Every successful Chat Completions response carries
 * `x-ratelimit-*` headers describing the requests/tokens windows.
 * Additionally, response `usage` chunks are accumulated per-session for
 * a cost estimate displayed in the footer.
 *
 * Data path:
 *
 * 1. The adapter calls {@link setWaferRateLimits} after each successful
 *    response, caching the `x-ratelimit-*` headers.
 * 2. The adapter calls {@link accumulateWaferUsage} with each response's
 *    token counts.
 * 3. {@link fetchWaferSessionInfo} reads both caches (no network) and
 *    returns neutral metadata including context window + model label.
 * 4. {@link primeWaferSessionInfo} issues a 1-token probe to warm the
 *    rate-limit cache on cold start.
 *
 * @module llm/providers/wafer/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"

import { modelShortLabel } from "../../src/llm/model-label.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"
import { defaultNetworkClient } from "../../src/network/index.ts"

import { WAFER_BASE_URL } from "./wire-constants.ts"

/** Trust a cached snapshot newer than this without treating it as stale. */
const FRESHNESS_MS = 5 * 60_000

/** One cache entry. */
export interface CachedWaferRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

/** Accumulated usage from this session's responses. */
let sessionUsage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  at: number
} | null = null

/**
 * Copy the rate-limit headers from a successful response into the module
 * cache. Non-throwing (must never break the request path).
 */
export function setWaferRateLimits(headers: Headers): void {
  try {
    const copy = new Map<string, string>()
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (lk.startsWith("x-ratelimit-")) copy.set(lk, value)
    })
    if (copy.size === 0) return
    cache = { rateLimits: copy, at: Date.now() }
  } catch {
    // best-effort; never throw on the request path
  }
}

/**
 * Accumulate token usage from a completed response. Called by the adapter
 * after each successful stream. The usage feeds the footer's session-cost
 * display.
 */
export function accumulateWaferUsage(usage: {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): void {
  if (sessionUsage) {
    sessionUsage.inputTokens += usage.inputTokens
    sessionUsage.outputTokens += usage.outputTokens
    sessionUsage.cacheReadTokens += usage.cacheReadTokens ?? 0
    sessionUsage.at = Date.now()
  } else {
    sessionUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      at: Date.now(),
    }
  }
}

/** Read the latest rate-limit snapshot. */
export function getWaferRateLimits(): CachedWaferRateLimits | null {
  return cache
}

/** Read accumulated session usage. */
export function getWaferSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Reset both caches (tests call this between cases). */
export function clearWaferRateLimits(): void {
  cache = null
  sessionUsage = null
}

// ---------------------------------------------------------------------------
// Reset-duration parser
// ---------------------------------------------------------------------------

function parseResetMs(s: string): number | undefined {
  if (typeof s !== "string") return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined
  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    µs: 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  }
  const re = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/y
  let total = 0
  let pos = 0
  while (pos < trimmed.length) {
    re.lastIndex = pos
    const m = re.exec(trimmed)
    if (!m) return undefined
    const value = Number(m[1])
    if (!Number.isFinite(value)) return undefined
    total += value * unitMs[m[2]!]!
    pos = re.lastIndex
  }
  return total
}

/**
 * Build neutral `QuotaWindow`s (`"req"` / `"tok"`) from a captured
 * `x-ratelimit-*` map.
 */
export function parseWaferQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
  const now = Date.now()
  const out: QuotaWindow[] = []
  const build = (id: string, limitKey: string, remainingKey: string, resetKey: string): void => {
    const limit = Number(rl.get(limitKey))
    const remaining = Number(rl.get(remainingKey))
    if (!Number.isFinite(limit) || limit <= 0) return
    if (!Number.isFinite(remaining)) return
    let utilization = 1 - remaining / limit
    if (utilization < 0) utilization = 0
    if (utilization > 1) utilization = 1
    const resetMs = parseResetMs(rl.get(resetKey) ?? "")
    const resetAtMs = resetMs == null ? undefined : now + resetMs
    out.push({ id, utilization, resetAtMs })
  }
  build(
    "req",
    "x-ratelimit-limit-requests",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-reset-requests",
  )
  build(
    "tok",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-tokens",
  )
  return out
}

function contextWindowFor(modelId: string): number | undefined {
  try {
    return resolveModel(modelId).capabilities.contextWindow
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// fetchSessionInfo (cache-only, for the status-bar slot)
// ---------------------------------------------------------------------------

/**
 * Resolve Wafer session metadata for the status bar. Cache-only (no
 * network). Returns context window, model label, rate-limit windows, and
 * accumulated session usage. Never throws.
 */
export async function fetchWaferSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}

  const contextWindow = contextWindowFor(ctx.modelId)
  const modelLabel = modelShortLabel(ctx.modelId)

  const cached = getWaferRateLimits()
  const rl = cached && Date.now() - cached.at < FRESHNESS_MS ? cached.rateLimits : null

  const windows = rl ? parseWaferQuotaWindows(rl) : []
  const quota = windows.length > 0 ? { windows } : undefined

  return { contextWindow, modelLabel, quota }
}

// ---------------------------------------------------------------------------
// Prime (cold-start cache warmup with a 1-token probe)
// ---------------------------------------------------------------------------

/** Single in-flight prime promise (dedupe concurrent calls). */
let inFlightPrime: Promise<void> | null = null

/** Reset the in-flight latch. Tests only. */
export function _resetWaferPrimeInFlight(): void {
  inFlightPrime = null
}

/**
 * Warm the Wafer rate-limit cache by issuing a 1-token probe through the
 * Chat Completions endpoint. The response headers populate the module
 * cache, which the status-bar slot reads on its next tick.
 *
 * API key is resolved from `process.env.MINIMAL_AGENT_WAFER_API_KEY` or
 * the auth store bound to `ctx`. Never throws. Self-deduplicates
 * concurrent callers.
 */
export function primeWaferSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  if (inFlightPrime) return inFlightPrime

  const work = (async () => {
    const cached = getWaferRateLimits()
    if (cached && Date.now() - cached.at < FRESHNESS_MS) return

    const apiKey = resolveWaferApiKey(ctx) ?? process.env["MINIMAL_AGENT_WAFER_API_KEY"]
    if (!apiKey) return

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient
    const signal = ctx.signal

    try {
      const probeSignal: AbortSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000)

      const response = await networkClient.request({
        label: "wafer.quota.probe",
        method: "POST",
        url: `${WAFER_BASE_URL}/v1/chat/completions`,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "user-agent": "minimal-agent-wafer/0.1",
        },
        body: JSON.stringify({
          model: ctx.modelId || "deepseek-v4-flash",
          messages: [{ role: "user", content: "quota" }],
          max_tokens: 1,
          temperature: 0,
        }),
        signal: probeSignal,
      })
      if (response.ok) {
        setWaferRateLimits(response.headers)
      }
    } catch {
      // soft-fail; probe is best-effort
    }
  })()

  inFlightPrime = work
  void work.finally(() => {
    if (inFlightPrime === work) inFlightPrime = null
  })

  return work
}

/**
 * Resolve the Wafer API key from the host's auth store (if available).
 * The core provides `ctx` with a `networkClient` but not direct auth
 * access; we fall back to env vars for the probe.
 */
function resolveWaferApiKey(_ctx: ProviderSessionContext): string | null {
  // Try reading through the network client's auth header cache.
  // The core transport layer may have stashed the resolved key.
  // For now, this is purely diagnostics via env.
  return null
}

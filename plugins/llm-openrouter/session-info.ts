/**
 * OpenRouter session metadata (rate-limit windows + context window + label).
 *
 * Implements `ProviderPlugin.fetchSessionInfo` for OpenRouter, mirroring the
 * OpenAI provider. OpenRouter speaks the OpenAI Chat Completions wire format and
 * passes through upstream `x-ratelimit-*` headers, so the data path is the same
 * cache-only shape: the adapter stashes the headers from each successful
 * response; {@link fetchOpenRouterSessionInfo} reads that module-local cache (no
 * network probe) and emits neutral {@link QuotaWindow}s. The cache is LOCAL to
 * this plugin (not the global Anthropic `quota-cache.ts`, not OpenAI's).
 *
 * The parser is intentionally duplicated from the OpenAI plugin rather than
 * shared — a shared `openai-chat-completions` codec is a separate, deferred unit
 * (YAGNI until a 3rd OpenAI-compatible vendor). Keeping it local keeps this
 * change self-contained.
 *
 * @module llm/providers/openrouter/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "../../src/llm/provider-plugin.ts"

/** Trust a cached snapshot newer than this without treating it as stale. */
const FRESHNESS_MS = 5 * 60_000

/** One cache entry: the captured `x-ratelimit-*` map + the capture time. */
export interface CachedOpenRouterRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

/**
 * Copy the `x-ratelimit-*` entries from a successful response's headers into the
 * module cache. Non-throwing (must never break the request path). Empty captures
 * (e.g. the fake test transport) are ignored so a no-quota response doesn't blank
 * the cache.
 */
export function setOpenRouterRateLimits(headers: Headers): void {
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

/** Read the latest snapshot, or `null` if nothing has been cached this session. */
export function getOpenRouterRateLimits(): CachedOpenRouterRateLimits | null {
  return cache
}

/** Reset the cache. Tests call this between cases so fixtures don't leak. */
export function clearOpenRouterRateLimits(): void {
  cache = null
}

/**
 * Parse an OpenAI/OpenRouter reset duration string into milliseconds (Go-style:
 * `"1s"`, `"6m0s"`, `"13ms"`, `"0s"`, fractional `"1.5s"`). Returns `undefined`
 * for empty/garbage input.
 */
export function parseOpenRouterResetMs(s: string): number | undefined {
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
 * Build neutral {@link QuotaWindow}s (`"req"` / `"tok"`) from a captured
 * `x-ratelimit-*` map. `utilization = clamp(1 - remaining/limit, 0, 1)`; a window
 * is skipped when its limit/remaining are absent or `limit <= 0`. Exported for
 * unit testing.
 */
export function parseOpenRouterQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
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
    const resetMs = parseOpenRouterResetMs(rl.get(resetKey) ?? "")
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

/**
 * Resolve OpenRouter session metadata for the status bar. Cache-only (no network
 * probe); when a fresh snapshot yields windows, returns `{ quota: { windows } }`
 * and the core backfills context window + label from the registry. Otherwise
 * `{}` (context-only). Never throws. Honors `ctx.signal` trivially.
 */
export async function fetchOpenRouterSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}
  const cached = getOpenRouterRateLimits()
  if (!cached || Date.now() - cached.at >= FRESHNESS_MS) return {}
  const windows = parseOpenRouterQuotaWindows(cached.rateLimits)
  if (windows.length === 0) return {}
  return { quota: { windows } }
}

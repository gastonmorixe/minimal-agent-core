/**
 * OpenAI session metadata (rate-limit windows + context window + label).
 *
 * Implements the provider-neutral `ProviderPlugin.fetchSessionInfo` seam for
 * OpenAI. Unlike Anthropic — which exposes a dedicated `checkQuota` probe — the
 * OpenAI API has NO cheap separate quota endpoint. Instead, every successful
 * response carries `x-ratelimit-*` headers describing the requests/tokens
 * windows. So the data path is cache-only:
 *
 *   1. The adapter (`adapter.ts`) calls {@link setOpenAIRateLimits} after each
 *      successful `networkClient.request(...)`, copying the `x-ratelimit-*`
 *      entries into a module-level cache stamped with `Date.now()`.
 *   2. {@link fetchOpenAISessionInfo} reads that cache (no network). Within a
 *      freshness window it returns neutral {@link QuotaWindow}s; otherwise it
 *      returns `{}` and the core backfills context window + label from the
 *      registry, so the footer keeps its context bar.
 *
 * This mirrors the SPIRIT of the global `src/quota-cache.ts` (Anthropic's) but
 * is LOCAL to this plugin — the two providers don't share a cache.
 *
 * The OpenAI header shape is parsed HERE (the provider owns its wire format);
 * the renderer only ever sees neutral {@link QuotaWindow}s.
 *
 * @module llm/providers/openai/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "../../src/llm/provider-plugin.ts"

/** Trust a cached snapshot newer than this without treating it as stale. */
const FRESHNESS_MS = 5 * 60_000

/** One cache entry: the captured `x-ratelimit-*` map + the capture time. */
export interface CachedOpenAIRateLimits {
  rateLimits: ReadonlyMap<string, string>
  at: number
}

let cache: { rateLimits: Map<string, string>; at: number } | null = null

/**
 * Copy the `x-ratelimit-*` entries from a successful response's headers into
 * the module cache, stamped with `Date.now()`. Non-throwing: a parse failure
 * on the hot request path must never break the stream. Headers with no
 * `x-ratelimit-*` entries (e.g. the fake test transport) are ignored so the
 * cache isn't blanked by traffic that carries no quota signal.
 */
export function setOpenAIRateLimits(headers: Headers): void {
  try {
    const copy = new Map<string, string>()
    headers.forEach((value, key) => {
      const lk = key.toLowerCase()
      if (lk.startsWith("x-ratelimit-")) copy.set(lk, value)
    })
    if (copy.size === 0) return
    cache = { rateLimits: copy, at: Date.now() }
  } catch {
    // Best-effort capture; never throw on the request path.
  }
}

/** Read the latest snapshot, or `null` if nothing has been cached this session. */
export function getOpenAIRateLimits(): CachedOpenAIRateLimits | null {
  return cache
}

/** Reset the cache. Tests call this between cases so fixtures don't leak. */
export function clearOpenAIRateLimits(): void {
  cache = null
}

/**
 * Parse an OpenAI reset duration string into milliseconds. OpenAI reports the
 * time UNTIL the window resets as a Go-style duration (e.g. `"1s"`, `"6m0s"`,
 * `"13ms"`, `"0s"`, `"1h2m3s"`, fractional `"1.5s"`), NOT an epoch. Returns
 * `undefined` for empty/garbage input. Supported units: `h`, `m`, `s`, `ms`,
 * `us`/`µs`, `ns`.
 */
export function parseOpenAIResetMs(s: string): number | undefined {
  if (typeof s !== "string") return undefined
  const trimmed = s.trim()
  if (!trimmed) return undefined

  const unitMs: Record<string, number> = {
    ns: 1e-6,
    us: 1e-3,
    "µs": 1e-3,
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  }
  // Sticky regex: each token must start exactly where the previous ended, so a
  // gap (garbage) leaves `pos` short of the end and we bail. `ms`/`us`/`ns`
  // precede the single-letter units in the alternation so `13ms` isn't read as
  // `13m` + stray `s`.
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
 * Build neutral {@link QuotaWindow}s from a captured `x-ratelimit-*` map. Up to
 * two windows:
 *
 *   - `"req"` from `x-ratelimit-{limit,remaining,reset}-requests`
 *   - `"tok"` from `x-ratelimit-{limit,remaining,reset}-tokens`
 *
 * `utilization = clamp(1 - remaining/limit, 0, 1)`. A window is skipped when its
 * limit/remaining headers are absent or `limit <= 0`. `resetAtMs` is
 * `Date.now() + parseOpenAIResetMs(reset)` when the reset header parses, else
 * omitted. Exported for unit testing.
 */
export function parseOpenAIQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
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
    const resetMs = parseOpenAIResetMs(rl.get(resetKey) ?? "")
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
 * Resolve OpenAI session metadata for the status bar. Reads the module cache
 * written by real traffic (no network: OpenAI has no cheap probe). When a fresh
 * snapshot yields windows, returns `{ quota: { windows } }` and lets the core
 * backfill context window + model label from the registry. Otherwise returns
 * `{}` (context-only). Never throws. Honors `ctx.signal` trivially — there is no
 * I/O to cancel.
 */
export async function fetchOpenAISessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}
  const cached = getOpenAIRateLimits()
  if (!cached || Date.now() - cached.at >= FRESHNESS_MS) return {}
  const windows = parseOpenAIQuotaWindows(cached.rateLimits)
  if (windows.length === 0) return {}
  return { quota: { windows } }
}

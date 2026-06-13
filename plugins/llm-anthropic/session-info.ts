/**
 * Anthropic session metadata (quota windows + context window + label).
 *
 * Implements TWO seams on `ProviderPlugin`:
 *
 *   - {@link fetchAnthropicSessionInfo} → `ProviderPlugin.fetchSessionInfo`.
 *     **Cache-only.** Read the in-process `quota-cache` (populated by every
 *     successful Anthropic response and by {@link primeAnthropicSessionInfo})
 *     and return neutral metadata. No network I/O, no `await getAuth()`,
 *     no blocking. The status-bar slot calls this on every tick + every
 *     `quota.headersReceived` event, so it MUST stay synchronous-ish to
 *     fit inside the scheduler's per-slot `timeoutMs`.
 *
 *   - {@link primeAnthropicSessionInfo} → `ProviderPlugin.primeSessionInfo`.
 *     **Cold-start cache warmup.** A bounded probe through the canonical
 *     plugin-owned `probeQuota`. Called fire-and-forget by the agent boot
 *     for the selected provider so the slot's first tick already finds a
 *     fresh cache. Self-deduplicates: a second prime while the first is in
 *     flight joins the same promise (no double probe).
 *
 * The split matters because, before, `fetchSessionInfo` itself ran the cold
 * probe inline. The slot's 8s `timeoutMs` (designed to detect *stuck*
 * handlers, not to bound network) repeatedly tripped on a cold-start
 * checkQuota POST and the footer never populated until the user typed their
 * first prompt — at which point the chat path's broadcast filled the cache
 * via `quota.headersReceived` and the slot caught up. Splitting prime from
 * fetch matches OpenAI / OpenRouter (already cache-only) and keeps the slot
 * non-blocking.
 *
 * The Anthropic `anthropic-ratelimit-unified-*` header shape is parsed HERE
 * (the provider owns its wire format); the renderer only ever sees neutral
 * {@link QuotaWindow}s.
 *
 * @module llm/providers/anthropic/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
  QuotaWindow,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"

import { getAuth } from "../../src/auth.ts"
import { modelShortLabel } from "../../src/llm/model-label.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"
import { getLastRateLimits } from "../../src/quota-cache.ts"

import { probeQuota } from "./quota-probe.ts"

/** Trust a cached snapshot newer than this without treating it as stale. */
const FRESHNESS_MS = 60_000

/**
 * Parse Anthropic's `anthropic-ratelimit-unified-<window>-<field>` headers into
 * neutral {@link QuotaWindow}s. Drops the synthetic `fallback`/`representative`
 * entries and `overage` (a power-user-only readout). The windowless AGGREGATE
 * form (`anthropic-ratelimit-unified-<field>`) becomes `id:"overall"` so the
 * startup banner can show the account-level line the raw headers used to feed.
 * Sorted 5h, 7d, other named windows, `overall` last. Windows without a
 * utilization value are dropped.
 */
export function parseAnthropicQuotaWindows(rl: ReadonlyMap<string, string>): QuotaWindow[] {
  const wins = new Map<string, { id: string; utilization?: number; resetAtMs?: number }>()
  const FIELDS = new Set(["utilization", "reset", "status", "remaining", "limit"])
  for (const [k, v] of rl) {
    let name: string
    let field: string
    const mw = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (mw && !FIELDS.has(mw[1]!)) {
      name = mw[1]!
      field = mw[2]!
    } else {
      // Aggregate (windowless) form: anthropic-ratelimit-unified-<field>.
      const ma = k.match(/^anthropic-ratelimit-unified-(\w+)$/)
      if (!ma || !FIELDS.has(ma[1]!)) continue
      name = "overall"
      field = ma[1]!
    }
    if (name === "fallback" || name === "representative" || name === "overage") continue
    if (!wins.has(name)) wins.set(name, { id: name })
    const w = wins.get(name)!
    if (field === "utilization") w.utilization = Number(v)
    else if (field === "reset") w.resetAtMs = Number(v) * 1000
  }
  const order = (n: string) => (n === "5h" ? 0 : n === "7d" ? 1 : n === "overall" ? 3 : 2)
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
 * Read Anthropic session metadata from the in-process cache. **Cache-only:**
 * no network, no `await getAuth()`, no blocking. Returns at least context +
 * label so the footer keeps the model identity even when the cache is cold;
 * `quota` is omitted on a cold/stale cache (the footer degrades to a
 * context-only view and refreshes on the next `quota.headersReceived`
 * broadcast). Cold-start cache population is {@link primeAnthropicSessionInfo}.
 */
export async function fetchAnthropicSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  const contextWindow = contextWindowFor(ctx.modelId)
  const modelLabel = modelShortLabel(ctx.modelId)

  const cached = getLastRateLimits()
  const rl = cached && Date.now() - cached.at < FRESHNESS_MS ? cached.rateLimits : null

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

// ---------------------------------------------------------------------------
// Prime (cold-start cache warmup)
// ---------------------------------------------------------------------------

/**
 * Single in-flight prime promise. A concurrent {@link primeAnthropicSessionInfo}
 * call joins this rather than starting a second probe. Reset to `null` once the
 * probe settles, so a later cold tick (e.g. after the agent has been idle past
 * the freshness window) can prime again.
 */
let inFlightPrime: Promise<void> | null = null

/** Reset the in-flight latch. Tests only. */
export function _resetAnthropicPrimeInFlight(): void {
  inFlightPrime = null
}

/**
 * Warm the Anthropic quota cache so the status-bar slot's first tick finds
 * fresh data. Issues a bounded 1-token Haiku POST through the canonical,
 * plugin-owned probe (`./quota-probe.ts::probeQuota` — wired at the B-0
 * transport flip, replacing the legacy `checkQuota`), whose response headers
 * carry the `anthropic-ratelimit-*` map that `broadcastResponseRateLimits`
 * copies into the in-process cache AND emits on `quota.headersReceived`. The
 * status-bar slot's `refreshOn: ["quota.headersReceived"]` then refires it
 * and the footer populates.
 *
 * Never throws. Self-gates on missing auth (no creds → just return; the
 * footer keeps the context-only view). Self-deduplicates a concurrent caller
 * via {@link inFlightPrime}.
 *
 * NOTE: declared as a regular (non-`async`) function returning a `Promise`
 * so the returned reference IS the shared in-flight promise. An `async`
 * wrapper would mint a fresh Promise on every call (wrapping the same
 * inner one), making the dedupe invisible to `===` consumers and to tests
 * pinning the contract via reference identity.
 */
export function primeAnthropicSessionInfo(ctx: ProviderSessionContext): Promise<void> {
  // A previous prime is still racing — join it instead of doubling the POST.
  if (inFlightPrime) return inFlightPrime

  // The async IIFE may complete SYNCHRONOUSLY on the cache-fresh fast path
  // (no `await` taken). If we cleared `inFlightPrime` from inside a `try
  // / finally`, the clear would run BEFORE the outer `inFlightPrime = work`
  // assignment landed, leaving the latch permanently pinned to this
  // promise and breaking dedupe-after-settle. Attaching `.finally` on the
  // OUTSIDE always defers the clear to a microtask after the assignment,
  // which matches both fast-path and slow-path semantics.
  const work = (async () => {
    // Cache-first: a fresh snapshot (typically populated by a prior chat
    // response or a same-process prime) makes the probe unnecessary.
    const cached = getLastRateLimits()
    if (cached && Date.now() - cached.at < FRESHNESS_MS) return

    let auth: Awaited<ReturnType<typeof getAuth>> | null = null
    try {
      auth = await getAuth()
    } catch {
      auth = null
    }
    if (!auth) return

    // `probeQuota` (the canonical, plugin-owned probe — wired here at the
    // B-0 flip, replacing the legacy `src/client/quota.ts checkQuota`)
    // already broadcasts on success (cache write + bus emit via
    // `broadcastResponseRateLimits`), so we don't need its return. It also
    // swallows its own errors and honors `ctx.signal` composed with its
    // internal 15s deadline.
    await probeQuota(auth, ctx.networkClient as NetworkClient | undefined, ctx.signal)
  })()

  inFlightPrime = work
  // Identity-guarded clear: a later prime() may have replaced the latch
  // by the time this resolves (after `_resetAnthropicPrimeInFlight` from
  // tests, for example); never blow away a successor's latch. `void`
  // marks the .finally() chain as intentionally fire-and-forget — the
  // body cannot throw (single assignment to a module local).
  void work.finally(() => {
    if (inFlightPrime === work) inFlightPrime = null
  })

  return work
}

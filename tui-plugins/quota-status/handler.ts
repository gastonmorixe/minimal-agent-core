/**
 * Live-area slot handler for the `quota-status` plugin.
 *
 * Returns a single-line ANSI string describing the current Anthropic
 * rate-limit windows (5h, 7d) plus the session's cumulative token
 * usage. Two refresh paths feed it:
 *
 *  1. **Event-driven (the fast path)** — the agent's `client.ts`
 *     emits `quota.headersReceived` after every successful API
 *     response, the scheduler off-cycle re-fires this slot, and we
 *     read straight from the in-process cache populated by that same
 *     event. **No extra round-trip.** Footer updates within
 *     milliseconds of every chat completion.
 *
 *  2. **Timer (the heartbeat)** — every `refreshMs` (5min) we
 *     re-evaluate. If the cache is still fresh from a recent event
 *     we keep using it; otherwise we fall back to a dedicated
 *     `checkQuota()` probe.
 *
 * Visual is owned by `./render.ts` — pure formatter shared with
 * tests. The handler only orchestrates the freshness/probe decision
 * and reads session totals.
 *
 * Overage status is hidden by default. Set
 * `MINIMAL_AGENT_QUOTA_OVERAGE=1` to surface it.
 */

import { c } from "../../src/agent.ts"
import { getAuth } from "../../src/auth.ts"
import { checkQuota } from "../../src/client.ts"
import { getLastRateLimits } from "../../src/quota-cache.ts"
import { getSessionTokens } from "../../src/session-tokens.ts"
import type { LiveAreaHandlerContext } from "../../src/plugins/types.ts"
import { renderQuotaFooter } from "./render.ts"

// Module-level snapshot — read once at first invoke. Setting/unsetting the
// env var mid-session won't take effect until restart, which is fine: this
// is a power-user knob, not a runtime toggle.
const SHOW_OVERAGE = process.env.MINIMAL_AGENT_QUOTA_OVERAGE === "1"

/**
 * "Fresh enough to skip a `checkQuota` probe" window. Half the declared
 * refresh interval — that way an event-driven invoke always uses the
 * cache (timestamp ~0 ms old), and a timer-driven invoke also uses the
 * cache iff a real response cached data within the last refreshMs/2.
 *
 * The 60_000 fallback handles slots that don't carry a refreshMs.
 */
function freshnessWindowMs(): number {
  return 60_000
}

function cols(): number {
  // Prefer the env COLUMNS the loader injects for plugins. Fall back to
  // live process.stdout.columns. Treat 0 (script-allocated PTY) as
  // "no clamp".
  const env = Number(process.env.COLUMNS)
  const live = process.stdout.columns
  const v = Number.isFinite(env) && env > 0 ? env : live
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
}

export default async function handle(
  ctx: LiveAreaHandlerContext,
): Promise<string | null> {
  // 1) Cache-first: if the agent's last successful response left a
  //    snapshot, prefer it. Cheaper than `checkQuota` (no API call, no
  //    auth, no parse), and inside the freshness window we trust it
  //    absolutely.
  const cached = getLastRateLimits()
  if (cached && Date.now() - cached.at < freshnessWindowMs()) {
    return renderQuotaFooter(cached.rateLimits, getSessionTokens(), {
      cols: cols(),
      showOverage: SHOW_OVERAGE,
    })
  }

  // 2) Cache cold or stale: fall back to a dedicated probe. This runs
  //    only at the heartbeat (no recent traffic) or the very first
  //    invoke before any chat completion.
  //
  //    `ctx.abort` is forwarded all the way down to the network
  //    transport so a stuck probe is canceled when the scheduler's
  //    `timeoutMs` elapses — releasing the slot's `inFlight` gate so
  //    subsequent heartbeats AND `quota.headersReceived` bus events
  //    can refresh the footer.
  let auth: Awaited<ReturnType<typeof getAuth>>
  try {
    auth = await getAuth()
  } catch {
    return c.dim("auth missing")
  }
  const result = await checkQuota(auth, undefined, ctx.abort)
  if (!result.ok) return c.dim("—")
  return renderQuotaFooter(result.rateLimits, getSessionTokens(), {
    cols: cols(),
    showOverage: SHOW_OVERAGE,
  })
}

/**
 * Live-area slot handler for the `quota-status` plugin.
 *
 * Returns a single-line ANSI string describing the current Anthropic
 * rate-limit windows (5h, 7d, overall). Two refresh paths feed it:
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
 *     `checkQuota()` probe. The heartbeat covers idle agents and
 *     the multi-agent case (another process burning quota while we
 *     sleep).
 *
 * The cache-vs-probe decision uses a "fresh enough" window of
 * `refreshMs / 2`. Within that window, an event-driven re-fire
 * always uses the cache (timestamp ≈ now); a timer-driven re-fire
 * also uses the cache if a recent response populated it. Outside,
 * the timer falls back to `checkQuota`. Tunable per plugin via
 * `refreshMs` in the manifest.
 *
 * Failures (network blip, missing auth, rotated token) degrade to a
 * faint placeholder string rather than `null` — `null` from a slot
 * handler tells the scheduler to fall back to the manifest's
 * `placeholder`, which is also fine, but a per-error message gives
 * the user a quick read on WHY it's stale.
 */

import { c } from "../../src/agent.ts"
import { getAuth } from "../../src/auth.ts"
import { checkQuota } from "../../src/client.ts"
import { getLastRateLimits } from "../../src/quota-cache.ts"
import { formatQuotaSummary } from "../../src/quota-format.ts"
import type { LiveAreaHandlerContext } from "../../src/plugins/types.ts"

const LABEL = c.faintWhite("quota")

/** Build the rendered line from a parsed rate-limit map. */
function render(rl: ReadonlyMap<string, string>): string | null {
  const summary = formatQuotaSummary(rl as Map<string, string>, { leadSpaces: 0 })
  if (summary.length === 0) return null
  return `${LABEL}  ${summary}`
}

/**
 * "Fresh enough to skip a `checkQuota` probe" window. Half the
 * declared refresh interval — that way an event-driven invoke
 * always uses the cache (timestamp ~0 ms old), and a timer-driven
 * invoke also uses the cache iff a real response cached data
 * within the last refreshMs/2.
 *
 * The 60_000 fallback handles slots that don't carry a refreshMs
 * (the manifest parser preserves undefined; the loader applies
 * defaults but a hand-constructed slot in tests might miss it).
 */
function freshnessWindowMs(): number {
  return 60_000
}

export default async function handle(_ctx: LiveAreaHandlerContext): Promise<string | null> {
  // 1) Cache-first: if the agent's last successful response left a
  //    snapshot, prefer it. Cheaper than `checkQuota` (no API call,
  //    no auth, no parse), and inside the freshness window we trust
  //    it absolutely.
  const cached = getLastRateLimits()
  if (cached && Date.now() - cached.at < freshnessWindowMs()) {
    const line = render(cached.rateLimits)
    return line // null is fine — scheduler falls back to placeholder.
  }

  // 2) Cache cold or stale: fall back to a dedicated probe. This
  //    runs only at the heartbeat (no recent traffic) or the very
  //    first invoke before any chat completion.
  let auth: Awaited<ReturnType<typeof getAuth>>
  try {
    auth = await getAuth()
  } catch {
    return `${LABEL} ${c.dim("auth missing")}`
  }
  const result = await checkQuota(auth)
  if (!result.ok) return `${LABEL} ${c.dim("—")}`
  return render(result.rateLimits)
}

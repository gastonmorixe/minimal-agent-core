/**
 * Live-area slot handler for the `quota-status` plugin.
 *
 * Returns a single-line ANSI string describing the current Anthropic
 * rate-limit windows (5h, 7d, overall) — the same data the synchronous
 * startup row used to print, just refreshed every 5 minutes (per
 * manifest's `refreshMs`) and rendered as a sticky footer below the
 * REPL prompt.
 *
 * Implementation notes:
 *
 * - We re-call `getAuth()` on every tick. It's a cheap keychain read
 *   and reading fresh picks up token rotations done by the official
 *   `claude` CLI in another process. The closed-over snapshot stays
 *   inside `getAuth`'s `doRefresh` closure where it belongs.
 * - We swallow `checkQuota` failures (network blip, rotated token, …)
 *   and return a faint "quota —" placeholder rather than null — null
 *   would clear the footer entirely on a single bad tick, which feels
 *   like the agent is hiding state. The next tick recovers.
 * - `formatQuotaSummary` is shared with the startup path
 *   (`src/quota-format.ts`); we pass `leadSpaces: 0` because the
 *   compositor anchors the slot at column 0 already.
 *
 * Shape: `<label> <segment> · <segment> · …`. Empty when the API
 * returned no `anthropic-ratelimit-*` headers (typical only in test
 * fakes — production responses always carry them).
 */

import { c } from "../../src/agent.ts"
import { getAuth } from "../../src/auth.ts"
import { checkQuota } from "../../src/client.ts"
import { formatQuotaSummary } from "../../src/quota-format.ts"
import type { LiveAreaHandlerContext } from "../../src/plugins/types.ts"

const LABEL = c.faintWhite("quota")

export default async function handle(_ctx: LiveAreaHandlerContext): Promise<string | null> {
  let auth: Awaited<ReturnType<typeof getAuth>>
  try {
    auth = await getAuth()
  } catch {
    // No keychain creds — surface a faint marker rather than nothing.
    return `${LABEL} ${c.dim("auth missing")}`
  }

  const result = await checkQuota(auth)
  if (!result.ok) {
    return `${LABEL} ${c.dim("—")}`
  }

  const summary = formatQuotaSummary(result.rateLimits, { leadSpaces: 0 })
  if (summary.length === 0) return null
  return `${LABEL}  ${summary}`
}

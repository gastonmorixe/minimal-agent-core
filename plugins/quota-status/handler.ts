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
import { checkQuota, has1mContext } from "../../src/client.ts"
import { modelShortLabel } from "../../src/llm/index.ts"
import { getLastRateLimits } from "../../src/quota-cache.ts"
import { getSessionTokens } from "../../src/session-tokens.ts"
import type { LiveAreaHandlerContext } from "../../src/plugins/types.ts"
import { renderQuotaFooter } from "./render.ts"

// Module-level snapshot — read once at first invoke. Setting/unsetting the
// env var mid-session won't take effect until restart, which is fine: this
// is a power-user knob, not a runtime toggle.
const SHOW_OVERAGE = process.env.MINIMAL_AGENT_QUOTA_OVERAGE === "1"

/**
 * Rule 3 escape hatch: when set to `"wrap"`, the renderer skips its
 * single-line clip and emits the richest still-fitting form. The
 * terminal natural-wraps the excess onto subsequent rows and the
 * live area grows to accommodate. Anything else (unset, `"truncate"`,
 * or noise) keeps the default hard single-line invariant.
 *
 * Snapshot-once: changing the env var mid-process does not take
 * effect until restart — same as the other quota-status snapshots
 * above. Matches the power-user-knob philosophy of
 * `MINIMAL_AGENT_QUOTA_OVERAGE`.
 */
const OVERFLOW: "truncate" | "wrap" =
  process.env.MINIMAL_AGENT_QUOTA_OVERFLOW === "wrap" ? "wrap" : "truncate"

/**
 * Resolve the model's context-window size from `MINIMAL_AGENT_MODEL`.
 *
 * The agent (src/index.ts) sets this env var before plugin load, so it's
 * reliably available here. Snapshot-once: model can be switched per call
 * via `--model`, but the live-area footer is per-process and we'd rather
 * not re-resolve on every paint.
 *
 * Returns:
 *   - `1_000_000` for `[1m]` variants (Sonnet 4.6 [1m], Opus 4.6 [1m],
 *     Opus 4.7 [1m] — the explicit 1M opt-in).
 *   - `200_000` for any other resolved model id (Anthropic's standard
 *     context window).
 *   - `undefined` when `MINIMAL_AGENT_MODEL` is missing or empty. The
 *     renderer treats this as "unknown" and falls back to the `·`
 *     placeholder for the segment's label (dropping the bar+percent,
 *     keeping the trailing count). This branch is rare in normal
 *     operation — the agent sets the env var before plugin load — but
 *     it covers dev/test runs and the brief window if the loader
 *     order ever changes.
 */
function resolveContextWindow(): number | undefined {
  const model = process.env.MINIMAL_AGENT_MODEL ?? ""
  if (!model) return undefined
  return has1mContext(model) ? 1_000_000 : 200_000
}
const CONTEXT_WINDOW = resolveContextWindow()

/**
 * Resolved reasoning-effort level being sent on the wire, surfaced by
 * the agent on `process.env.MINIMAL_AGENT_EFFORT` after resolution
 * (CLI > env > config > "medium" default for non-haiku models). For
 * haiku the agent clears the env var entirely so the segment is
 * suppressed. Snapshot-once at module load — matches the
 * `MINIMAL_AGENT_MODEL` pattern above.
 */
function resolveEffort(): string | undefined {
  const v = process.env.MINIMAL_AGENT_EFFORT
  return v && v !== "" ? v : undefined
}
const EFFORT = resolveEffort()

/**
 * Compact provider-model tag (e.g. `anth-4.8`, `oai-5.5`) for the effort
 * segment, derived from `MINIMAL_AGENT_MODEL` via the canonical model
 * registry (populated at agent startup, before plugin load). Snapshot-once,
 * matching the EFFORT / MODEL patterns above. When set, the footer's effort
 * segment reads `<tag>:<level>` instead of `effort <level>`.
 */
const MODEL_LABEL = process.env.MINIMAL_AGENT_MODEL
  ? modelShortLabel(process.env.MINIMAL_AGENT_MODEL)
  : undefined

/**
 * Shortened session-id anchor for the trailing footer segment.
 *
 * `MINIMAL_AGENT_SESSION_ID` carries the full UUIDv4 (set by the agent
 * before plugin load, see `src/index.ts`). We take the first 8 hex
 * chars — 32 random bits — which keeps collision risk negligible
 * inside a single user's `~/.minimal-agent/sessions/` directory
 * (probability ≈ N²/2^33; ~0.000012% at 1,000 sessions). A user who
 * needs the full id still has it on the startup tree and in every
 * filename under the sessions dir.
 *
 * Returns `undefined` when no env var is set (snapshot-fresh test
 * runs, or any pre-resolution path).
 */
function resolveSid(): string | undefined {
  const v = process.env.MINIMAL_AGENT_SESSION_ID
  if (!v) return undefined
  // The first dash is at index 8 in a canonical UUIDv4
  // ("b1d82846-…"), so `slice(0, 8)` lifts the leading hex group
  // verbatim without an explicit split. Robust to non-UUID inputs:
  // any string is just truncated to its first 8 chars.
  return v.slice(0, 8)
}
const SID = resolveSid()

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
      contextWindow: CONTEXT_WINDOW,
      effort: EFFORT,
      modelLabel: MODEL_LABEL,
      sid: SID,
      overflow: OVERFLOW,
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
    contextWindow: CONTEXT_WINDOW,
    effort: EFFORT,
    sid: SID,
    overflow: OVERFLOW,
  })
}

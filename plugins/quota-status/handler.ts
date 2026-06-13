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

import type { LiveAreaHandlerContext } from "@minimal-agent/plugin-api/types/plugin"

import { loadUserConfig } from "../../src/config.ts"
import { resolveProviderSessionInfo } from "../../src/llm/provider-session.ts"
import { getSessionTokens } from "../../src/session-tokens.ts"

import { renderQuotaFooter } from "./render.ts"
import { runStatusScript } from "./script-runner.ts"

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
 * The session's model id, normalized (no `[1m]`/`[2m]` suffix). The agent
 * (src/index.ts) sets `MINIMAL_AGENT_MODEL` before plugin load. Resolved per
 * call (cheap) rather than snapshot-once, so a future sub-agent that swaps the
 * model mid-session gets the right provider's metadata. The context window +
 * model label are NO LONGER computed here — the provider supplies them via
 * `resolveProviderSessionInfo` (which reads the model registry), so this
 * handler is fully provider-agnostic.
 */
function currentModelId(): string {
  return (process.env.MINIMAL_AGENT_MODEL ?? "").replace(/\[(1|2)m\]/gi, "")
}

/**
 * Resolved reasoning-effort level being sent on the wire, surfaced by
 * the agent on `process.env.MINIMAL_AGENT_EFFORT` after resolution
 * (CLI takes precedence over env, then config, then the "medium"
 * default for non-haiku models). For
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
 * User-configured status-bar segment order/visibility (`statusBar.segments`).
 * Snapshot-once at module load (same philosophy as the other knobs above).
 * `undefined` → renderer uses its default order. The renderer normalizes
 * leniently, so a typo'd id never blanks the footer.
 */
const STATUS_SEGMENTS = loadUserConfig().statusBar?.segments

/**
 * User-supplied full-custom status-bar script (`statusBar.script`). When set, it
 * takes precedence over the built-in renderer: it receives the session metadata
 * as JSON on stdin and its first stdout line becomes the footer. Snapshot-once.
 * Any failure falls back to the built-in renderer (see {@link runStatusScript}).
 */
const STATUS_SCRIPT = loadUserConfig().statusBar?.script

function cols(): number {
  // Prefer the env COLUMNS the loader injects for plugins. Fall back to
  // live process.stdout.columns. Treat 0 (script-allocated PTY) as
  // "no clamp".
  const env = Number(process.env.COLUMNS)
  const live = process.stdout.columns
  const v = Number.isFinite(env) && env > 0 ? env : live
  return Number.isFinite(v) && v > 0 ? v : Number.POSITIVE_INFINITY
}

/**
 * Live-area handler: queries the active provider's session metadata for
 * quota windows and renders the utilization/reset widget line (or null when
 * the provider exposes none).
 */
export default async function handle(ctx: LiveAreaHandlerContext): Promise<string | null> {
  // Ask the CURRENT model's provider for session metadata (quota windows,
  // context window, model label). Provider-agnostic: the handler names no
  // provider. The Anthropic provider does the cache-first read + bounded
  // probe internally (see plugins/llm-anthropic/session-info.ts); a provider
  // with no quota concept returns context-only and the footer adapts.
  //
  // `ctx.abort` is forwarded into any network probe, so the scheduler's
  // per-slot `timeoutMs` tears a stuck probe down (and the shared transport's
  // abort escalation evicts a wedged HTTP/2 session), releasing the `inFlight`
  // gate for the next heartbeat / `quota.headersReceived` refresh. Long-
  // running sessions never wedge the footer.
  const info = await resolveProviderSessionInfo(currentModelId(), { signal: ctx.abort })
  const sessionTokens = getSessionTokens()

  // Full-custom renderer escape hatch: hand the session metadata to the user's
  // script and use its output. On any failure/empty/timeout we fall through to
  // the built-in renderer, so a broken script never blanks the footer.
  if (STATUS_SCRIPT) {
    const line = await runStatusScript(
      STATUS_SCRIPT,
      {
        contextWindow: info.contextWindow,
        modelLabel: info.modelLabel,
        quota: info.quota,
        sessionTokens,
        cols: cols(),
        sid: SID,
        effort: EFFORT,
        modelId: currentModelId(),
      },
      ctx.abort,
    )
    if (line) return line
  }

  const windows = info.quota?.windows ?? []
  return renderQuotaFooter(windows, sessionTokens, {
    cols: cols(),
    showOverage: SHOW_OVERAGE,
    overage: info.quota?.overage,
    contextWindow: info.contextWindow,
    effort: EFFORT,
    modelLabel: info.modelLabel,
    sid: SID,
    overflow: OVERFLOW,
    segments: STATUS_SEGMENTS,
  })
}

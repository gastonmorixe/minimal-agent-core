/**
 * Canonical Anthropic quota probe (Wave-3 replacement for the legacy
 * `src/client/quota.ts checkQuota`).
 *
 * A bounded, cheapest-possible POST whose only purpose is to read the
 * provider's rate-limit response headers and feed them to the core
 * cache/bus via `broadcastResponseRateLimits` (which detects header
 * names by the neutral `/ratelimit/i` pattern; PARSING the shapes stays
 * in `./session-info.ts`).
 *
 * Parity contract with the legacy probe (pinned in quota-probe.test.ts):
 *   - 1-token request to the provider's cheap tier, no system, no tools
 *     (classifies as `kind:"quota"` → the minimal beta-flag set);
 *   - hard {@link QUOTA_PROBE_TIMEOUT_MS} deadline composed with the
 *     caller's signal — the probe can never hang a caller;
 *   - 401 → store-first peer-token adoption, then network refresh
 *     (same two-step policy as the transport's `withAuthRefresh`,
 *     inlined here because the probe is a single bounded request, not a
 *     stream);
 *   - `{ok:true, rateLimits}` on 200 with the broadcast side effect;
 *     `{ok:false}` on ANY failure (callers treat it as soft).
 *
 * Owned by the PLUGIN: the probe model id and wire shape are Anthropic
 * facts. Core reaches this only through the provider-plugin seam.
 *
 * @module llm/providers/anthropic/quota-probe
 */

import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"

import { type AuthResult, readCredentials } from "../../src/auth.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { findModelByTags, resolveModel } from "../../src/llm/model-registry.ts"
import { defaultNetworkClient } from "../../src/network/index.ts"
import { broadcastResponseRateLimits } from "../../src/quota/quota-broadcast.ts"

import { buildAnthropicHeaders } from "./headers.ts"
import { registerAnthropicModels } from "./models.ts"

export type QuotaProbeResult = { ok: false } | { ok: true; rateLimits: Map<string, string> }

/** Absolute upper bound on a single probe (send + TTFB + read). */
export const QUOTA_PROBE_TIMEOUT_MS = 15_000

/** Messages endpoint (same as the adapter's run()). */
const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"

/** Cheapest registered tier for the probe; self-heals pre-bootstrap. */
function probeModelId(): string {
  const found = findModelByTags("anthropic", ["haiku", "production"])?.id
  if (found) return found
  // Early-boot caller before the provider registered: register and retry
  // (registerAnthropicModels is idempotent).
  registerAnthropicModels()
  return findModelByTags("anthropic", ["haiku", "production"])?.id ?? "claude-haiku-4-5-20251001"
}

/**
 * Probe the API for current rate-limit headers. Soft-fails (`{ok:false}`)
 * on any error; never throws, never hangs past the deadline.
 */
/** Injectable seams (tests). Production callers omit. */
export interface QuotaProbeDeps {
  /** Credential-store reader for peer-token adoption. Default: real store. */
  readCreds?: typeof readCredentials
}

/**
 * Fire a minimal countable request at the provider to read back the quota
 * window headers (utilization + reset), without polluting the session
 * transcript.
 */
export async function probeQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
  signal?: AbortSignal,
  deps: QuotaProbeDeps = {},
): Promise<QuotaProbeResult> {
  const readCreds = deps.readCreds ?? readCredentials
  const modelId = probeModelId()
  const probeSignal: AbortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)])
    : AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)

  // Minimal quota shape: 1 token, bare user message → classifyRequest
  // returns kind:"quota" → the minimal beta-flag set.
  const req: CanonicalRequest = {
    modelId,
    generation: { maxOutputTokens: 1 },
    messages: [{ role: "user", content: [{ type: "text", text: "quota" }] }],
  }

  const doRequest = async (token: string) => {
    const { headers } = buildAnthropicHeaders({
      req,
      model: resolveModel(modelId),
      auth: auth.type === "oauth" ? { kind: "oauth", token } : { kind: "api-key", key: token },
      sessionId: process.env.MINIMAL_AGENT_SESSION_ID ?? "quota-probe",
    })
    return networkClient.request({
      label: "quota.probe",
      method: "POST",
      url: MESSAGES_URL,
      headers,
      body: JSON.stringify({
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: "quota" }],
      }),
      signal: probeSignal,
    })
  }

  try {
    let response = await doRequest(auth.token)

    // 401 recovery: store-first peer adoption, then network refresh —
    // the same two-step policy as the canonical transport's withAuthRefresh.
    if (response.status === 401 && auth.type === "oauth" && auth.refresh) {
      let recovered = false
      try {
        const freshToken = readCreds()?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          auth.token = freshToken
          response = await doRequest(freshToken)
          recovered = response.ok
        }
      } catch {
        // best-effort; fall through to refresh
      }
      if (!recovered && response.status === 401) {
        const refreshed = await auth.refresh()
        auth.token = refreshed.token
        response = await doRequest(refreshed.token)
      }
    }

    if (!response.ok) return { ok: false }
    const rateLimits = broadcastResponseRateLimits(response.headers)
    return { ok: true, rateLimits }
  } catch {
    return { ok: false }
  }
}

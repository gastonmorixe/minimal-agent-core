/**
 * Anthropic quota / rate-limit probe.
 *
 * Re-exported by `client.ts` for back-compat. A bounded 1-token Haiku POST
 * whose only purpose is to read the `anthropic-ratelimit-*` response headers
 * (broadcast to the in-process cache + bus). The internal
 * {@link QUOTA_PROBE_TIMEOUT_MS} deadline guarantees the probe can never hang,
 * even when the caller passes no signal.
 *
 * @module client/quota
 */

import { type AuthResult, readCredentials } from "../auth.ts"
import { API_URL, buildHeaders } from "../headers.ts"
import { buildMetadata, getSessionId } from "../metadata.ts"
import { defaultNetworkClient, type NetworkClient } from "../network/index.ts"
import { broadcastResponseRateLimits } from "../quota-broadcast.ts"

import { c, debugHeader, debugKV, debugResponse, isDebug } from "./debug.ts"

export type QuotaResult = { ok: false } | { ok: true; rateLimits: Map<string, string> }

/** Absolute upper bound on a single `checkQuota` probe (send + TTFB + read). */
const QUOTA_PROBE_TIMEOUT_MS = 15_000

/**
 * Probe the Anthropic API for the current quota / rate-limit state. Returns
 * `{ok: true, rateLimits}` on a 200 (with the parsed `anthropic-ratelimit-*`
 * headers), or `{ok: false}` on any error. Always bounded by an internal
 * {@link QUOTA_PROBE_TIMEOUT_MS} deadline (composed with the caller signal).
 */
export async function checkQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId, "quota")
  const metadata = buildMetadata(auth)

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "quota" }],
    metadata,
  }

  debugHeader("POST (quota check)")
  debugKV("model", body.model)

  const serializedBody = JSON.stringify(body)
  const probeSignal: AbortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)])
    : AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)
  const doRequest = async (token: string) => {
    const h = { ...headers }
    if (h.authorization) h.authorization = `Bearer ${token}`
    else if (h["x-api-key"]) h["x-api-key"] = token
    return networkClient.request({
      label: "quota.check",
      method: "POST",
      url: API_URL,
      headers: h,
      body: serializedBody,
      signal: probeSignal,
    })
  }

  try {
    let response = await doRequest(auth.token)

    // 401: keychain-first peer-token adoption, then refresh (mirrors sendMessage).
    if (response.status === 401 && auth.refresh) {
      let recovered = false
      try {
        const fresh = readCredentials()
        const freshToken = fresh?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          auth.token = freshToken
          response = await doRequest(freshToken)
          if (response.ok) recovered = true
        }
      } catch {
        // best-effort; fall through to refresh
      }
      if (!recovered && response.status === 401) {
        const refreshed = await auth.refresh()
        response = await doRequest(refreshed.token)
        auth.token = refreshed.token
      }
    }

    debugResponse(response.status, response.headers)

    if (!response.ok) {
      const errorBody = await response.text()
      if (isDebug()) {
        debugHeader(c.red(`Quota check failed: ${response.status}`))
        console.error(`  ${errorBody.slice(0, 200)}`)
      }
      return { ok: false }
    }

    const rateLimits = broadcastResponseRateLimits(response.headers)
    return { ok: true, rateLimits }
  } catch (e) {
    if (isDebug()) {
      console.error(`  quota check error: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { ok: false }
  }
}

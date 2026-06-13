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

import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { type AuthResult, readCredentials } from "../auth.ts"
import { API_URL, buildHeaders } from "../headers.ts"
import { defaultNetworkClient, type NetworkClient } from "../network/index.ts"
import { broadcastResponseRateLimits } from "../quota-broadcast.ts"
import { getSessionId } from "../session-id.ts"

import { c, debugHeader, debugKV, debugResponse, isDebug } from "./debug.ts"

export type QuotaResult = { ok: false } | { ok: true; rateLimits: Map<string, string> }

// ---------------------------------------------------------------------------
// Legacy `metadata.user_id` construction (B-5 debt).
//
// The provider-decoupling effort moved the canonical device-id / user_id
// fingerprint code to `plugins/llm-anthropic/identity.ts`. Core may NOT import
// a plugin (I2), so the dying legacy client stack keeps its own self-contained
// copy here until it is deleted wholesale in Wave B-5 (client.ts + client/* +
// adapter-legacy.ts). The canonical transport builds this metadata in the
// plugin; this duplicate exists only to keep the legacy `sendMessage` /
// `checkQuota` path byte-identical during the bake window.
// ---------------------------------------------------------------------------

/** Default CLI config path holding the persistent `userID` (device id). */
const DEFAULT_CONFIG_PATH = join(process.env.HOME ?? "", ".claude.json")

/** Read the persistent 64-hex device id from the CLI config, or mint one. */
function getDeviceId(configPath: string = DEFAULT_CONFIG_PATH): string {
  try {
    const raw = readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw) as { userID?: string }
    if (config.userID && config.userID.length === 64) return config.userID
  } catch {
    // fall through to our own state file
  }
  const stateDir = join(process.env.HOME ?? "", ".claude-demo")
  const statePath = join(stateDir, "state.json")
  try {
    const raw = readFileSync(statePath, "utf-8")
    const state = JSON.parse(raw) as { deviceId?: string }
    if (state.deviceId && state.deviceId.length === 64) return state.deviceId
  } catch {
    // no state file — generate below
  }
  const id = randomBytes(32).toString("hex")
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(statePath, JSON.stringify({ deviceId: id }, null, 2))
  } catch {
    // best-effort persistence
  }
  return id
}

/** Parse optional extra metadata from `CLAUDE_CODE_EXTRA_METADATA` (JSON object). */
function loadExtraMetadata(): Record<string, unknown> {
  const raw = process.env.CLAUDE_CODE_EXTRA_METADATA
  if (!raw) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // invalid JSON — ignore
  }
  return {}
}

/**
 * Build the legacy `{ user_id }` metadata payload for a Messages API request.
 * Compact JSON with `{ ...extra, device_id, account_uuid, session_id }` (the
 * core fields override any extra keys), matching CLI v2.1.87.
 *
 * @param auth - Resolved credential; the OAuth account uuid is embedded.
 * @returns The `{ user_id }` metadata object.
 */
export function buildLegacyMetadata(auth: AuthResult): { user_id: string } {
  const payload: Record<string, unknown> = {
    ...loadExtraMetadata(),
    device_id: getDeviceId(),
    account_uuid: auth.type === "oauth" && auth.accountUuid ? auth.accountUuid : "",
    session_id: getSessionId(),
  }
  return { user_id: JSON.stringify(payload) }
}

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
  const metadata = buildLegacyMetadata(auth)

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

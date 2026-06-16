/**
 * OpenAI auth strategies.
 *
 * Providers own endpoint/scopes/codecs; host core owns prompting and storage.
 *
 * @module llm/providers/openai/auth
 */

import type { ProviderAuth } from "@minimal-agent/plugin-api/llm/provider-auth"
import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
  OAuthDeviceCodeChallenge,
  OAuthDeviceCodeContext,
  OAuthLoginProvider,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"

export const OPENAI_API_KEY_AUTH = {
  serviceId: "openai-api-key",
  displayName: "OpenAI API Key",
} as const

export const OPENAI_CHATGPT_OAUTH = {
  serviceId: "openai-chatgpt-oauth",
  displayName: "OpenAI ChatGPT (OAuth)",
} as const

const OPENAI_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"
const OPENAI_AUTH_BASE_URL = "https://auth.openai.com"
const OPENAI_DEVICE_AUTH_API = `${OPENAI_AUTH_BASE_URL}/api/accounts`
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`
const OPENAI_DEVICE_TIMEOUT_MS = 15 * 60 * 1000

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function bool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined
}

function record(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
}

function network(ctx: OAuthDeviceCodeContext): NetworkClient {
  const client = ctx.networkClient as NetworkClient | undefined
  if (!client) throw new Error("OpenAI device-code login: missing network client")
  return client
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error("OpenAI device-code login aborted")
  err.name = "AbortError"
  throw err
}

/** Encode an OpenAI API key into this provider's opaque secret bag. */
export function openAIApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for an OpenAI API key. */
export function buildOpenAIApiKeyCredential(apiKey: string) {
  return {
    serviceId: OPENAI_API_KEY_AUTH.serviceId,
    displayName: OPENAI_API_KEY_AUTH.displayName,
    secrets: openAIApiKeyToSecrets(apiKey),
  }
}

/** Decode an OpenAI API key from this provider's opaque secret bag. */
export function readOpenAIApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored OpenAI API-key metadata without exposing the secret. */
export function inspectOpenAIApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readOpenAIApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const openAIApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENAI_API_KEY_AUTH,
  buildCredential: buildOpenAIApiKeyCredential,
  readApiKey: readOpenAIApiKey,
  inspectCredential: inspectOpenAIApiKeyCredential,
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".")
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=")
    return record(JSON.parse(Buffer.from(padded, "base64").toString("utf8"))) ?? null
  } catch {
    return null
  }
}

function tokenExpiryMs(accessToken: string | undefined, idToken: string | undefined): number {
  const exp =
    num(decodeJwtPayload(accessToken ?? "")?.exp) ?? num(decodeJwtPayload(idToken ?? "")?.exp)
  return exp ? exp * 1000 : Date.now() + 60 * 60 * 1000
}

/** Encode OpenAI ChatGPT OAuth tokens into this provider's opaque secret bag. */
export function openAIOAuthToSecrets(raw: Record<string, unknown>): AuthSecretBag {
  const accessToken = str(raw.access_token)
  const refreshToken = str(raw.refresh_token)
  const idToken = str(raw.id_token)
  if (!accessToken || !refreshToken || !idToken) {
    throw new Error("OpenAI OAuth response missing access_token, refresh_token, or id_token")
  }

  const idPayload = decodeJwtPayload(idToken)
  const authClaim = record(idPayload?.["https://api.openai.com/auth"])
  const profileEmail = str(idPayload?.["https://api.openai.com/profile.email"])
  const emailAddress = str(idPayload?.email) ?? profileEmail
  const accountId = str(authClaim?.chatgpt_account_id)
  const userId = str(authClaim?.chatgpt_user_id) ?? str(authClaim?.user_id)
  const planType = str(authClaim?.chatgpt_plan_type)
  const fedramp = bool(authClaim?.chatgpt_account_is_fedramp)

  return {
    tokenType: "oauth",
    accessToken,
    refreshToken,
    idToken,
    expiresAt: tokenExpiryMs(accessToken, idToken),
    ...(emailAddress ? { emailAddress } : {}),
    ...(accountId ? { accountId } : {}),
    ...(userId ? { userId } : {}),
    ...(planType ? { planType } : {}),
    ...(fedramp !== undefined ? { fedramp } : {}),
  }
}

/** Build the host-persistable credential write for OpenAI ChatGPT OAuth. */
export function buildOpenAIOAuthCredential(response: Record<string, unknown>) {
  const secrets = openAIOAuthToSecrets(response)
  return {
    credential: {
      serviceId: OPENAI_CHATGPT_OAUTH.serviceId,
      displayName: OPENAI_CHATGPT_OAUTH.displayName,
      secrets,
    },
    result: {
      accessToken: String(secrets.accessToken),
      refreshToken: String(secrets.refreshToken),
      expiresAt: Number(secrets.expiresAt),
      scopes: [],
      ...(typeof secrets.userId === "string" || typeof secrets.emailAddress === "string"
        ? {
            account: {
              uuid: typeof secrets.userId === "string" ? secrets.userId : "openai",
              emailAddress:
                typeof secrets.emailAddress === "string" ? secrets.emailAddress : "unknown",
            },
          }
        : {}),
    },
  }
}

async function requestOpenAIDeviceCode(
  ctx: OAuthDeviceCodeContext,
): Promise<OAuthDeviceCodeChallenge> {
  const response = await network(ctx).request({
    label: "openai.oauth.device.usercode",
    method: "POST",
    url: `${OPENAI_DEVICE_AUTH_API}/deviceauth/usercode`,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: openAIOAuthLogin.config().clientId }),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED OAUTH DEVICE USERCODE BODY]", responseBody: false },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI device-code request failed (${response.status}): ${body}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  const deviceAuthId = str(raw.device_auth_id)
  const userCode = str(raw.user_code) ?? str(raw.usercode)
  const intervalRaw = raw.interval
  const interval =
    typeof intervalRaw === "string" ? Number.parseInt(intervalRaw, 10) : num(intervalRaw)
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device-code response missing device_auth_id or user_code")
  }
  return {
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    userCode,
    pollIntervalMs:
      interval !== undefined && Number.isFinite(interval) && interval > 0 ? interval * 1000 : 5000,
    expiresInMs: OPENAI_DEVICE_TIMEOUT_MS,
    providerData: { deviceAuthId },
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      const err = new Error("OpenAI device-code login aborted")
      err.name = "AbortError"
      reject(err)
    }
    const cleanup = () => signal?.removeEventListener("abort", onAbort)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function pollOpenAIDeviceCode(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
): Promise<Record<string, unknown>> {
  const deviceAuthId = str(challenge.providerData?.deviceAuthId)
  if (!deviceAuthId) throw new Error("OpenAI device-code challenge missing device_auth_id")
  const started = Date.now()
  const intervalMs = challenge.pollIntervalMs ?? 5000
  for (;;) {
    throwIfAborted(ctx.signal)
    const response = await network(ctx).request({
      label: "openai.oauth.device.poll",
      method: "POST",
      url: `${OPENAI_DEVICE_AUTH_API}/deviceauth/token`,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: challenge.userCode }),
      signal: ctx.signal,
      capture: { requestBody: "[REDACTED OAUTH DEVICE POLL BODY]", responseBody: false },
    })
    if (response.ok) return response.json<Record<string, unknown>>()
    if (
      (response.status === 403 || response.status === 404) &&
      Date.now() - started < OPENAI_DEVICE_TIMEOUT_MS
    ) {
      await delay(intervalMs, ctx.signal)
      continue
    }
    const body = await response.text()
    throw new Error(`OpenAI device-code poll failed (${response.status}): ${body}`)
  }
}

async function exchangeOpenAIDeviceAuthorizationCode(
  codeResponse: Record<string, unknown>,
  ctx: OAuthDeviceCodeContext,
): Promise<Record<string, unknown>> {
  const authorizationCode = str(codeResponse.authorization_code)
  const codeVerifier = str(codeResponse.code_verifier)
  if (!authorizationCode || !codeVerifier) {
    throw new Error("OpenAI device-code poll response missing authorization_code or code_verifier")
  }
  const fields = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    redirect_uri: OPENAI_DEVICE_REDIRECT_URI,
    client_id: openAIOAuthLogin.config().clientId,
    code_verifier: codeVerifier,
  })
  const response = await network(ctx).request({
    label: "openai.oauth.device.exchange",
    method: "POST",
    url: openAIOAuthLogin.config().tokenUrl,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: fields.toString(),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED OAUTH DEVICE EXCHANGE BODY]", responseBody: false },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI device-code exchange failed (${response.status}): ${body}`)
  }
  return response.json<Record<string, unknown>>()
}

async function completeOpenAIDeviceCodeLogin(
  challenge: OAuthDeviceCodeChallenge,
  ctx: OAuthDeviceCodeContext,
) {
  const codeResponse = await pollOpenAIDeviceCode(challenge, ctx)
  const tokens = await exchangeOpenAIDeviceAuthorizationCode(codeResponse, ctx)
  return buildOpenAIOAuthCredential(tokens)
}

/** Refresh OpenAI OAuth credentials. */
export async function refreshOpenAIOAuthCredential(
  secrets: AuthSecretBag,
  ctx: OAuthDeviceCodeContext,
) {
  const refreshToken = str(secrets.refreshToken)
  if (!refreshToken) throw new Error("OpenAI OAuth credential has no refresh token")
  const response = await network(ctx).request({
    label: "openai.oauth.refresh",
    method: "POST",
    url: openAIOAuthLogin.config().tokenUrl,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: openAIOAuthLogin.config().clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: ctx.signal,
    capture: { requestBody: "[REDACTED OAUTH REFRESH BODY]", responseBody: false },
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`OpenAI OAuth refresh failed (${response.status}): ${body}`)
  }
  const raw = await response.json<Record<string, unknown>>()
  return buildOpenAIOAuthCredential({
    ...raw,
    refresh_token: str(raw.refresh_token) ?? refreshToken,
    id_token: str(raw.id_token) ?? str(secrets.idToken),
  })
}

/** Decode stored OpenAI ChatGPT OAuth tokens into runtime provider auth. */
export function readOpenAIOAuthAuth(secrets: AuthSecretBag): ProviderAuth | null {
  const accessToken = str(secrets.accessToken)
  if (!accessToken) return null
  const accountId = str(secrets.accountId)
  const fedramp = bool(secrets.fedramp)
  return {
    kind: "oauth",
    token: accessToken,
    baseUrl: OPENAI_CHATGPT_BASE_URL,
    headers: {
      ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
      ...(fedramp ? { "X-OpenAI-Fedramp": "true" } : {}),
    },
  }
}

function stringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((item) => typeof item === "string") ? v : undefined
}

/** Inspect stored OpenAI OAuth metadata without exposing bearer tokens. */
export function inspectOpenAIOAuthCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  return {
    usable: Boolean(str(secrets.accessToken)),
    expiresAt: num(secrets.expiresAt),
    hasRefreshToken: Boolean(str(secrets.refreshToken)),
    accountId: str(secrets.accountId) ?? str(secrets.userId),
    scopes: stringArray(secrets.scopes),
  }
}

export const openAIOAuthLogin: OAuthLoginProvider = {
  ...OPENAI_CHATGPT_OAUTH,
  config() {
    return {
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      redirectUri: OPENAI_DEVICE_REDIRECT_URI,
      scopes: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "api.connectors.read",
        "api.connectors.invoke",
      ],
      authorizeParams: {
        id_token_add_organizations: "true",
        codex_cli_simplified_flow: "true",
        originator: "codex_cli_rs",
      },
      tokenRequestEncoding: "form",
      tokenRequestIncludesState: false,
    }
  },
  deviceCode: {
    request: requestOpenAIDeviceCode,
    complete: completeOpenAIDeviceCodeLogin,
  },
  buildCredential: buildOpenAIOAuthCredential,
  readAuth: readOpenAIOAuthAuth,
  inspectCredential: inspectOpenAIOAuthCredential,
  refreshCredential: refreshOpenAIOAuthCredential,
}

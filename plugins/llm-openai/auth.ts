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
  AuthSecretBag,
  OAuthLoginProvider,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const OPENAI_API_KEY_AUTH = {
  serviceId: "openai-api-key",
  displayName: "OpenAI API Key",
} as const

export const OPENAI_CHATGPT_OAUTH = {
  serviceId: "openai-chatgpt-oauth",
  displayName: "OpenAI ChatGPT (OAuth)",
} as const

const OPENAI_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api/codex"

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

export const openAIApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENAI_API_KEY_AUTH,
  buildCredential: buildOpenAIApiKeyCredential,
  readApiKey: readOpenAIApiKey,
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

export const openAIOAuthLogin: OAuthLoginProvider = {
  ...OPENAI_CHATGPT_OAUTH,
  config() {
    return {
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      tokenUrl: "https://auth.openai.com/oauth/token",
      redirectUri: "http://localhost:1455/auth/callback",
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
  buildCredential: buildOpenAIOAuthCredential,
  readAuth: readOpenAIOAuthAuth,
}

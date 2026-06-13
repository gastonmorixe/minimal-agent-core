/**
 * Anthropic plan-auth OAuth login strategy.
 *
 * Core owns the generic PKCE/manual-paste protocol. This file owns the
 * Anthropic-specific endpoints, scopes, authorize-query extras, and the
 * credential-store codec used after the token exchange.
 *
 * @module llm/providers/anthropic/oauth-login
 */

import type {
  AuthSecretBag,
  OAuthLoginBuildResult,
  OAuthLoginConfig,
  OAuthLoginProvider,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

/**
 * Manual-flow redirect URL. Matches the prod config in Claude Code:
 * `https://platform.claude.com/oauth/code/callback`.
 */
export const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback"

/**
 * Default authorize endpoint for Claude.ai sign-in. The `claude.com/cai/...`
 * bounce path attributes CLI sign-ins correctly before redirecting onward.
 */
export const CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"

/**
 * OAuth scopes requested at login time. This is the union of the Claude.ai and
 * Console scope sets so one login works for both subscription types.
 */
export const LOGIN_SCOPES: readonly string[] = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const

export const ANTHROPIC_PLAN_OAUTH = {
  id: "anthropic-plan-oauth",
  name: "Anthropic Plan (OAuth)",
} as const

const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const DEFAULT_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export interface AnthropicTokenExchangeResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  scope?: string
  account?: {
    uuid: string
    email_address: string
  }
  organization?: {
    uuid: string
  }
}

export interface AnthropicCredentialsData {
  claudeAiOauth: {
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    scopes?: string[]
  }
  oauthAccount?: {
    accountUuid?: string
    organizationUuid?: string
    emailAddress?: string
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = str(obj[key])
  if (!value) throw new Error(`Anthropic OAuth token response missing ${key}`)
  return value
}

function requiredNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key]
  if (typeof value !== "number") throw new Error(`Anthropic OAuth token response missing ${key}`)
  return value
}

function parseTokenResponse(resp: Record<string, unknown>): AnthropicTokenExchangeResponse {
  const accountRaw = resp.account
  const organizationRaw = resp.organization
  const account = isRecord(accountRaw)
    ? {
        uuid: requiredString(accountRaw, "uuid"),
        email_address: requiredString(accountRaw, "email_address"),
      }
    : undefined
  const organization = isRecord(organizationRaw)
    ? { uuid: requiredString(organizationRaw, "uuid") }
    : undefined

  return {
    access_token: requiredString(resp, "access_token"),
    refresh_token: requiredString(resp, "refresh_token"),
    expires_in: requiredNumber(resp, "expires_in"),
    scope: str(resp.scope),
    ...(account ? { account } : {}),
    ...(organization ? { organization } : {}),
  }
}

/** Encode Anthropic OAuth credentials into this provider's opaque secret bag. */
export function anthropicCredentialsToSecrets(data: AnthropicCredentialsData): AuthSecretBag {
  const bag: AuthSecretBag = { tokenType: "oauth" }
  const o = data.claudeAiOauth
  if (o.accessToken !== undefined) bag.accessToken = o.accessToken
  if (o.refreshToken !== undefined) bag.refreshToken = o.refreshToken
  if (o.expiresAt !== undefined) bag.expiresAt = o.expiresAt
  if (o.scopes !== undefined) bag.scopes = o.scopes
  const a = data.oauthAccount
  if (a) {
    if (a.accountUuid !== undefined) bag.accountUuid = a.accountUuid
    if (a.organizationUuid !== undefined) bag.organizationUuid = a.organizationUuid
    if (a.emailAddress !== undefined) bag.emailAddress = a.emailAddress
  }
  return bag
}

/** Build the host-persistable credential write from an Anthropic OAuth token response. */
export function buildAnthropicOAuthCredential(raw: Record<string, unknown>): OAuthLoginBuildResult {
  const resp = parseTokenResponse(raw)
  const expiresAt = Date.now() + resp.expires_in * 1000
  const scopes = (resp.scope ?? "").split(" ").filter(Boolean)

  const account = resp.account
  const organization = resp.organization
  const credentials: AnthropicCredentialsData = {
    claudeAiOauth: {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresAt,
      scopes,
    },
  }
  if (account || organization) {
    credentials.oauthAccount = {
      ...(account ? { accountUuid: account.uuid, emailAddress: account.email_address } : {}),
      ...(organization ? { organizationUuid: organization.uuid } : {}),
    }
  }

  return {
    credential: {
      serviceId: ANTHROPIC_PLAN_OAUTH.id,
      displayName: ANTHROPIC_PLAN_OAUTH.name,
      secrets: anthropicCredentialsToSecrets(credentials),
    },
    result: {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresAt,
      scopes,
      ...(account ? { account: { uuid: account.uuid, emailAddress: account.email_address } } : {}),
      ...(organization ? { organization: { uuid: organization.uuid } } : {}),
    },
  }
}

/** Resolve Anthropic OAuth login settings, including supported env overrides. */
export function anthropicOAuthLoginConfig(): OAuthLoginConfig {
  const clientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim() || DEFAULT_OAUTH_CLIENT_ID
  return {
    clientId,
    tokenUrl: DEFAULT_OAUTH_TOKEN_URL,
    authorizeUrl: CLAUDE_AI_AUTHORIZE_URL,
    redirectUri: MANUAL_REDIRECT_URL,
    scopes: LOGIN_SCOPES,
    authorizeParams: { code: "true" },
    loginHintParam: "login_hint",
  }
}

export const anthropicOAuthLogin: OAuthLoginProvider = {
  serviceId: ANTHROPIC_PLAN_OAUTH.id,
  displayName: ANTHROPIC_PLAN_OAUTH.name,
  config: anthropicOAuthLoginConfig,
  buildCredential: buildAnthropicOAuthCredential,
}

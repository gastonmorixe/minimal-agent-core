/**
 * Auth module: credential resolution + OAuth token refresh.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  STORAGE: fully independent, no sharing with the official `claude` CLI
 * ───────────────────────────────────────────────────────────────────────────
 * minimal-agent stores credentials in its OWN file via {@link AuthStore}
 * (`~/.minimal-agent/auth.jsonc`). It does NOT touch the macOS Keychain entry
 * `Claude Code-credentials` nor the `oauthAccount` block in `~/.claude.json`
 * that the official CLI uses — that sharing is gone. The two tools log in,
 * refresh, and log out completely independently.
 *
 * This module is, for now, the sole consumer of the generic auth store and
 * effectively plays the role of the *one* provider that exists today:
 *
 *     id   = "anthropic-plan-oauth"        (the slug an auth plugin will match)
 *     name = "Anthropic Plan (OAuth)"      (the human label shown in a TUI)
 *
 * i.e. Anthropic, authenticated via the Claude Pro/Max subscription OAuth
 * flow. When auth becomes a plugin surface (multiple providers, each with its
 * own credential mechanics), the provider-specific bits below — the secret-bag
 * shape, the refresh grant, the scopes — move into a plugin keyed by that
 * slug, and {@link AuthStore} stays exactly as it is. Everything here is
 * written with that future in mind: the store never sees Anthropic-specific
 * fields; only this file knows how to pack/unpack the opaque secret bag.
 *
 * SECRET BAG SHAPE (private to this "provider", opaque to the store):
 *
 *     {
 *       "tokenType": "oauth" | "api-key",
 *       // oauth:
 *       "accessToken": "sk-ant-oat01-…",
 *       "refreshToken": "sk-ant-ort01-…",
 *       "expiresAt": 1774880291250,           // ms since epoch
 *       "scopes": ["user:profile", …],
 *       "subscriptionType": "max",
 *       "rateLimitTier": "default_claude_max_20x",
 *       "accountUuid": "…",
 *       "organizationUuid": "…",
 *       "displayName": "…",
 *       "emailAddress": "…",
 *       // api-key:
 *       "apiKey": "sk-ant-…"
 *     }
 *
 * Account info (uuid/org/email) used to live in `~/.claude.json`; now we
 * capture it from the OAuth token-exchange response at login time and persist
 * it in our own secret bag, so nothing depends on the official CLI's files.
 *
 * Token refresh uses the standard OAuth2 refresh_token grant against the
 * same first-party endpoint the official CLI uses (`BB6()` at
 * cli.pretty.js L129419-129489).
 *
 * @module auth
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { AuthStore, defaultAuthStore, type SecretBag } from "./auth-store.ts"
import { withLock } from "./lockfile.ts"
import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The single provider minimal-agent ships with today. `id` is the stable
 * slug a future auth plugin will claim; `name` is the display label. See the
 * module doc for the future-plugins rationale.
 */
export const ANTHROPIC_PLAN_OAUTH = {
  id: "anthropic-plan-oauth",
  name: "Anthropic Plan (OAuth)",
} as const

/**
 * Current first-party OAuth client id from Claude Code v2.1.104 source.
 */
const DEFAULT_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

/**
 * Current first-party token endpoint from Claude Code v2.1.104 source.
 */
const DEFAULT_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

/**
 * OAuth scopes requested during token refresh.
 * @see cli.pretty.js L38037-38043 (array `I_8`):
 *   l36 = "user:profile"        (L38020)
 *   BR  = "user:inference"      (L38019)
 *   plus three literal strings: user:sessions:claude_code, user:mcp_servers, user:file_upload
 *
 * These scopes are joined with " " and sent in the refresh request body.
 * The CLI uses them in `BB6()` at L129424: `scope: (K?.length ? K : I_8).join(" ")`
 */
const OAUTH_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
]

/**
 * How early (in ms) before expiry we trigger a proactive refresh.
 * The CLI checks `expiresAt` during startup in the token refresh gate
 * (`PU6()` at L468976), but doesn't have an explicit buffer — it refreshes
 * when the token is actually expired. We add 60s of buffer to avoid
 * making API calls with tokens that expire mid-request.
 */
const EXPIRY_BUFFER_MS = 60_000

/** Sanitize a provider id into a safe lockfile name component. */
function sanitizeForFilename(id: string): string {
  const sanitized = id.replace(/[^A-Za-z0-9._-]+/g, "_")
  return sanitized.length > 0 ? sanitized : "provider"
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * In-memory representation of a resolved credential, shared by `getAuth`,
 * the login installer, `--auth-status`, and the client's 401 retry path.
 *
 * This nested shape (claudeAiOauth + oauthAccount) is retained as the
 * *internal* contract those consumers were written against; it is mapped
 * to/from the flat, opaque secret bag the {@link AuthStore} persists by
 * {@link credentialsToSecrets} / {@link secretsToCredentials}. It is no
 * longer tied to any on-disk format owned by another tool.
 */
export interface CredentialsData {
  apiKey?: string
  claudeAiOauth?: {
    accessToken: string
    refreshToken?: string
    /** Milliseconds since epoch when the access token expires */
    expiresAt?: number
    scopes?: string[]
    /** "pro" | "max" | "enterprise" | "team" — cached subscription type */
    subscriptionType?: string
    /** e.g. "default_claude_max_20x" — cached rate limit tier */
    rateLimitTier?: string
  }
  oauthAccount?: {
    accountUuid?: string
    organizationUuid?: string
    displayName?: string
    emailAddress?: string
  }
}

export interface AuthResult {
  type: "api-key" | "oauth"
  token: string
  accountUuid?: string
  organizationUuid?: string
  /**
   * Callable refresh function for 401 retry. When the API returns 401,
   * client.ts calls this to get a fresh token, then retries the request.
   * Mirrors the CLI's `onAuth401` handler pattern (L751090-751112).
   */
  refresh?: () => Promise<AuthResult>
}

export interface TokenRefreshResult {
  accessToken: string
  refreshToken: string
  /** Milliseconds since epoch */
  expiresAt: number
}

export interface OAuthRefreshConfig {
  clientId: string
  tokenUrl: string
}

// ---------------------------------------------------------------------------
// Secret-bag <-> CredentialsData mapping (the "provider" codec)
// ---------------------------------------------------------------------------

/**
 * Pack {@link CredentialsData} into the flat secret bag the store persists.
 * `undefined` fields are dropped so the JSON stays tidy. This is the only
 * place that knows the bag's field names — i.e. the provider's private wire
 * format inside the otherwise-opaque store.
 */
export function credentialsToSecrets(data: CredentialsData): SecretBag {
  const bag: SecretBag = {}
  if (data.apiKey) {
    bag.tokenType = "api-key"
    bag.apiKey = data.apiKey
    return bag
  }
  const o = data.claudeAiOauth
  bag.tokenType = "oauth"
  if (o) {
    if (o.accessToken !== undefined) bag.accessToken = o.accessToken
    if (o.refreshToken !== undefined) bag.refreshToken = o.refreshToken
    if (o.expiresAt !== undefined) bag.expiresAt = o.expiresAt
    if (o.scopes !== undefined) bag.scopes = o.scopes
    if (o.subscriptionType !== undefined) bag.subscriptionType = o.subscriptionType
    if (o.rateLimitTier !== undefined) bag.rateLimitTier = o.rateLimitTier
  }
  const a = data.oauthAccount
  if (a) {
    if (a.accountUuid !== undefined) bag.accountUuid = a.accountUuid
    if (a.organizationUuid !== undefined) bag.organizationUuid = a.organizationUuid
    if (a.displayName !== undefined) bag.displayName = a.displayName
    if (a.emailAddress !== undefined) bag.emailAddress = a.emailAddress
  }
  return bag
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined
}

/** Unpack a stored secret bag back into {@link CredentialsData}. */
export function secretsToCredentials(bag: SecretBag): CredentialsData {
  if (bag.tokenType === "api-key" || (bag.apiKey != null && bag.tokenType !== "oauth")) {
    return { apiKey: str(bag.apiKey) ?? "" }
  }
  const data: CredentialsData = {
    claudeAiOauth: {
      accessToken: str(bag.accessToken) ?? "",
      refreshToken: str(bag.refreshToken),
      expiresAt: num(bag.expiresAt),
      scopes: strArr(bag.scopes),
      subscriptionType: str(bag.subscriptionType),
      rateLimitTier: str(bag.rateLimitTier),
    },
  }
  const accountUuid = str(bag.accountUuid)
  const organizationUuid = str(bag.organizationUuid)
  const displayName = str(bag.displayName)
  const emailAddress = str(bag.emailAddress)
  if (accountUuid || organizationUuid || displayName || emailAddress) {
    data.oauthAccount = { accountUuid, organizationUuid, displayName, emailAddress }
  }
  return data
}

// ---------------------------------------------------------------------------
// Store-backed read/write/clear for the current provider
// ---------------------------------------------------------------------------

/**
 * Read the current provider's credentials from the auth store, or `null` when
 * not logged in. Used by `getAuth`, `--auth-status`, and the client's
 * 401 peer-detection path.
 */
export function readCredentials(store: AuthStore = defaultAuthStore()): CredentialsData | null {
  const bag = store.getSecrets(ANTHROPIC_PLAN_OAUTH.id, ANTHROPIC_PLAN_OAUTH.name)
  if (!bag) return null
  return secretsToCredentials(bag)
}

/** Persist the current provider's credentials into the auth store. */
export function writeCredentials(
  data: CredentialsData,
  store: AuthStore = defaultAuthStore(),
): void {
  store.set(ANTHROPIC_PLAN_OAUTH.id, ANTHROPIC_PLAN_OAUTH.name, credentialsToSecrets(data))
}

/**
 * Remove the current provider's credentials (logout). Returns `true` if an
 * entry was removed, `false` if there was nothing to remove (idempotent).
 */
export function clearCredentials(store: AuthStore = defaultAuthStore()): boolean {
  return store.remove(ANTHROPIC_PLAN_OAUTH.id, ANTHROPIC_PLAN_OAUTH.name)
}

/**
 * Build the OAuth refresh endpoint config, honoring the optional client ID override.
 */
export function getOauthRefreshConfig(): OAuthRefreshConfig {
  const clientId = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim()

  return {
    clientId: clientId || DEFAULT_OAUTH_CLIENT_ID,
    tokenUrl: DEFAULT_OAUTH_TOKEN_URL,
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh an expired OAuth access token using the refresh_token grant.
 *
 * Mirrors `BB6()` in cli.pretty.js (L129419-129489):
 *   1. POST to TOKEN_URL with grant_type=refresh_token
 *   2. Parse response: { access_token, refresh_token?, expires_in }
 *   3. Compute expiresAt = Date.now() + expires_in * 1000
 *
 * The response may include a new refresh_token (token rotation), or the
 * same one if the server doesn't rotate. We fall back to the original
 * refresh token if the response doesn't include one.
 *
 * @param refreshToken OAuth refresh token from the credential store.
 * @param networkClient Network client used for the token endpoint request.
 * @returns Updated credential data.
 */
export async function refreshAccessToken(
  refreshToken: string,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<TokenRefreshResult> {
  const oauth = getOauthRefreshConfig()
  const requestBody = JSON.stringify({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: oauth.clientId,
    scope: OAUTH_SCOPES.join(" "),
  })
  const response = await networkClient.request({
    label: "oauth.refresh",
    method: "POST",
    url: oauth.tokenUrl,
    headers: { "content-type": "application/json" },
    body: requestBody,
    capture: {
      requestBody: "[REDACTED OAUTH REFRESH BODY]",
      responseBody: false,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Token refresh failed (${response.status}): ${body}`)
  }

  const data = await response.json<{
    access_token: string
    refresh_token?: string
    expires_in: number
  }>()

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

// ---------------------------------------------------------------------------
// getAuth: read credentials, auto-refresh if expired
// ---------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link getAuth}. Production callers can omit
 * this; tests pass mocks to drive store/refresh behavior deterministically.
 *
 * `read`/`write` operate on {@link CredentialsData}. Their defaults read and
 * write the auth store for the current provider; tests inject in-memory
 * fakes and never touch the filesystem.
 */
export interface GetAuthDeps {
  read?: (providerId: string) => CredentialsData | null
  write?: (data: CredentialsData, providerId: string) => void
  refresh?: (refreshToken: string) => Promise<TokenRefreshResult>
}

/**
 * Resolve credentials and return an `AuthResult` with a token plus a lazy
 * `refresh` closure. Re-reads the store on every refresh so that
 * cross-process rotation (another minimal-agent process refreshing under the
 * shared advisory lock) is honored.
 *
 * @param providerId Provider slug to resolve (defaults to the one provider we
 *   ship with). Also used to key the per-provider refresh lockfile.
 */
export async function getAuth(
  providerId: string = ANTHROPIC_PLAN_OAUTH.id,
  deps: GetAuthDeps = {},
): Promise<AuthResult> {
  if (process.env.MINIMAL_AGENT_TEST_AUTH === "1") {
    const testEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    if (!testEnv) {
      throw new Error("MINIMAL_AGENT_TEST_AUTH is only allowed in test")
    }
    return { type: "oauth", token: "test-token", accountUuid: "test-account" }
  }

  const read = deps.read ?? ((_id: string) => readCredentials())
  const write = deps.write ?? ((data: CredentialsData, _id: string) => writeCredentials(data))
  const refreshFn = deps.refresh ?? refreshAccessToken
  const service = providerId

  const creds = read(service)
  if (!creds) {
    throw new Error(
      "No minimal-agent credentials found (~/.minimal-agent/auth.jsonc). " +
        "Run `minimal-agent --login` to sign in.",
    )
  }

  // API key path (no refresh needed)
  if (creds.apiKey) {
    return { type: "api-key", token: creds.apiKey }
  }

  const oauth = creds.claudeAiOauth
  if (!oauth?.accessToken) {
    throw new Error(
      "No OAuth access token found in the auth store. Run `minimal-agent --login` to sign in.",
    )
  }

  const accountUuid = creds.oauthAccount?.accountUuid
  const organizationUuid = creds.oauthAccount?.organizationUuid

  // Build a refresh closure that re-reads the store on every call AND
  // coordinates with other processes via a cross-process advisory lock.
  //
  // Why re-read instead of using the closed-over `oauth` snapshot:
  //   1. After a successful refresh the server rotates the refresh token;
  //      our snapshot still holds the OLD one. A second refresh later in
  //      the same long-running session would resend the old RT and get
  //      `invalid_grant` from the server.
  //   2. Another minimal-agent process may rotate the store entry while we
  //      are idle. Reading fresh picks that up.
  // Both modes produce the same "Refresh token not found or invalid"
  // 400 from /v1/oauth/token; both are fixed by reading current state.
  //
  // Why the lockfile (May 2026): with N concurrent agent processes
  // sharing one store entry, server-side refresh-token rotation makes
  // every successful refresh by ANY process invalidate the access tokens
  // cached by the OTHER N-1. They each 401 next, refresh in parallel,
  // and the storm never settles. The fix is to serialize refreshes
  // through a lockfile in `~/.minimal-agent/.refresh-<provider>.lock`:
  //
  //   1. Acquire the lock (or time out at 5s → fall through to refresh
  //      anyway; better to thrash than block forever).
  //   2. RE-READ the store UNDER the lock. If the access token there
  //      differs from what we last issued, another process just
  //      finished refreshing — use their fresh token, no server call,
  //      no rotation.
  //   3. Otherwise actually refresh, write the store.
  //
  // For 100 agents at typical traffic this collapses N concurrent
  // refreshes per "true expiry" event into 1.
  //
  // `lastIssuedToken` is the closure-captured "what this auth pipe
  // most recently observed/issued". Initialized to the first read in
  // getAuth, advanced on every successful refresh AND on every
  // skip-via-store.
  let lastIssuedToken = oauth.accessToken
  let lastIssuedRefreshToken = oauth.refreshToken
  let lastIssuedExpiresAt = oauth.expiresAt ?? 0
  const lockPath = join(
    homedir(),
    ".minimal-agent",
    `.refresh-${sanitizeForFilename(service)}.lock`,
  )

  const doRefreshUnlocked = async (): Promise<AuthResult> => {
    const current = read(service) ?? creds
    const currentOauth = current.claudeAiOauth

    // The store may already hold a fresher token (another process refreshed
    // while we were waiting on the lock). Use it directly — no server
    // round-trip, no rotation, no race propagation.
    const storeHasNewerToken =
      currentOauth?.accessToken &&
      currentOauth.accessToken !== lastIssuedToken &&
      (currentOauth.refreshToken != null
        ? currentOauth.refreshToken !== lastIssuedRefreshToken
        : currentOauth.expiresAt != null && currentOauth.expiresAt > lastIssuedExpiresAt)

    if (storeHasNewerToken) {
      lastIssuedToken = currentOauth.accessToken
      lastIssuedRefreshToken = currentOauth.refreshToken
      lastIssuedExpiresAt = currentOauth.expiresAt ?? 0
      return {
        type: "oauth",
        token: currentOauth.accessToken,
        accountUuid: current.oauthAccount?.accountUuid ?? accountUuid,
        organizationUuid: current.oauthAccount?.organizationUuid ?? organizationUuid,
        refresh: doRefresh,
      }
    }

    if (!currentOauth?.refreshToken) {
      throw new Error("No refresh token available. Run `minimal-agent --login` to sign in.")
    }

    let refreshed: TokenRefreshResult
    try {
      refreshed = await refreshFn(currentOauth.refreshToken)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("invalid_grant")) {
        throw new Error(
          "Refresh token rejected by server (invalid_grant). " +
            "Run `minimal-agent --login` to re-login.",
          { cause: e },
        )
      }
      throw e
    }

    // Update the store with new tokens so other processes see them too.
    const updated: CredentialsData = {
      ...current,
      claudeAiOauth: {
        ...currentOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      },
    }
    write(updated, service)
    lastIssuedToken = refreshed.accessToken
    lastIssuedRefreshToken = refreshed.refreshToken
    lastIssuedExpiresAt = refreshed.expiresAt

    return {
      type: "oauth",
      token: refreshed.accessToken,
      accountUuid: current.oauthAccount?.accountUuid ?? accountUuid,
      organizationUuid: current.oauthAccount?.organizationUuid ?? organizationUuid,
      refresh: doRefresh,
    }
  }

  const doRefresh = async (): Promise<AuthResult> => {
    // Skip the lock entirely when fakes are injected (tests don't want to
    // touch the real filesystem at all).
    if (deps.read || deps.write || deps.refresh) {
      return await doRefreshUnlocked()
    }
    const result = await withLock(lockPath, { timeoutMs: 5000 }, doRefreshUnlocked)
    if (result.ok) return result.value
    // Lock acquisition timed out (5s without progress). Fall through to
    // an unlocked refresh — uncoordinated, but better than blocking
    // forever. The store re-read in `doRefreshUnlocked` still gives us
    // the store-first benefit if another process happened to finish
    // writing while we were waiting.
    return await doRefreshUnlocked()
  }

  // Proactively refresh if token is expired or about to expire
  const needsRefresh = oauth.expiresAt != null && oauth.expiresAt - Date.now() < EXPIRY_BUFFER_MS

  if (needsRefresh && oauth.refreshToken) {
    return doRefresh()
  }

  return {
    type: "oauth",
    token: oauth.accessToken,
    accountUuid,
    organizationUuid,
    refresh: doRefresh,
  }
}

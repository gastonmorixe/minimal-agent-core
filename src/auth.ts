/**
 * Auth module: credential-store access + OAuth token refresh.
 *
 * Where credentials live is a platform decision delegated to
 * {@link ./credential-store.ts}:
 *
 *   - macOS → system Keychain (`Claude Code-credentials` generic password)
 *   - Linux / WSL / others → `~/.claude/.credentials.json` (mode 0600)
 *
 * Both backends agree on the stored JSON shape (`CredentialsData`):
 *
 *     {
 *       claudeAiOauth: {
 *         accessToken: "sk-ant-oat01-...",
 *         refreshToken: "sk-ant-ort01-...",
 *         expiresAt: 1774880291250,        // ms since epoch
 *         scopes: ["user:profile", ...],
 *         subscriptionType: "max",
 *         rateLimitTier: "default_claude_max_20x"
 *       }
 *     }
 *
 * Note: `oauthAccount` (containing accountUuid) is stored in `~/.claude.json`,
 * NOT in the credential store. Older keychain entries may have inlined it;
 * we still read it from there as a fallback. The CLI reads accountUuid from
 * its config via `y_()` → `j8().oauthAccount` (L240111-240112).
 *
 * Token refresh uses the standard OAuth2 refresh_token grant, hitting
 * the same endpoint the CLI uses: `BB6()` at L129419-129489.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import {
  type CredentialsData,
  readCredentials as defaultReadCredentials,
  writeCredentials as defaultWriteCredentials,
} from "./credential-store.ts"
import { withLock } from "./lockfile.ts"
import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"

export type { CredentialsData } from "./credential-store.ts"
export {
  readCredentials,
  writeCredentials,
  deleteCredentials,
  pickCredentialStore,
  type CredentialStore,
} from "./credential-store.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
// OAuth refresh config
// ---------------------------------------------------------------------------

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
 * Read accountUuid from ~/.claude.json.
 *
 * In v2.1.87, the CLI stores oauthAccount data in its config file
 * (the path resolved by `aM()` at L45457-45462), NOT in the credential
 * store. The store only holds `claudeAiOauth` (tokens + subscription info).
 *
 * The config path is `~/.claude.json` by default (or `~/.claude/.config.json`
 * if it exists, checked at L45458). We read `oauthAccount.accountUuid` from
 * there, which is needed for the metadata.user_id field.
 *
 * @see cli.pretty.js L240111-240112: `y_() → sH() ? j8().oauthAccount : void 0`
 */
function readAccountUuidFromConfig(): string | undefined {
  try {
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const raw = readFileSync(join(process.env.HOME ?? "", ".claude.json"), "utf-8")
    const config = JSON.parse(raw) as {
      oauthAccount?: { accountUuid?: string; organizationUuid?: string }
    }
    return config.oauthAccount?.accountUuid
  } catch {
    return undefined
  }
}

/**
 * Injectable dependencies for {@link getAuth}. Production callers can omit
 * this; tests pass mocks to drive store/refresh behavior deterministically.
 */
export interface GetAuthDeps {
  read?: () => CredentialsData | null
  write?: (data: CredentialsData) => void
  refresh?: (refreshToken: string) => Promise<TokenRefreshResult>
  /**
   * Override the lockfile path. Tests use this to avoid touching the
   * real `~/.minimal-agent/.refresh-credentials.lock`.
   */
  lockPath?: string
}

/**
 * Get authentication credentials, auto-refreshing if the token is expired.
 *
 * Flow:
 *   1. Read credential store → claudeAiOauth.accessToken + expiresAt
 *   2. Read ~/.claude.json → oauthAccount.accountUuid
 *   3. If expiresAt is within EXPIRY_BUFFER_MS of now, refresh proactively
 *   4. Return AuthResult with a `refresh` closure for 401 retry
 *
 * The refresh closure updates the credential store with new tokens so
 * subsequent calls (and other processes reading the store) get the
 * fresh token.
 *
 * Resolves OAuth credentials and returns an `AuthResult` with a token
 * plus a lazy `refresh` closure. Re-reads the store on every refresh
 * so cross-process rotation (e.g. by the official `claude` CLI) is
 * honored.
 */
export async function getAuth(deps: GetAuthDeps = {}): Promise<AuthResult> {
  if (process.env.MINIMAL_AGENT_TEST_AUTH === "1") {
    const testEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    if (!testEnv) {
      throw new Error("MINIMAL_AGENT_TEST_AUTH is only allowed in test")
    }
    return { type: "oauth", token: "test-token", accountUuid: "test-account" }
  }

  const read = deps.read ?? defaultReadCredentials
  const write = deps.write ?? defaultWriteCredentials
  const refreshFn = deps.refresh ?? refreshAccessToken

  const creds = read()
  if (!creds) {
    throw new Error("No credentials found. Run `minimal-agent --login` (or `claude`) to sign in.")
  }

  // API key path (no refresh needed)
  if (creds.apiKey) {
    return { type: "api-key", token: creds.apiKey }
  }

  const oauth = creds.claudeAiOauth
  if (!oauth?.accessToken) {
    throw new Error("No OAuth access token found. Run `minimal-agent --login` to sign in.")
  }

  // accountUuid: try credential store first (older versions inlined it),
  // fall back to ~/.claude.json (where current CLI versions store it).
  const accountUuid = creds.oauthAccount?.accountUuid ?? readAccountUuidFromConfig()
  const organizationUuid = creds.oauthAccount?.organizationUuid

  // Build a refresh closure that re-reads the store on every call AND
  // coordinates with other processes via a cross-process advisory lock.
  //
  // Why re-read instead of using the closed-over `oauth` snapshot:
  //   1. After a successful refresh the server rotates the refresh token;
  //      our snapshot still holds the OLD one. A second refresh later in
  //      the same long-running session would resend the old RT and get
  //      `invalid_grant` from the server.
  //   2. Another process (e.g. the official `claude` CLI) may rotate the
  //      store entry while we are idle. Reading fresh picks that up.
  // Both modes produce the same "Refresh token not found or invalid"
  // 400 from /v1/oauth/token; both are fixed by reading current state.
  //
  // Why the lockfile (May 2026): with N concurrent agent processes
  // sharing one credential entry, server-side refresh-token rotation
  // makes every successful refresh by ANY process invalidate the access
  // tokens cached by the OTHER N-1. They each 401 next, refresh in
  // parallel, and the storm never settles. With 100s of agents the
  // symptom is a constant `󰌾 Auth refreshed, resuming...` flash in every
  // live area. Net-dbg trace from session c0ab6ba6: 24/105 requests
  // (23%) returned 401 with 1:1 refresh ratio. The fix is to serialize
  // refreshes through a lockfile in
  // `~/.minimal-agent/.refresh-credentials.lock`:
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
  // refreshes per "true expiry" event into 1 — steady-state refresh
  // rate drops from O(agents × traffic) to O(traffic / token_TTL).
  //
  // `lastIssuedToken` is the closure-captured "what this auth pipe
  // most recently observed/issued". Initialized to the first read in
  // getAuth, advanced on every successful refresh AND on every
  // skip-via-store. The compare in step 2 uses it as the "is the
  // store newer than what I have?" signal. Without `lastIssuedToken`
  // we'd compare against `oauth.accessToken` (frozen at session start)
  // and incorrectly classify our own already-issued refresh as "newer
  // than us".
  let lastIssuedToken = oauth.accessToken
  let lastIssuedRefreshToken = oauth.refreshToken
  let lastIssuedExpiresAt = oauth.expiresAt ?? 0
  const lockPath = deps.lockPath ?? join(homedir(), ".minimal-agent", ".refresh-credentials.lock")

  const doRefreshUnlocked = async (): Promise<AuthResult> => {
    const current = read() ?? creds
    const currentOauth = current.claudeAiOauth

    // Store may already hold a fresher token (another process refreshed
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
      throw new Error(
        "No refresh token available. Run `minimal-agent --login` (or `claude`) to sign in.",
      )
    }

    let refreshed: TokenRefreshResult
    try {
      refreshed = await refreshFn(currentOauth.refreshToken)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("invalid_grant")) {
        throw new Error(
          "Refresh token rejected by server (invalid_grant). " +
            "Run `minimal-agent --login` (or `claude`) to re-login.",
          { cause: e },
        )
      }
      throw e
    }

    // Update credential store with new tokens so other processes see them too
    const updated: CredentialsData = {
      ...current,
      claudeAiOauth: {
        ...currentOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      },
    }
    write(updated)
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
    // Skip the lock entirely under the test-only env flag (some tests
    // inject fake `read`/`write`/`refresh` deps and don't want to
    // touch the real filesystem at all).
    if (deps.read || deps.write || deps.refresh) {
      return await doRefreshUnlocked()
    }
    const result = await withLock(lockPath, { timeoutMs: 5000 }, doRefreshUnlocked)
    if (result.ok) return result.value
    // Lock acquisition timed out (5s without progress). Fall through to
    // an unlocked refresh — uncoordinated, but better than blocking
    // forever. The store re-read in `doRefreshUnlocked` still gives
    // us the keychain-first benefit if another process happened to
    // finish writing while we were waiting.
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

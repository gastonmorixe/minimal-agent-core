/**
 * Auth module: macOS Keychain access + OAuth token refresh.
 *
 * The Claude Code CLI stores credentials in the macOS Keychain under a
 * service name constructed by `HE()` (cli.pretty.js L129869-129875):
 *
 *     `Claude Code${OAUTH_FILE_SUFFIX}${suffix}${configDirHash}`
 *
 * For standard first-party (claude.ai) OAuth, OAUTH_FILE_SUFFIX is "" and
 * the suffix is "-credentials" (var `Z_6` at L129905), giving us:
 *
 *     "Claude Code-credentials"
 *
 * The keychain entry is read via `security find-generic-password` using the
 * current $USER as the account name (function `fB9()` at L238740-238761).
 *
 * The stored JSON has this shape (confirmed via `security find-generic-password -s "Claude Code-credentials" -w`):
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
 * Note: `oauthAccount` (containing accountUuid) is stored in ~/.claude.json,
 * NOT in the keychain. This was confirmed by inspecting the keychain entry
 * which only has `claudeAiOauth` at the top level. The CLI reads accountUuid
 * from its config via `y_()` → `j8().oauthAccount` (L240111-240112).
 *
 * Token refresh uses the standard OAuth2 refresh_token grant, hitting
 * the same endpoint the CLI uses: `BB6()` at L129419-129489.
 */

import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keychain service name for standard first-party OAuth.
 * Constructed by `HE("-credentials")` at L238742 which calls `HE()` at L129869.
 * For non-custom CLAUDE_CONFIG_DIR installs, this is always "Claude Code-credentials".
 */
const KEYCHAIN_SERVICE = "Claude Code-credentials"

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

/**
 * Shape of the JSON stored in the macOS Keychain under "Claude Code-credentials".
 *
 * The CLI writes this via its credential store backend (L238956-238964 for
 * plaintext fallback, or keychain backend `BD7` at L238747-238758 for macOS).
 * Only `claudeAiOauth` is stored in the keychain. `oauthAccount` data lives
 * in ~/.claude.json and is NOT part of the keychain entry (verified empirically).
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
  /**
   * May be present in some keychain entries (older CLI versions stored it here),
   * but in v2.1.87 this lives in ~/.claude.json instead.
   */
  oauthAccount?: {
    accountUuid?: string
    organizationUuid?: string
    displayName?: string
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
// Keychain read/write
// ---------------------------------------------------------------------------

/**
 * Read credentials from the macOS Keychain.
 *
 * Uses `security find-generic-password -s <service> -w` which prints
 * the password (the stored JSON blob) to stdout. This matches the CLI's
 * `fB9()` function at L238740-238761.
 *
 * The `-a` (account) flag is NOT used here because the CLI's stored entry
 * uses the $USER at write time, and `-w` without `-a` works when there's
 * only one entry for the service. The CLI itself uses `-a $USER` for reads
 * (L238806), but omitting it is equivalent on single-user machines.
 */
export function readKeychain(service: string = KEYCHAIN_SERVICE): CredentialsData | null {
  const result = Bun.spawnSync(["security", "find-generic-password", "-s", service, "-w"])

  if (result.exitCode !== 0) return null

  const raw = result.stdout.toString().trim()
  if (!raw) return null

  try {
    return JSON.parse(raw) as CredentialsData
  } catch {
    return null
  }
}

/**
 * Write credentials back to the macOS Keychain.
 *
 * Used after a token refresh to persist the new access/refresh tokens.
 * The CLI does this in its credential store backend — we replicate it
 * with delete-then-add because `security` doesn't support in-place updates.
 */
export function writeKeychain(data: CredentialsData, service: string = KEYCHAIN_SERVICE): void {
  const user = process.env.USER ?? Bun.spawnSync(["whoami"]).stdout.toString().trim()
  const json = JSON.stringify(data)

  // Delete existing entry (ignore errors if it doesn't exist)
  Bun.spawnSync(["security", "delete-generic-password", "-a", user, "-s", service])

  // Add new entry
  const result = Bun.spawnSync([
    "security",
    "add-generic-password",
    "-a",
    user,
    "-s",
    service,
    "-w",
    json,
  ])

  if (result.exitCode !== 0) {
    throw new Error(`Failed to write keychain: ${result.stderr.toString()}`)
  }
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
 * Read accountUuid from ~/.claude.json.
 *
 * In v2.1.87, the CLI stores oauthAccount data in its config file
 * (the path resolved by `aM()` at L45457-45462), NOT in the keychain.
 * The keychain only stores `claudeAiOauth` (tokens + subscription info).
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
 * Get authentication credentials, auto-refreshing if the token is expired.
 *
 * Flow:
 *   1. Read keychain → get claudeAiOauth.accessToken + expiresAt
 *   2. Read ~/.claude.json → get oauthAccount.accountUuid
 *   3. If expiresAt is within EXPIRY_BUFFER_MS of now, refresh proactively
 *   4. Return AuthResult with a `refresh` closure for 401 retry
 *
 * The refresh closure updates the keychain with new tokens so subsequent
 * calls (and other processes reading the keychain) get the fresh token.
 */
/**
 * Injectable dependencies for {@link getAuth}. Production callers can omit
 * this; tests pass mocks to drive keychain/refresh behavior deterministically.
 */
export interface GetAuthDeps {
  read?: (service: string) => CredentialsData | null
  write?: (data: CredentialsData, service: string) => void
  refresh?: (refreshToken: string) => Promise<TokenRefreshResult>
}

/**
 * Resolve OAuth credentials and return an `AuthResult` with a token plus a
 * lazy `refresh` closure. Re-reads the keychain on every refresh so that
 * cross-process rotation (e.g. by the official `claude` CLI) is honored.
 */
export async function getAuth(
  service: string = KEYCHAIN_SERVICE,
  deps: GetAuthDeps = {},
): Promise<AuthResult> {
  if (process.env.MINIMAL_AGENT_TEST_AUTH === "1") {
    const testEnv = process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
    if (!testEnv) {
      throw new Error("MINIMAL_AGENT_TEST_AUTH is only allowed in test")
    }
    return { type: "oauth", token: "test-token", accountUuid: "test-account" }
  }

  const read = deps.read ?? readKeychain
  const write = deps.write ?? writeKeychain
  const refreshFn = deps.refresh ?? refreshAccessToken

  const creds = read(service)
  if (!creds) {
    throw new Error("No credentials in keychain. Run `claude` and log in first.")
  }

  // API key path (no refresh needed)
  if (creds.apiKey) {
    return { type: "api-key", token: creds.apiKey }
  }

  const oauth = creds.claudeAiOauth
  if (!oauth?.accessToken) {
    throw new Error("No OAuth access token found in keychain.")
  }

  // accountUuid: try keychain first (older versions), fall back to ~/.claude.json
  const accountUuid = creds.oauthAccount?.accountUuid ?? readAccountUuidFromConfig()
  const organizationUuid = creds.oauthAccount?.organizationUuid

  // Build a refresh closure that re-reads the keychain on every call.
  //
  // Why re-read instead of using the closed-over `oauth` snapshot:
  //   1. After a successful refresh the server rotates the refresh token;
  //      our snapshot still holds the OLD one. A second refresh later in
  //      the same long-running session would resend the old RT and get
  //      `invalid_grant` from the server.
  //   2. Another process (e.g. the official `claude` CLI) may rotate the
  //      keychain entry while we are idle. Reading fresh picks that up.
  // Both modes produce the same "Refresh token not found or invalid"
  // 400 from /v1/oauth/token; both are fixed by reading current state.
  const doRefresh = async (): Promise<AuthResult> => {
    const current = read(service) ?? creds
    const currentOauth = current.claudeAiOauth
    if (!currentOauth?.refreshToken) {
      throw new Error("No refresh token available. Run `claude` to log in.")
    }

    let refreshed: TokenRefreshResult
    try {
      refreshed = await refreshFn(currentOauth.refreshToken)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes("invalid_grant")) {
        throw new Error(
          "Refresh token rejected by server (invalid_grant). " +
            "Run `claude` and re-login to refresh credentials.",
          { cause: e },
        )
      }
      throw e
    }

    // Update keychain with new tokens so other processes see them too
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

    return {
      type: "oauth",
      token: refreshed.accessToken,
      accountUuid: current.oauthAccount?.accountUuid ?? accountUuid,
      organizationUuid: current.oauthAccount?.organizationUuid ?? organizationUuid,
      refresh: doRefresh,
    }
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

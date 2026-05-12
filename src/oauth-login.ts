/**
 * OAuth login: PKCE authorization-code flow, manual-paste variant.
 *
 * Mirrors the official `claude` CLI's OAuth flow (see
 * `cc-03312026-2.1.88/src/services/oauth/{client,index,crypto}.ts` and the
 * pretty-bundle dump at L136230 / L469290) but trimmed to the **manual paste**
 * path only:
 *
 *   1. Generate PKCE `code_verifier` (32-byte random, base64url-encoded).
 *   2. Compute `code_challenge = base64url(sha256(code_verifier))`.
 *   3. Generate `state` (32-byte random, base64url-encoded).
 *   4. Build the authorize URL with `redirect_uri = MANUAL_REDIRECT_URL`
 *      (`https://platform.claude.com/oauth/code/callback`) so the auth server
 *      shows a paste-back page instead of bouncing to a localhost listener.
 *   5. Open the user's browser at that URL (best-effort).
 *   6. User signs in, copies the displayed code in `<authorizationCode>#<state>`
 *      format from the success page, and pastes it back at our prompt.
 *   7. POST to the token endpoint with `grant_type=authorization_code`,
 *      `code`, `redirect_uri`, `client_id`, `code_verifier`, `state`.
 *   8. Persist the resulting tokens to the platform credential store
 *      (macOS Keychain or `~/.claude/.credentials.json` on Linux) and
 *      merge `oauthAccount` into `~/.claude.json` so both minimal-agent
 *      and the official CLI find the same account uuid.
 *
 * Why manual-paste only:
 *   - No localhost HTTP listener → works inside SSH, headless containers,
 *     port-restricted networks; nothing to clean up if the user Ctrl-Cs.
 *   - One code path is simpler to reason about and test.
 *   - The browser still opens automatically; the only thing the user does
 *     differently from the official CLI is paste a string instead of having
 *     the localhost callback close the loop. The trade-off is small — one
 *     copy/paste — and the simplicity gain is real.
 *
 * This module is deliberately pure-ish: I/O is taken via injectable deps
 * (`LoginDeps`) so unit tests can drive every branch deterministically.
 *
 * @module oauth-login
 */

import { createHash, randomBytes } from "node:crypto"
import {
  type CredentialsData,
  getOauthRefreshConfig,
  writeCredentials as defaultWriteCredentials,
} from "./auth.ts"
import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Manual-flow redirect URL. Matches the prod config in cli.pretty.js L55492-55493:
 *   `MANUAL_REDIRECT_URL: "https://platform.claude.com/oauth/code/callback"`
 *
 * After successful sign-in the auth server lands the user on this page,
 * which displays the authorization code in `<code>#<state>` format ready
 * to be copy-pasted back into the CLI prompt.
 */
export const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback"

/**
 * Default authorize endpoint for Claude.ai sign-in. Matches the prod config
 * `CLAUDE_AI_AUTHORIZE_URL` at L55485 (the `claude.com/cai/...` bounce path
 * that 307s to `claude.ai/oauth/authorize` so CLI sign-ins are attributed
 * to claude.com visits — that bounce is invisible to us, we just hit the
 * documented entry URL).
 */
export const CLAUDE_AI_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize"

/**
 * OAuth scopes requested at login time. We deliberately request the **union**
 * of the Claude.ai and Console scope sets so a single login works for both
 * subscription types — that mirrors `ALL_OAUTH_SCOPES` at
 * `cc-03312026-2.1.88/src/constants/oauth.ts:56`.
 *
 * Order matches the upstream constant. The token server returns the actually
 * granted scopes via the `scope` field of the response, so requesting more
 * than the user is entitled to is harmless.
 */
export const LOGIN_SCOPES: readonly string[] = [
  "org:create_api_key", // CONSOLE
  "user:profile", // both
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const

// ---------------------------------------------------------------------------
// PKCE / state helpers
// ---------------------------------------------------------------------------

/**
 * RFC 4648 §5 base64url encoding (no padding). Matches the implementation
 * at `cc-03312026-2.1.88/src/services/oauth/crypto.ts:3-9`.
 */
export function base64UrlEncode(buf: Uint8Array | Buffer): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/**
 * Random source dependency injected by tests. Production calls `randomBytes`.
 */
export type RandomBytesFn = (len: number) => Buffer

/**
 * 32-byte random PKCE `code_verifier`, base64url-encoded.
 * Matches `generateCodeVerifier()` upstream.
 */
export function generateCodeVerifier(rand: RandomBytesFn = randomBytes): string {
  return base64UrlEncode(rand(32))
}

/**
 * `code_challenge = base64url(sha256(code_verifier))`. Matches
 * `generateCodeChallenge()` upstream.
 */
export function generateCodeChallenge(verifier: string): string {
  const digest = createHash("sha256").update(verifier).digest()
  return base64UrlEncode(digest)
}

/**
 * 32-byte random `state` parameter, base64url-encoded.
 * Used for CSRF defence: the auth server echoes `state` back in the redirect
 * URL and we verify it matches.
 */
export function generateState(rand: RandomBytesFn = randomBytes): string {
  return base64UrlEncode(rand(32))
}

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

export interface BuildAuthUrlInput {
  clientId: string
  codeChallenge: string
  state: string
  /** Override the authorize URL base (defaults to claude.ai). */
  authorizeUrl?: string
  /** Override the manual redirect URL (defaults to the prod manual one). */
  redirectUri?: string
  /** Optional pre-fill email (claude.ai login form). */
  loginHint?: string
}

/**
 * Build the OAuth authorize URL the user opens in their browser.
 *
 * Replicates `buildAuthUrl()` in `services/oauth/client.ts:46-105`, with a
 * few simplifications: we always use the manual redirect URL (no port arg)
 * and never set `loginMethod` / `orgUUID` (no enterprise SSO routing yet).
 *
 * The `code=true` query param is what the upstream comments call out as
 * "tells the login page to show Claude Max upsell" — kept for parity.
 */
export function buildAuthUrl(input: BuildAuthUrlInput): string {
  const url = new URL(input.authorizeUrl ?? CLAUDE_AI_AUTHORIZE_URL)
  url.searchParams.set("code", "true")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", input.redirectUri ?? MANUAL_REDIRECT_URL)
  url.searchParams.set("scope", LOGIN_SCOPES.join(" "))
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  if (input.loginHint) url.searchParams.set("login_hint", input.loginHint)
  return url.toString()
}

// ---------------------------------------------------------------------------
// Pasted-code parsing
// ---------------------------------------------------------------------------

export type ParsedPaste =
  | { ok: true; code: string; state: string }
  | { ok: false; reason: "empty" | "malformed" }

/**
 * Parse the user-pasted callback payload.
 *
 * The success page on `MANUAL_REDIRECT_URL` shows
 * `<authorizationCode>#<state>` (matches upstream `ConsoleOAuthFlow.tsx:158`
 * comment: "Expecting format `authorizationCode#state` from the
 * authorization callback URL"). Whitespace around the paste is forgiven —
 * users hitting Enter after a paste invariably include a trailing newline.
 *
 * Some paste paths include the full callback URL by accident
 * (`https://platform.claude.com/oauth/code/callback?code=…&state=…`); we
 * accept that too by extracting the query params. A bare `?code=X&state=Y`
 * also works.
 */
export function parsePastedCode(raw: string): ParsedPaste {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, reason: "empty" }

  // URL-form paste: pull `code` and `state` from query params.
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const u = new URL(trimmed)
      const code = u.searchParams.get("code")
      const state = u.searchParams.get("state")
      if (!code || !state) return { ok: false, reason: "malformed" }
      return { ok: true, code, state }
    } catch {
      return { ok: false, reason: "malformed" }
    }
  }

  // The `<code>#<state>` format the success page renders. The auth code is
  // base64url so it never contains a literal `#`; splitting on the first `#`
  // is enough.
  const hash = trimmed.indexOf("#")
  if (hash > 0 && hash < trimmed.length - 1) {
    const code = trimmed.slice(0, hash)
    const state = trimmed.slice(hash + 1)
    if (code && state) return { ok: true, code, state }
  }

  return { ok: false, reason: "malformed" }
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface TokenExchangeInput {
  authorizationCode: string
  state: string
  codeVerifier: string
  /** Override the token URL (defaults to the value returned by getOauthRefreshConfig). */
  tokenUrl?: string
  /** Override the client id (defaults to the value returned by getOauthRefreshConfig). */
  clientId?: string
  /** Override the redirect URI sent at exchange time. MUST equal the one used in buildAuthUrl. */
  redirectUri?: string
}

/**
 * Token endpoint response shape. The server may include richer fields
 * (account info, organization info) on the success path — see
 * `services/oauth/types.ts: OAuthTokenExchangeResponse` upstream.
 */
export interface TokenExchangeResponse {
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

/**
 * Result of a successful login + persistence.
 *
 * Pulled out as its own type because tests assert against it and the CLI
 * needs to know which fields to print in the "Login successful" footer.
 */
export interface LoginInstallResult {
  accessToken: string
  refreshToken: string
  expiresAt: number
  scopes: string[]
  account?: {
    uuid: string
    emailAddress: string
  }
  organization?: {
    uuid: string
  }
}

/**
 * Exchange the pasted authorization code for tokens.
 *
 * Mirrors `exchangeCodeForTokens()` upstream. Returns the raw server response
 * shape; persistence is the caller's job (see `installCredentials`).
 *
 * @throws `Error` with a structured message on non-200. The 401 path uses
 *   the same wording the official CLI does ("Authentication failed: Invalid
 *   authorization code") so users who see it cross-referenced with web docs
 *   recognize it.
 */
export async function exchangeCodeForTokens(
  input: TokenExchangeInput,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<TokenExchangeResponse> {
  const oauth = getOauthRefreshConfig()
  const tokenUrl = input.tokenUrl ?? oauth.tokenUrl
  const clientId = input.clientId ?? oauth.clientId
  const redirectUri = input.redirectUri ?? MANUAL_REDIRECT_URL

  const body = JSON.stringify({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: input.codeVerifier,
    state: input.state,
  })

  const response = await networkClient.request({
    label: "oauth.login.exchange",
    method: "POST",
    url: tokenUrl,
    headers: { "content-type": "application/json" },
    body,
    capture: {
      // The body contains the auth code AND code_verifier; both are
      // single-use but logging them in `.net-dbg/` is needlessly risky.
      requestBody: "[REDACTED OAUTH EXCHANGE BODY]",
      responseBody: false,
    },
  })

  if (!response.ok) {
    const errBody = await response.text()
    if (response.status === 401) {
      throw new Error("Authentication failed: invalid authorization code")
    }
    throw new Error(`Token exchange failed (${response.status}): ${errBody}`)
  }

  return response.json<TokenExchangeResponse>()
}

// ---------------------------------------------------------------------------
// Persistence: keychain + ~/.claude.json
// ---------------------------------------------------------------------------

export interface InstallCredentialsDeps {
  /** Override the credential writer (tests). */
  writeCredentials?: (data: CredentialsData) => void
  /** Override the ~/.claude.json updater (tests). Passed accountUuid + organizationUuid. */
  writeClaudeJson?: (info: {
    accountUuid: string
    emailAddress?: string
    organizationUuid?: string
  }) => void
  /** Filesystem read for ~/.claude.json (defaults to readFileSync). Tests inject. */
  readFile?: (path: string) => string | null
  /** Filesystem write for ~/.claude.json (defaults to writeFileSync). Tests inject. */
  writeFile?: (path: string, contents: string) => void
  /** Resolve $HOME (tests). */
  home?: string
}

/**
 * Persist a successful token-exchange result into the platform credential
 * store and (best-effort) merge the `oauthAccount` block into
 * `~/.claude.json`.
 *
 * The credential entry uses the same shape the official CLI writes
 * (regardless of which backend stores it):
 *
 * ```json
 * {
 *   "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": ..., "scopes": [...] },
 *   "oauthAccount": { "accountUuid": "...", "organizationUuid": "..." }   // optional
 * }
 * ```
 *
 * The `oauthAccount` mirror in `~/.claude.json` is what the official CLI
 * reads at startup (`y_()` → `j8().oauthAccount` at L240111-240112), so
 * keeping it in sync means the user can still run `claude` afterwards
 * without it complaining about a missing account uuid.
 *
 * `~/.claude.json` may already contain unrelated CLI state (rolepath
 * cache, settings, onboarding flags) so we **merge** rather than overwrite:
 * read existing JSON if any, layer `oauthAccount` on top, write back. If
 * the file doesn't exist or is unparseable we create a fresh one with just
 * the account block.
 */
export function installCredentials(
  resp: TokenExchangeResponse,
  deps: InstallCredentialsDeps = {},
): LoginInstallResult {
  const expiresAt = Date.now() + resp.expires_in * 1000
  const scopes = (resp.scope ?? "").split(" ").filter(Boolean)

  // 1. Build CredentialsData and write to keychain.
  const account = resp.account
  const organization = resp.organization
  const credentials: CredentialsData = {
    claudeAiOauth: {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresAt,
      scopes,
    },
  }
  if (account || organization) {
    credentials.oauthAccount = {
      ...(account ? { accountUuid: account.uuid, displayName: undefined } : {}),
      ...(organization ? { organizationUuid: organization.uuid } : {}),
    }
  }
  const writeStore = deps.writeCredentials ?? defaultWriteCredentials
  writeStore(credentials)

  // 2. Mirror `oauthAccount` into ~/.claude.json (merge, don't clobber).
  if (account) {
    if (deps.writeClaudeJson) {
      deps.writeClaudeJson({
        accountUuid: account.uuid,
        emailAddress: account.email_address,
        organizationUuid: organization?.uuid,
      })
    } else {
      mergeClaudeJsonOauthAccount(
        {
          accountUuid: account.uuid,
          emailAddress: account.email_address,
          organizationUuid: organization?.uuid,
        },
        deps,
      )
    }
  }

  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token,
    expiresAt,
    scopes,
    ...(account ? { account: { uuid: account.uuid, emailAddress: account.email_address } } : {}),
    ...(organization ? { organization: { uuid: organization.uuid } } : {}),
  }
}

/**
 * Read `~/.claude.json` (if any), shallow-merge `oauthAccount`, and write
 * back. Safe in the face of missing/malformed files: a parse failure causes
 * us to create a minimal `{ oauthAccount }` document without losing
 * anything (because there was nothing valid to lose).
 *
 * Best-effort: a write failure logs to stderr but does not throw. Keychain
 * is the source of truth for tokens; `~/.claude.json` is only a hint for
 * `accountUuid` resolution and isn't worth aborting login over.
 *
 * Exposed (non-`export` is fine) but kept module-internal — call
 * `installCredentials` instead so tests can inject deps cleanly.
 */
function mergeClaudeJsonOauthAccount(
  info: {
    accountUuid: string
    emailAddress?: string
    organizationUuid?: string
  },
  deps: InstallCredentialsDeps,
): void {
  const home = deps.home ?? process.env.HOME ?? ""
  if (!home) return // no home dir → nothing safe to write

  const path = `${home}/.claude.json`

  let existing: Record<string, unknown> = {}
  if (deps.readFile) {
    const raw = deps.readFile(path)
    if (raw) {
      try {
        existing = JSON.parse(raw) as Record<string, unknown>
      } catch {
        existing = {}
      }
    }
  } else {
    try {
      const fs = require("node:fs") as typeof import("node:fs")
      const raw = fs.readFileSync(path, "utf-8")
      existing = JSON.parse(raw) as Record<string, unknown>
    } catch {
      existing = {}
    }
  }

  const prevOauth = (existing.oauthAccount ?? {}) as Record<string, unknown>
  const merged = {
    ...existing,
    oauthAccount: {
      ...prevOauth,
      accountUuid: info.accountUuid,
      ...(info.emailAddress !== undefined ? { emailAddress: info.emailAddress } : {}),
      ...(info.organizationUuid !== undefined ? { organizationUuid: info.organizationUuid } : {}),
    },
  }
  const json = JSON.stringify(merged, null, 2)

  if (deps.writeFile) {
    deps.writeFile(path, json)
    return
  }

  try {
    const fs = require("node:fs") as typeof import("node:fs")
    fs.writeFileSync(path, json, { mode: 0o600 })
  } catch (err) {
    process.stderr.write(
      `warn: could not update ~/.claude.json with oauthAccount info: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface LoginPrompt {
  authUrl: string
  /** What to display while waiting for paste. */
  promptText: string
}

export interface LoginDeps {
  /** Network client for the token-exchange POST. */
  networkClient?: NetworkClient
  /** Open a URL in the default browser. Best-effort; failure is non-fatal. */
  openUrl?: (url: string) => Promise<boolean>
  /** Display a banner / instructions. Allowed to no-op (tests). */
  display?: (msg: string) => void
  /** Read the user's pasted code. Returns the raw string they typed. */
  readPaste: () => Promise<string>
  /** Random bytes (32-byte chunks) for PKCE/state. Defaults to crypto.randomBytes. */
  randomBytes?: RandomBytesFn
  /** Override the OAuth client id (defaults to env / built-in). */
  clientId?: string
  /** Override the authorize URL base. */
  authorizeUrl?: string
  /** Override the token URL. */
  tokenUrl?: string
  /** Override the manual redirect URL. */
  redirectUri?: string
  /** Optional email pre-fill on the login form. */
  loginHint?: string
  /** Persistence overrides (passed through to `installCredentials`). */
  install?: InstallCredentialsDeps
  /** Maximum number of paste attempts before giving up. Default 3. */
  maxAttempts?: number
}

export type LoginOutcome = { ok: true; result: LoginInstallResult } | { ok: false; reason: string }

/**
 * Run the full PKCE manual-paste login flow end-to-end.
 *
 * Returns a discriminated outcome rather than throwing on user error
 * (paste mismatch, repeated malformed input, etc.) so the CLI wrapper can
 * format the error nicely without unwinding the stack. Network / unexpected
 * errors still throw — the wrapper catches them.
 *
 * Test-friendly: every I/O surface (network, browser, stdin, keychain,
 * `~/.claude.json`, randomness) goes through `LoginDeps`.
 */
export async function runOAuthLogin(deps: LoginDeps): Promise<LoginOutcome> {
  const oauth = getOauthRefreshConfig()
  const clientId = deps.clientId ?? oauth.clientId
  const tokenUrl = deps.tokenUrl ?? oauth.tokenUrl
  const redirectUri = deps.redirectUri ?? MANUAL_REDIRECT_URL
  const authorizeUrl = deps.authorizeUrl ?? CLAUDE_AI_AUTHORIZE_URL
  const network = deps.networkClient ?? defaultNetworkClient
  const display = deps.display ?? (() => {})
  const maxAttempts = deps.maxAttempts ?? 3

  const codeVerifier = generateCodeVerifier(deps.randomBytes)
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState(deps.randomBytes)
  const authUrl = buildAuthUrl({
    clientId,
    codeChallenge,
    state,
    authorizeUrl,
    redirectUri,
    loginHint: deps.loginHint,
  })

  display(`Opening browser to sign in…`)
  display(`If the browser didn't open, visit:\n  ${authUrl}`)

  if (deps.openUrl) {
    try {
      await deps.openUrl(authUrl)
    } catch {
      // Best-effort — the manual URL above is enough.
    }
  }

  // Paste loop: tolerate up to `maxAttempts` typos before giving up. The
  // state-mismatch check is per-attempt because a wrong paste is far more
  // common than a CSRF attempt; surfacing the mismatch and letting the
  // user retry is friendlier than aborting on the first miss.
  let lastReason = "no paste received"
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const raw = await deps.readPaste()
    const parsed = parsePastedCode(raw)
    if (!parsed.ok) {
      lastReason = parsed.reason === "empty" ? "no code pasted" : "could not parse pasted code"
      if (attempt < maxAttempts) {
        display(`Invalid code. Please make sure the full code was copied. (${lastReason})`)
        continue
      }
      return { ok: false, reason: lastReason }
    }
    if (parsed.state !== state) {
      lastReason = "state mismatch — pasted code does not match this login attempt"
      if (attempt < maxAttempts) {
        display(`State mismatch. Please paste the code from this login attempt only.`)
        continue
      }
      return { ok: false, reason: lastReason }
    }

    // Good paste — exchange + install.
    const tokens = await exchangeCodeForTokens(
      {
        authorizationCode: parsed.code,
        state: parsed.state,
        codeVerifier,
        tokenUrl,
        clientId,
        redirectUri,
      },
      network,
    )
    const result = installCredentials(tokens, deps.install)
    return { ok: true, result }
  }

  return { ok: false, reason: lastReason }
}

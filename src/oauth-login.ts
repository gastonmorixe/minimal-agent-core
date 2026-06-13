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
 *   8. Persist the resulting tokens — access/refresh/expiry/scopes plus the
 *      account+org uuids and email from the exchange response — into
 *      minimal-agent's OWN credential store (`~/.minimal-agent/auth.jsonc`,
 *      see `../auth-store.ts`). We do NOT write the macOS Keychain or
 *      `~/.claude.json`; minimal-agent is fully independent of the official
 *      `claude` CLI's storage.
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

import { type AuthStore, defaultAuthStore, type SecretBag } from "./auth-store.ts"
import {
  listProviderPlugins,
  type OAuthLoginInstallResult,
  type OAuthLoginProvider,
} from "./llm/provider-plugin.ts"
import { defaultNetworkClient, type NetworkClient } from "./network/index.ts"

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
  authorizeUrl: string
  redirectUri: string
  scopes: readonly string[]
  authorizeParams?: Readonly<Record<string, string>>
  loginHintParam?: string
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
  const url = new URL(input.authorizeUrl)
  for (const [key, value] of Object.entries(input.authorizeParams ?? {})) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", input.scopes.join(" "))
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("state", input.state)
  if (input.loginHint && input.loginHintParam) {
    url.searchParams.set(input.loginHintParam, input.loginHint)
  }
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
  tokenUrl: string
  clientId: string
  /** Redirect URI sent at exchange time. MUST equal the one used in buildAuthUrl. */
  redirectUri: string
}

/**
 * Token endpoint response shape. The server may include richer fields
 * (account info, organization info) on the success path — see
 * `services/oauth/types.ts: OAuthTokenExchangeResponse` upstream.
 */
export interface TokenExchangeResponse extends Record<string, unknown> {
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

/** Result of a successful provider login + persistence. */
export type LoginInstallResult = OAuthLoginInstallResult

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
  const body = JSON.stringify({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    state: input.state,
  })

  const response = await networkClient.request({
    label: "oauth.login.exchange",
    method: "POST",
    url: input.tokenUrl,
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
// Persistence: minimal-agent's own credential store
// ---------------------------------------------------------------------------

export interface InstallCredentialsDeps {
  store?: AuthStore
}

/**
 * Persist a successful token-exchange result into minimal-agent's own
 * credential store (`../auth-store.ts`). Captures everything we need to
 * run independently of the official `claude` CLI — tokens, expiry, scopes,
 * and the account/org uuids + email from the exchange response — so there is
 * no dependency on the macOS Keychain or `~/.claude.json`.
 *
 * The assembled in-memory shape is:
 *
 * ```json
 * {
 *   "claudeAiOauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": ..., "scopes": [...] },
 *   "oauthAccount":  { "accountUuid": "...", "organizationUuid": "...", "emailAddress": "..." }
 * }
 * ```
 *
 * which `writeCredentials` packs into the store's opaque secret bag.
 */
export function installCredentials(
  resp: TokenExchangeResponse,
  deps: InstallCredentialsDeps = {},
  provider: OAuthLoginProvider = resolveDefaultOAuthLoginProvider(),
): LoginInstallResult {
  const built = provider.buildCredential(resp)
  const store = deps.store ?? defaultAuthStore()
  store.set(
    built.credential.serviceId,
    built.credential.displayName,
    built.credential.secrets as SecretBag,
  )
  return built.result
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
  /** Provider-owned OAuth strategy. Defaults to the first discovered provider with oauthLogin. */
  provider?: OAuthLoginProvider
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
  /** Override the OAuth client id (normally supplied by the provider). */
  clientId?: string
  /** Override the authorize URL base (normally supplied by the provider). */
  authorizeUrl?: string
  /** Override the token URL (normally supplied by the provider). */
  tokenUrl?: string
  /** Override the manual redirect URL (normally supplied by the provider). */
  redirectUri?: string
  /** Optional email pre-fill on the login form. */
  loginHint?: string
  /** Persistence overrides (passed through to `installCredentials`). */
  install?: InstallCredentialsDeps
  /** Maximum number of paste attempts before giving up. Default 3. */
  maxAttempts?: number
}

export type LoginOutcome = { ok: true; result: LoginInstallResult } | { ok: false; reason: string }

/** Resolve the first registered provider that supports OAuth login. */
export function resolveDefaultOAuthLoginProvider(): OAuthLoginProvider {
  const provider = listProviderPlugins().find((p) => p.oauthLogin)?.oauthLogin
  if (!provider) {
    throw new Error("No OAuth login provider is registered.")
  }
  return provider
}

/**
 * Run the full PKCE manual-paste login flow end-to-end.
 *
 * Returns a discriminated outcome rather than throwing on user error
 * (paste mismatch, repeated malformed input, etc.) so the CLI wrapper can
 * format the error nicely without unwinding the stack. Network / unexpected
 * errors still throw — the wrapper catches them.
 *
 * Test-friendly: every I/O surface (network, browser, stdin, credential
 * store, randomness) goes through `LoginDeps`.
 */
export async function runOAuthLogin(deps: LoginDeps): Promise<LoginOutcome> {
  const provider = deps.provider ?? resolveDefaultOAuthLoginProvider()
  const config = provider.config()
  const clientId = deps.clientId ?? config.clientId
  const tokenUrl = deps.tokenUrl ?? config.tokenUrl
  const redirectUri = deps.redirectUri ?? config.redirectUri
  const authorizeUrl = deps.authorizeUrl ?? config.authorizeUrl
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
    scopes: config.scopes,
    authorizeParams: config.authorizeParams,
    loginHintParam: config.loginHintParam,
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
    const result = installCredentials(tokens, deps.install, provider)
    return { ok: true, result }
  }

  return { ok: false, reason: lastReason }
}

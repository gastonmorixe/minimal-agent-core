/**
 * Unit tests for `./oauth-login.ts`.
 *
 * Covers:
 *   - PKCE crypto: verifier shape, challenge SHA-256, state randomness
 *   - URL building: required params, scope ordering, optional login_hint
 *   - Paste parsing: `code#state`, full URL, query-only, malformed, empty
 *   - Token exchange: happy path, 401, generic error
 *   - installCredentials: keychain shape, ~/.claude.json merge / new file
 *   - runOAuthLogin orchestrator: success, retries, state mismatch, exhaustion
 */

import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { AuthStore } from "./auth-store.ts"
import type { OAuthLoginProvider } from "./llm/provider-plugin.ts"
import { NetworkClient, type NetworkRequest, NetworkResponse } from "./network/index.ts"
import type { NetworkTransport } from "./network/types.ts"
import {
  base64UrlEncode,
  buildAuthUrl,
  exchangeCodeForTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  installCredentials,
  parsePastedCode,
  runOAuthLogin,
  type TokenExchangeResponse,
} from "./oauth-login.ts"

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/** Build a 32-byte deterministic buffer for PKCE tests. */
function fixedBytes(seed: number): Buffer {
  const buf = Buffer.alloc(32)
  for (let i = 0; i < 32; i++) buf[i] = (seed + i) & 0xff
  return buf
}

/** Single-shot Network transport that replays a canned response. */
class CannedTransport implements NetworkTransport {
  readonly id = "canned"
  readonly seen: NetworkRequest[] = []
  constructor(
    private readonly status: number,
    private readonly body: string,
    private readonly headers: Record<string, string> = { "content-type": "application/json" },
  ) {}
  async request(req: NetworkRequest): Promise<NetworkResponse> {
    this.seen.push(req)
    const enc = new TextEncoder()
    // Capture body in a local so the ReadableStream `start(controller)` doesn't
    // resolve `this` against the controller (it's a method, not an arrow).
    const bodyText = this.body ?? ""
    return new NetworkResponse({
      status: this.status,
      headers: this.headers,
      transport: { id: this.id },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode(bodyText))
          c.close()
        },
      }),
    })
  }
}

const TEST_AUTHORIZE_URL = "https://login.example.test/oauth/authorize"
const TEST_TOKEN_URL = "https://login.example.test/oauth/token"
const TEST_REDIRECT_URI = "https://login.example.test/oauth/code/callback"
const TEST_SCOPES = ["profile", "inference"] as const
const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempStore(prefix = "ma-oauth-test-"): AuthStore {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return new AuthStore({ path: join(dir, "auth.jsonc") })
}

const fakeOAuthProvider: OAuthLoginProvider = {
  serviceId: "test-oauth",
  displayName: "Test OAuth",
  config() {
    return {
      clientId: "test-client",
      authorizeUrl: TEST_AUTHORIZE_URL,
      tokenUrl: TEST_TOKEN_URL,
      redirectUri: TEST_REDIRECT_URI,
      scopes: TEST_SCOPES,
      authorizeParams: { code: "true" },
      loginHintParam: "login_hint",
    }
  },
  buildCredential(response) {
    const accessToken = String(response.access_token)
    const refreshToken = String(response.refresh_token)
    const scopes =
      typeof response.scope === "string" ? response.scope.split(" ").filter(Boolean) : []
    const expiresAt = Date.now() + Number(response.expires_in) * 1000
    const account =
      typeof response.account === "object" && response.account !== null
        ? (response.account as { uuid?: unknown; email_address?: unknown })
        : undefined
    const organization =
      typeof response.organization === "object" && response.organization !== null
        ? (response.organization as { uuid?: unknown })
        : undefined
    return {
      credential: {
        serviceId: this.serviceId,
        displayName: this.displayName,
        secrets: {
          tokenType: "oauth",
          accessToken,
          refreshToken,
          expiresAt,
          scopes,
          ...(account?.uuid ? { accountUuid: String(account.uuid) } : {}),
          ...(account?.email_address ? { emailAddress: String(account.email_address) } : {}),
          ...(organization?.uuid ? { organizationUuid: String(organization.uuid) } : {}),
        },
      },
      result: {
        accessToken,
        refreshToken,
        expiresAt,
        scopes,
        ...(account?.uuid && account.email_address
          ? { account: { uuid: String(account.uuid), emailAddress: String(account.email_address) } }
          : {}),
        ...(organization?.uuid ? { organization: { uuid: String(organization.uuid) } } : {}),
      },
    }
  },
}

function buildUrlInput(overrides: Partial<Parameters<typeof buildAuthUrl>[0]> = {}) {
  return {
    clientId: "test-client",
    codeChallenge: "CHALLENGE",
    state: "STATE",
    authorizeUrl: TEST_AUTHORIZE_URL,
    redirectUri: TEST_REDIRECT_URI,
    scopes: TEST_SCOPES,
    authorizeParams: { code: "true" },
    loginHintParam: "login_hint",
    ...overrides,
  }
}

// (helper `ok(payload)` was removed — every test that wanted one inlined
// `new NetworkClient({ primary: new CannedTransport(200, ...) })` instead.)

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

describe("base64UrlEncode", () => {
  it("encodes without padding and uses url-safe alphabet", () => {
    // "any carnal pleas" → "YW55IGNhcm5hbCBwbGVhcw==" in std base64
    const encoded = base64UrlEncode(Buffer.from("any carnal pleas"))
    expect(encoded).toBe("YW55IGNhcm5hbCBwbGVhcw")
    expect(encoded).not.toContain("=")
  })

  it("translates + to - and / to _", () => {
    // Buffer that forces both `+` and `/` in std base64. Bytes [0xfb, 0xff, 0xbf]
    // → standard base64 "+/+/", url-safe "-_-_".
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xbf]))
    expect(encoded).toBe("-_-_")
  })
})

describe("generateCodeVerifier / generateCodeChallenge", () => {
  it("generates a 32-byte verifier expressed as 43-char base64url", () => {
    const v = generateCodeVerifier(() => fixedBytes(0))
    // 32 bytes base64url-encoded with padding stripped = 43 chars (RFC 7636).
    expect(v.length).toBe(43)
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("produces challenge = base64url(sha256(verifier)) — verified manually", () => {
    const v = "abc123"
    const expected = base64UrlEncode(createHash("sha256").update(v).digest())
    expect(generateCodeChallenge(v)).toBe(expected)
  })

  it("produces different verifiers for different random sources", () => {
    const a = generateCodeVerifier(() => fixedBytes(0))
    const b = generateCodeVerifier(() => fixedBytes(1))
    expect(a).not.toBe(b)
  })

  it("generateState returns a 43-char base64url string", () => {
    const s = generateState(() => fixedBytes(99))
    expect(s.length).toBe(43)
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

// ---------------------------------------------------------------------------
// URL building
// ---------------------------------------------------------------------------

describe("buildAuthUrl", () => {
  const baseInput = buildUrlInput()

  it("uses the provider authorize URL", () => {
    const url = buildAuthUrl(baseInput)
    expect(url.startsWith(TEST_AUTHORIZE_URL + "?")).toBe(true)
  })

  it("emits all required PKCE params with code_challenge_method=S256", () => {
    const url = new URL(buildAuthUrl(baseInput))
    expect(url.searchParams.get("code")).toBe("true") // Max upsell hint
    expect(url.searchParams.get("client_id")).toBe("test-client")
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("redirect_uri")).toBe(TEST_REDIRECT_URI)
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("state")).toBe("STATE")
  })

  it("requests the union scope set in deterministic order", () => {
    const url = new URL(buildAuthUrl(baseInput))
    expect(url.searchParams.get("scope")).toBe(TEST_SCOPES.join(" "))
  })

  it("includes login_hint only when provided", () => {
    expect(new URL(buildAuthUrl(baseInput)).searchParams.has("login_hint")).toBe(false)
    const u2 = new URL(buildAuthUrl({ ...baseInput, loginHint: "user@example.com" }))
    expect(u2.searchParams.get("login_hint")).toBe("user@example.com")
  })

  it("honors authorizeUrl / redirectUri overrides", () => {
    const url = new URL(
      buildAuthUrl({
        ...baseInput,
        authorizeUrl: "https://example.com/oauth/authorize",
        redirectUri: "http://localhost:9999/callback",
        scopes: ["a", "b"],
      }),
    )
    expect(url.origin + url.pathname).toBe("https://example.com/oauth/authorize")
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:9999/callback")
  })
})

// ---------------------------------------------------------------------------
// Paste parsing
// ---------------------------------------------------------------------------

describe("parsePastedCode", () => {
  it("parses canonical <code>#<state> form", () => {
    const r = parsePastedCode("AUTHCODE#STATEVAL")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.code).toBe("AUTHCODE")
      expect(r.state).toBe("STATEVAL")
    }
  })

  it("trims surrounding whitespace and a trailing newline", () => {
    const r = parsePastedCode("  AUTHCODE#STATEVAL\n")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.code).toBe("AUTHCODE")
      expect(r.state).toBe("STATEVAL")
    }
  })

  it("rejects empty / whitespace-only paste", () => {
    expect(parsePastedCode("")).toEqual({ ok: false, reason: "empty" })
    expect(parsePastedCode("   \n  \t ")).toEqual({ ok: false, reason: "empty" })
  })

  it("rejects malformed paste (no #, no query)", () => {
    expect(parsePastedCode("AUTHCODE")).toEqual({ ok: false, reason: "malformed" })
    expect(parsePastedCode("#STATEONLY")).toEqual({ ok: false, reason: "malformed" })
    expect(parsePastedCode("CODEONLY#")).toEqual({ ok: false, reason: "malformed" })
  })

  it("accepts the full callback URL with code and state query params", () => {
    const r = parsePastedCode("https://auth.example.com/oauth/code/callback?code=ABC&state=XYZ")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.code).toBe("ABC")
      expect(r.state).toBe("XYZ")
    }
  })

  it("rejects a URL that lacks code or state", () => {
    expect(parsePastedCode("https://example.com/?code=ABC")).toEqual({
      ok: false,
      reason: "malformed",
    })
    expect(parsePastedCode("https://example.com/")).toEqual({ ok: false, reason: "malformed" })
  })

  it("rejects URLs that fail to parse at all", () => {
    expect(parsePastedCode("https://[notavalidurl")).toEqual({ ok: false, reason: "malformed" })
  })
})

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

describe("exchangeCodeForTokens", () => {
  it("POSTs JSON to the configured token URL with grant_type=authorization_code", async () => {
    const t = new CannedTransport(
      200,
      JSON.stringify({
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        scope: "user:profile user:inference",
      }),
    )
    const client = new NetworkClient({ primary: t })

    const res = await exchangeCodeForTokens(
      {
        authorizationCode: "CODE",
        state: "STATE",
        codeVerifier: "VERIFIER",
        tokenUrl: "https://example.com/token",
        clientId: "CLIENT",
        redirectUri: "https://example.com/cb",
      },
      client,
    )

    expect(res.access_token).toBe("AT")
    expect(t.seen.length).toBe(1)
    const req = t.seen[0]!
    expect(req.method).toBe("POST")
    expect(req.url).toBe("https://example.com/token")
    expect(req.headers?.["content-type"]).toBe("application/json")
    const body = JSON.parse(String(req.body))
    expect(body.grant_type).toBe("authorization_code")
    expect(body.code).toBe("CODE")
    expect(body.state).toBe("STATE")
    expect(body.code_verifier).toBe("VERIFIER")
    expect(body.client_id).toBe("CLIENT")
    expect(body.redirect_uri).toBe("https://example.com/cb")
  })

  it("redacts the request body in capture options", async () => {
    const t = new CannedTransport(
      200,
      JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    )
    await exchangeCodeForTokens(
      {
        authorizationCode: "secret-code",
        state: "S",
        codeVerifier: "secret-verifier",
        tokenUrl: "https://example.com/token",
        clientId: "C",
        redirectUri: "https://example.com/cb",
      },
      new NetworkClient({ primary: t }),
    )
    const captured = t.seen[0]!.capture
    expect(captured?.requestBody).toBe("[REDACTED OAUTH EXCHANGE BODY]")
    expect(captured?.responseBody).toBe(false)
  })

  it("throws a clean message on 401", async () => {
    const t = new CannedTransport(401, '{"error":"invalid_grant"}')
    await expect(
      exchangeCodeForTokens(
        {
          authorizationCode: "BAD",
          state: "S",
          codeVerifier: "V",
          tokenUrl: "https://example.com/token",
          clientId: "C",
          redirectUri: "https://example.com/cb",
        },
        new NetworkClient({ primary: t }),
      ),
    ).rejects.toThrow(/invalid authorization code/i)
  })

  it("includes the body and status in the error message on non-401 failures", async () => {
    const t = new CannedTransport(503, "service unavailable")
    await expect(
      exchangeCodeForTokens(
        {
          authorizationCode: "X",
          state: "Y",
          codeVerifier: "Z",
          tokenUrl: "https://example.com/token",
          clientId: "C",
          redirectUri: "https://example.com/cb",
        },
        new NetworkClient({ primary: t }),
      ),
    ).rejects.toThrow(/Token exchange failed \(503\): service unavailable/)
  })
})

// ---------------------------------------------------------------------------
// installCredentials
// ---------------------------------------------------------------------------

describe("installCredentials", () => {
  it("persists the provider-built credential through AuthStore", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-oauth-install-"))
    const resp: TokenExchangeResponse = {
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      scope: "user:profile user:inference",
      account: { uuid: "acc-uuid", email_address: "u@example.com" },
      organization: { uuid: "org-uuid" },
    }
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      const result = installCredentials(resp, { store }, fakeOAuthProvider)
      const secrets = store.getSecrets("test-oauth", "Test OAuth")!

      expect(secrets.accessToken).toBe("AT")
      expect(secrets.refreshToken).toBe("RT")
      expect(secrets.scopes).toEqual(["user:profile", "user:inference"])
      expect(secrets.accountUuid).toBe("acc-uuid")
      expect(secrets.organizationUuid).toBe("org-uuid")
      expect(secrets.emailAddress).toBe("u@example.com")
      expect(result.account?.uuid).toBe("acc-uuid")
      expect(result.organization?.uuid).toBe("org-uuid")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("computes expiresAt = now + expires_in*1000 (within tolerance)", () => {
    const before = Date.now()
    const result = installCredentials(
      {
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 60,
      } as TokenExchangeResponse,
      { store: tempStore("ma-oauth-install-") },
      fakeOAuthProvider,
    )
    const after = Date.now()
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 60_000)
    expect(result.expiresAt).toBeLessThanOrEqual(after + 60_000 + 50) // 50ms wall-clock slack
  })

  it("omits oauthAccount entirely when the response has no account or organization", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-oauth-install-"))
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      installCredentials(
        {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          // no `account`, no `organization`
        },
        { store },
        fakeOAuthProvider,
      )
      const secrets = store.getSecrets("test-oauth", "Test OAuth")!
      expect(secrets.accountUuid).toBeUndefined()
      expect(secrets.organizationUuid).toBeUndefined()
      expect(secrets.accessToken).toBe("AT")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("records account uuid + email even without an organization", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-oauth-install-"))
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      installCredentials(
        {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          account: { uuid: "acc-only", email_address: "a@b.example" },
        },
        { store },
        fakeOAuthProvider,
      )
      const secrets = store.getSecrets("test-oauth", "Test OAuth")!
      expect(secrets.accountUuid).toBe("acc-only")
      expect(secrets.emailAddress).toBe("a@b.example")
      expect(secrets.organizationUuid).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("persists end-to-end through a real AuthStore round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-oauth-install-"))
    try {
      const store = new AuthStore({ path: join(dir, "auth.jsonc") })
      installCredentials(
        {
          access_token: "AT",
          refresh_token: "RT",
          expires_in: 3600,
          scope: "user:profile",
          account: { uuid: "acc-uuid", email_address: "u@example.com" },
          organization: { uuid: "org-uuid" },
        },
        { store },
        fakeOAuthProvider,
      )
      const secrets = store.getSecrets("test-oauth", "Test OAuth")!
      expect(secrets.accessToken).toBe("AT")
      expect(secrets.accountUuid).toBe("acc-uuid")
      expect(secrets.organizationUuid).toBe("org-uuid")
      expect(secrets.emailAddress).toBe("u@example.com")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// runOAuthLogin orchestrator
// ---------------------------------------------------------------------------

describe("runOAuthLogin", () => {
  it("happy path: paste once, exchange succeeds, install runs", async () => {
    const tokenSrv = new CannedTransport(
      200,
      JSON.stringify({
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
        scope: "user:profile user:inference",
        account: { uuid: "u", email_address: "e@example.com" },
        organization: { uuid: "o" },
      }),
    )
    let openedUrl = ""
    let installedAccount: string | undefined
    const messages: string[] = []

    // Use deterministic state so we can construct a matching paste.
    const fakeRand = (() => {
      let i = 0
      return (n: number) => {
        const seed = i++
        const buf = Buffer.alloc(n)
        for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
        return buf
      }
    })()
    const verifier = generateCodeVerifier(fakeRand) // consumes seed=0
    const state = generateState(fakeRand) // consumes seed=1
    // The orchestrator regenerates with the SAME deps.randomBytes; we can't
    // share it directly here because the orchestrator creates its own
    // sequence. So construct a fresh deterministic source for the call:
    let callIdx = 0
    const orchestratorRand: (n: number) => Buffer = (n) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    // Recompute what THE ORCHESTRATOR will generate (verifier first, state second).
    // Seed = 0 in the deterministic source; the `seed * 31 + k` formula
    // simplifies to `k & 0xff` on the first call but we keep the full form
    // so the parallelism with the seed=1 (state) call below is visible.
    const orchVerifier = generateCodeVerifier((n) => {
      const seed = 0
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    })
    const orchState = generateState((n) => {
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (1 * 31 + k) & 0xff
      return buf
    })
    // Sanity: silence the unused warning.
    expect(verifier.length).toBeGreaterThan(0)
    expect(state.length).toBeGreaterThan(0)

    const outcome = await runOAuthLogin({
      provider: fakeOAuthProvider,
      networkClient: new NetworkClient({ primary: tokenSrv }),
      openUrl: async (u) => {
        openedUrl = u
        return true
      },
      display: (m) => messages.push(m),
      readPaste: async () => `AUTHCODE#${orchState}`,
      randomBytes: orchestratorRand,
      install: { store: tempStore("ma-oauth-run-") },
    })

    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.result.accessToken).toBe("AT")
      expect(outcome.result.account?.uuid).toBe("u")
    }
    expect(openedUrl).toContain("client_id=")
    expect(openedUrl).toContain(`state=${encodeURIComponent(orchState)}`)
    installedAccount = outcome.ok ? outcome.result.account?.uuid : undefined
    expect(installedAccount).toBe("u")
    // Verify the body sent to the token server contains the orch verifier.
    expect(tokenSrv.seen.length).toBe(1)
    const sent = JSON.parse(String(tokenSrv.seen[0]!.body))
    expect(sent.code_verifier).toBe(orchVerifier)
    expect(sent.state).toBe(orchState)
    expect(sent.code).toBe("AUTHCODE")
    // We display Opening / If browser didn't open / both.
    expect(messages.some((m) => /Opening browser/i.test(m))).toBe(true)
    expect(messages.some((m) => /If the browser didn't open/i.test(m))).toBe(true)
  })

  it("malformed paste retries and eventually succeeds", async () => {
    let callIdx = 0
    const orchestratorRand = (n: number) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    const orchState = generateState((n) => {
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (1 * 31 + k) & 0xff
      return buf
    })
    const tokenSrv = new CannedTransport(
      200,
      JSON.stringify({
        access_token: "AT",
        refresh_token: "RT",
        expires_in: 3600,
      }),
    )

    const pastes = ["nope", `OK#${orchState}`]
    const messages: string[] = []
    const outcome = await runOAuthLogin({
      provider: fakeOAuthProvider,
      networkClient: new NetworkClient({ primary: tokenSrv }),
      readPaste: async () => pastes.shift() ?? "",
      randomBytes: orchestratorRand,
      display: (m) => messages.push(m),
      install: { store: tempStore("ma-oauth-run-") },
    })
    expect(outcome.ok).toBe(true)
    expect(messages.some((m) => /Invalid code/.test(m))).toBe(true)
  })

  it("state mismatch retries with a clear message", async () => {
    let callIdx = 0
    const orchestratorRand = (n: number) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    const orchState = generateState((n) => {
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (1 * 31 + k) & 0xff
      return buf
    })

    const tokenSrv = new CannedTransport(
      200,
      JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    )

    const pastes = ["CODE#WRONG_STATE", `CODE#${orchState}`]
    const messages: string[] = []
    const outcome = await runOAuthLogin({
      provider: fakeOAuthProvider,
      networkClient: new NetworkClient({ primary: tokenSrv }),
      readPaste: async () => pastes.shift() ?? "",
      randomBytes: orchestratorRand,
      display: (m) => messages.push(m),
      install: { store: tempStore("ma-oauth-run-") },
    })
    expect(outcome.ok).toBe(true)
    expect(messages.some((m) => /State mismatch/i.test(m))).toBe(true)
  })

  it("gives up after maxAttempts of malformed paste", async () => {
    let callIdx = 0
    const orchestratorRand = (n: number) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    const tokenSrv = new CannedTransport(200, "{}")

    const outcome = await runOAuthLogin({
      provider: fakeOAuthProvider,
      networkClient: new NetworkClient({ primary: tokenSrv }),
      readPaste: async () => "nope",
      maxAttempts: 2,
      randomBytes: orchestratorRand,
      install: { store: tempStore("ma-oauth-run-") },
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toMatch(/parse/i)
    }
    // Never made a token call (no parse ever passed).
    expect(tokenSrv.seen.length).toBe(0)
  })

  it("propagates network exchange errors", async () => {
    let callIdx = 0
    const orchestratorRand = (n: number) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    const orchState = generateState((n) => {
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (1 * 31 + k) & 0xff
      return buf
    })

    const tokenSrv = new CannedTransport(401, '{"error":"invalid_grant"}')
    await expect(
      runOAuthLogin({
        provider: fakeOAuthProvider,
        networkClient: new NetworkClient({ primary: tokenSrv }),
        readPaste: async () => `BAD#${orchState}`,
        randomBytes: orchestratorRand,
        install: { store: tempStore("ma-oauth-run-") },
      }),
    ).rejects.toThrow(/invalid authorization code/i)
  })

  it("does not invoke openUrl when not provided (best-effort UX)", async () => {
    let callIdx = 0
    const orchestratorRand = (n: number) => {
      const seed = callIdx++
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (seed * 31 + k) & 0xff
      return buf
    }
    const orchState = generateState((n) => {
      const buf = Buffer.alloc(n)
      for (let k = 0; k < n; k++) buf[k] = (1 * 31 + k) & 0xff
      return buf
    })
    const tokenSrv = new CannedTransport(
      200,
      JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    )

    // No `openUrl` in deps — the function should still complete using the
    // pasted code path. Just asserting "no throw".
    const outcome = await runOAuthLogin({
      provider: fakeOAuthProvider,
      networkClient: new NetworkClient({ primary: tokenSrv }),
      readPaste: async () => `OK#${orchState}`,
      randomBytes: orchestratorRand,
      install: { store: tempStore("ma-oauth-run-") },
    })
    expect(outcome.ok).toBe(true)
  })
})

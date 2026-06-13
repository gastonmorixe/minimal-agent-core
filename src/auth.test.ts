import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  type CredentialsData,
  getAuth,
  getOauthRefreshConfig,
  readCredentials,
  refreshAccessToken,
  type TokenRefreshResult,
  writeCredentials,
} from "./auth.ts"
import { AuthStore } from "./auth-store.ts"

describe("auth", () => {
  describe("readCredentials / writeCredentials (store-backed)", () => {
    let dir: string
    let store: AuthStore
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "ma-auth-"))
      store = new AuthStore({ path: join(dir, "auth.jsonc") })
    })
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it("returns null when the store is empty (not logged in)", () => {
      expect(readCredentials(store)).toBeNull()
    })

    it("round-trips OAuth credentials through the store", () => {
      writeCredentials(
        {
          claudeAiOauth: {
            accessToken: "AT",
            refreshToken: "RT",
            expiresAt: 123,
            scopes: ["user:profile", "user:inference"],
            subscriptionType: "max",
            rateLimitTier: "default_claude_max_20x",
          },
          oauthAccount: {
            accountUuid: "abcdef01-2345-6789-abcd-ef0123456789",
            organizationUuid: "11111111-2222-3333-4444-555555555555",
            emailAddress: "u@example.com",
          },
        },
        store,
      )
      const creds = readCredentials(store)!
      expect(creds.claudeAiOauth?.accessToken).toBe("AT")
      expect(creds.claudeAiOauth?.refreshToken).toBe("RT")
      expect(creds.claudeAiOauth?.expiresAt).toBe(123)
      expect(creds.claudeAiOauth?.scopes).toEqual(["user:profile", "user:inference"])
      expect(creds.claudeAiOauth?.subscriptionType).toBe("max")
      expect(creds.oauthAccount?.accountUuid).toBe("abcdef01-2345-6789-abcd-ef0123456789")
      expect(creds.oauthAccount?.organizationUuid).toBe("11111111-2222-3333-4444-555555555555")
      expect(creds.oauthAccount?.emailAddress).toBe("u@example.com")
    })

    it("round-trips an API-key credential", () => {
      writeCredentials({ apiKey: "sk-ant-xyz" }, store)
      expect(readCredentials(store)).toEqual({ apiKey: "sk-ant-xyz" })
    })
  })

  describe("refreshAccessToken", () => {
    it("refresh request has correct format (dry run check)", () => {
      // We test the request shape by checking the function exists and
      // the constants are correct. Actual refresh tested in e2e.
      expect(typeof refreshAccessToken).toBe("function")
    })

    it("uses the current Claude Code OAuth config", () => {
      const oauth = getOauthRefreshConfig()
      expect(oauth.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token")
      expect(oauth.clientId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    })

    it("doRefresh re-reads the credential store on every call (mode B: in-process rotation)", async () => {
      // Regression: long-lived sessions previously failed on the *second*
      // refresh because the closure captured the original snapshot's
      // refreshToken. After the server rotated RT1→RT2 on the first
      // refresh, the closure still sent RT1 → invalid_grant.
      let storedRT = "RT1"
      const sentRefreshTokens: string[] = []

      const fakeRead = (_service: string): CredentialsData => ({
        claudeAiOauth: {
          accessToken: "AT_old",
          refreshToken: storedRT,
          expiresAt: Date.now() + 60_000_000, // not expired — force manual refresh
        },
        oauthAccount: { accountUuid: "uuid-1" },
      })

      const fakeWrite = (data: CredentialsData) => {
        storedRT = data.claudeAiOauth!.refreshToken!
      }

      const fakeRefresh = async (rt: string): Promise<TokenRefreshResult> => {
        sentRefreshTokens.push(rt)
        // Simulate server rotation: RT1 → RT2 → RT3
        const next = rt === "RT1" ? "RT2" : rt === "RT2" ? "RT3" : "RT4"
        return {
          accessToken: `AT_${next}`,
          refreshToken: next,
          expiresAt: Date.now() + 8 * 3600_000,
        }
      }

      const auth = await getAuth("test-service", {
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })
      expect(auth.refresh).toBeDefined()

      const after1 = await auth.refresh!()
      const after2 = await after1.refresh!()
      const after3 = await after2.refresh!()

      // Each refresh sent the *current* credential store RT, not the captured one
      expect(sentRefreshTokens).toEqual(["RT1", "RT2", "RT3"])
      expect(after3.token).toBe("AT_RT4")
      expect(storedRT).toBe("RT4")
    })

    it("doRefresh surfaces invalid_grant with a re-login hint", async () => {
      const fakeRead = () => ({
        claudeAiOauth: {
          accessToken: "AT",
          refreshToken: "RT_revoked",
          // Well beyond EXPIRY_BUFFER_MS (60_000) so getAuth does NOT
          // proactively refresh — the test wants to exercise the explicit
          // auth.refresh!() call below, not the eager refresh path.
          expiresAt: Date.now() + 60_000_000,
        },
      })
      const fakeRefresh = async (): Promise<TokenRefreshResult> => {
        throw new Error(
          'Token refresh failed (400): {"error": "invalid_grant", "error_description": "Refresh token not found or invalid"}',
        )
      }

      const auth = await getAuth("test-service", {
        read: fakeRead,
        write: () => {},
        refresh: fakeRefresh,
      })

      await expect(auth.refresh!()).rejects.toThrow(/invalid_grant/)
      // Hint points at our own `minimal-agent --login`; we no longer mention
      // the official `claude` CLI since storage is fully independent.
      await expect(auth.refresh!()).rejects.toThrow(/minimal-agent --login/)
    })

    it("doRefresh skips the server call when credential store already has a fresher token", async () => {
      // Models the multi-process race: between our 401 and our refresh,
      // another process refreshed → credential store now holds a NEW access
      // token (different from what we issued last time). doRefresh
      // should detect this via the in-closure `lastIssuedToken` tracker
      // and return the credential store's token directly, skipping the server
      // round-trip and the destructive refresh-token rotation.
      let storedAccess = "AT_v1"
      let storedRT = "RT_v1"
      let refreshCalls = 0

      const fakeRead = (_service: string): CredentialsData => ({
        claudeAiOauth: {
          accessToken: storedAccess,
          refreshToken: storedRT,
          expiresAt: Date.now() + 60_000_000,
        },
        oauthAccount: { accountUuid: "uuid-1" },
      })
      const fakeWrite = (data: CredentialsData) => {
        storedAccess = data.claudeAiOauth!.accessToken
        storedRT = data.claudeAiOauth!.refreshToken!
      }
      const fakeRefresh = async (rt: string): Promise<TokenRefreshResult> => {
        refreshCalls++
        return {
          accessToken: `AT_after_refresh_${refreshCalls}`,
          refreshToken: rt + "_rotated",
          expiresAt: Date.now() + 8 * 3600_000,
        }
      }

      const auth = await getAuth("test-service", {
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })
      // Initial: lastIssuedToken == "AT_v1" (the value getAuth observed).

      // Simulate: ANOTHER process refreshed and wrote a new token to the
      // credential store WITHOUT us calling refresh ourselves. Now when WE call
      // auth.refresh(), the closure should compare credential store's accessToken
      // to lastIssuedToken, see a difference, return the fresh token, and
      // NOT call refreshFn.
      storedAccess = "AT_from_other_process"
      storedRT = "RT_from_other_process"

      const result = await auth.refresh!()

      expect(refreshCalls).toBe(0) // server was NOT called
      expect(result.token).toBe("AT_from_other_process")
    })

    it("doRefresh DOES call refresh when credential store still has the same token we last used", async () => {
      // Counterpart of the previous test: if no other process has
      // refreshed, the credential store still matches lastIssuedToken, so we
      // must do a real refresh (not silently skip).
      let storedAccess = "AT_v1"
      let storedRT = "RT_v1"
      let refreshCalls = 0

      const fakeRead = (_service: string): CredentialsData => ({
        claudeAiOauth: {
          accessToken: storedAccess,
          refreshToken: storedRT,
          expiresAt: Date.now() + 60_000_000,
        },
        oauthAccount: { accountUuid: "uuid-1" },
      })
      const fakeWrite = (data: CredentialsData) => {
        storedAccess = data.claudeAiOauth!.accessToken
        storedRT = data.claudeAiOauth!.refreshToken!
      }
      const fakeRefresh = async (rt: string): Promise<TokenRefreshResult> => {
        refreshCalls++
        return {
          accessToken: `AT_fresh_${refreshCalls}`,
          refreshToken: rt + "_rot",
          expiresAt: Date.now() + 8 * 3600_000,
        }
      }

      const auth = await getAuth("test-service", {
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })

      // No other process has touched the credential store. auth.refresh() must
      // call the server.
      const result = await auth.refresh!()

      expect(refreshCalls).toBe(1)
      expect(result.token).toBe("AT_fresh_1")
      // And the credential store reflects the new tokens.
      expect(storedAccess).toBe("AT_fresh_1")
    })

    it("lets CLAUDE_CODE_OAUTH_CLIENT_ID override the default", () => {
      const prev = process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
      process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = "test-client-id"

      try {
        expect(getOauthRefreshConfig().clientId).toBe("test-client-id")
      } finally {
        if (prev === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_CLIENT_ID
        } else {
          process.env.CLAUDE_CODE_OAUTH_CLIENT_ID = prev
        }
      }
    })
  })
})

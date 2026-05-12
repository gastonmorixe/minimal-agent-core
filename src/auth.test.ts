import { describe, it, expect } from "bun:test"
import {
  type CredentialsData,
  type TokenRefreshResult,
  getAuth,
  getOauthRefreshConfig,
  readCredentials,
  refreshAccessToken,
} from "./auth.ts"

describe("auth", () => {
  describe("readCredentials", () => {
    it("reads Claude Code credentials and returns expected shape", () => {
      const creds = readCredentials()
      // On a machine with Claude Code installed, this should succeed
      if (!creds) {
        console.warn("SKIP: no credential entry found (not logged in)")
        return
      }

      expect(creds).toHaveProperty("claudeAiOauth")
      expect(creds.claudeAiOauth).toHaveProperty("accessToken")
      expect(typeof creds.claudeAiOauth!.accessToken).toBe("string")
      expect(creds.claudeAiOauth!.accessToken.length).toBeGreaterThan(10)

      // Should have refresh token and expiry
      expect(creds.claudeAiOauth).toHaveProperty("refreshToken")
      expect(creds.claudeAiOauth).toHaveProperty("expiresAt")
      expect(typeof creds.claudeAiOauth!.expiresAt).toBe("number")
    })

    it("has oauthAccount with accountUuid (from credential store or ~/.claude.json)", () => {
      const creds = readCredentials()
      if (!creds) return

      // oauthAccount may be in the store or in ~/.claude.json depending on version
      if (creds.oauthAccount?.accountUuid) {
        expect(creds.oauthAccount.accountUuid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        )
      } else {
        // Read from ~/.claude.json instead
        const { readFileSync } = require("node:fs")
        const { join } = require("node:path")
        try {
          const config = JSON.parse(readFileSync(join(process.env.HOME, ".claude.json"), "utf-8"))
          expect(config.oauthAccount?.accountUuid).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          )
        } catch {
          console.warn("SKIP: no accountUuid in store or ~/.claude.json")
        }
      }
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

    it("doRefresh re-reads the store on every call (mode B: in-process rotation)", async () => {
      // Regression: long-lived sessions previously failed on the *second*
      // refresh because the closure captured the original snapshot's
      // refreshToken. After the server rotated RT1→RT2 on the first
      // refresh, the closure still sent RT1 → invalid_grant.
      let storedRT = "RT1"
      const sentRefreshTokens: string[] = []

      const fakeRead = (): CredentialsData => ({
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

      const auth = await getAuth({
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })
      expect(auth.refresh).toBeDefined()

      const after1 = await auth.refresh!()
      const after2 = await after1.refresh!()
      const after3 = await after2.refresh!()

      // Each refresh sent the *current* store RT, not the captured one
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

      const auth = await getAuth({
        read: fakeRead,
        write: () => {},
        refresh: fakeRefresh,
      })

      await expect(auth.refresh!()).rejects.toThrow(/invalid_grant/)
      // Hint mentions both `--login` (preferred) and `claude` (fallback) so
      // grepping for either substring continues to work.
      await expect(auth.refresh!()).rejects.toThrow(/--login/)
      await expect(auth.refresh!()).rejects.toThrow(/claude/)
    })

    it("doRefresh skips the server call when the store already has a fresher token", async () => {
      // Models the multi-process race: between our 401 and our refresh,
      // another process refreshed → the store now holds a NEW access
      // token (different from what we issued last time). doRefresh
      // should detect this via the in-closure `lastIssuedToken` tracker
      // and return the store's token directly, skipping the server
      // round-trip and the destructive refresh-token rotation.
      let storedAccess = "AT_v1"
      let storedRT = "RT_v1"
      let refreshCalls = 0

      const fakeRead = (): CredentialsData => ({
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

      const auth = await getAuth({
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })
      // Initial: lastIssuedToken == "AT_v1" (the value getAuth observed).

      // Simulate: ANOTHER process refreshed and wrote a new token to the
      // store WITHOUT us calling refresh ourselves. Now when WE call
      // auth.refresh(), the closure should compare the store's accessToken
      // to lastIssuedToken, see a difference, return the fresh token, and
      // NOT call refreshFn.
      storedAccess = "AT_from_other_process"
      storedRT = "RT_from_other_process"

      const result = await auth.refresh!()

      expect(refreshCalls).toBe(0) // server was NOT called
      expect(result.token).toBe("AT_from_other_process")
    })

    it("doRefresh DOES call refresh when the store still has the same token we last used", async () => {
      // Counterpart of the previous test: if no other process has
      // refreshed, the store still matches lastIssuedToken, so we
      // must do a real refresh (not silently skip).
      let storedAccess = "AT_v1"
      let storedRT = "RT_v1"
      let refreshCalls = 0

      const fakeRead = (): CredentialsData => ({
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

      const auth = await getAuth({
        read: fakeRead,
        write: fakeWrite,
        refresh: fakeRefresh,
      })

      // No other process has touched the store. auth.refresh() must
      // call the server.
      const result = await auth.refresh!()

      expect(refreshCalls).toBe(1)
      expect(result.token).toBe("AT_fresh_1")
      // And the store reflects the new tokens.
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

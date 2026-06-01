import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import {
  ANTHROPIC_VERSION,
  BetaFlagId,
  buildBetaFlags,
  buildHeaders,
  DEFAULT_MODEL,
  MODELS,
  STAINLESS_SDK_VERSION,
  USER_AGENT,
} from "./headers.ts"

const NET_DBG_DIR = join(process.env.HOME ?? "", "Projects/claude-cli-versions/.node-net-dbg")

describe("headers", () => {
  const mockAuth: AuthResult = {
    type: "oauth",
    token: "sk-ant-oat01-FAKE-TOKEN",
    accountUuid: "00000000-0000-0000-0000-000000000000",
  }

  describe("MODELS catalog", () => {
    it("DEFAULT_MODEL is one of the catalog entries", () => {
      // Pins the linkage so a future model rename doesn't leave
      // DEFAULT_MODEL pointing at a stale literal.
      const all: string[] = [MODELS.OPUS, MODELS.SONNET, MODELS.HAIKU]
      expect(all).toContain(DEFAULT_MODEL)
    })

    it("DEFAULT_MODEL points at sonnet (tier-portable default)", () => {
      expect(DEFAULT_MODEL).toBe(MODELS.SONNET)
    })
  })

  describe("buildHeaders", () => {
    it("includes all expected keys for OAuth", () => {
      const headers = buildHeaders(mockAuth, "test-session-id")

      const expectedKeys = [
        "accept",
        "anthropic-beta",
        "anthropic-dangerous-direct-browser-access",
        "anthropic-version",
        "authorization",
        "content-type",
        "user-agent",
        "x-app",
        "x-claude-code-session-id",
        "x-client-request-id",
        "x-stainless-arch",
        "x-stainless-lang",
        "x-stainless-os",
        "x-stainless-package-version",
        "x-stainless-retry-count",
        "x-stainless-runtime",
        "x-stainless-runtime-version",
        "x-stainless-timeout",
      ]

      for (const key of expectedKeys) {
        expect(headers).toHaveProperty(key)
      }
    })

    it("sets correct static values", () => {
      const headers = buildHeaders(mockAuth, "sess-123")

      expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION)
      expect(headers["user-agent"]).toBe(USER_AGENT)
      expect(headers["x-app"]).toBe("cli")
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
      expect(headers["x-stainless-package-version"]).toBe(STAINLESS_SDK_VERSION)
      expect(headers["x-stainless-lang"]).toBe("js")
      expect(headers["x-stainless-runtime"]).toBe("node")
      expect(headers["x-stainless-timeout"]).toBe("600")
      expect(headers["x-claude-code-session-id"]).toBe("sess-123")
    })

    it("sets authorization as Bearer for OAuth", () => {
      const headers = buildHeaders(mockAuth, "s")
      expect(headers.authorization).toBe("Bearer sk-ant-oat01-FAKE-TOKEN")
      expect(headers).not.toHaveProperty("x-api-key")
    })

    it("sets x-api-key for API key auth", () => {
      const apiKeyAuth: AuthResult = { type: "api-key", token: "sk-ant-123" }
      const headers = buildHeaders(apiKeyAuth, "s")
      expect(headers["x-api-key"]).toBe("sk-ant-123")
      expect(headers).not.toHaveProperty("authorization")
      // No beta flags for API key
      expect(headers).not.toHaveProperty("anthropic-beta")
    })

    it("x-client-request-id is a UUID", () => {
      const headers = buildHeaders(mockAuth, "s")
      expect(headers["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    })

    it("generates unique x-client-request-id per call", () => {
      const h1 = buildHeaders(mockAuth, "s")
      const h2 = buildHeaders(mockAuth, "s")
      expect(h1["x-client-request-id"]).not.toBe(h2["x-client-request-id"])
    })

    it("beta flags match conversation set (default)", () => {
      const headers = buildHeaders(mockAuth, "s", "conversation")
      const flags = headers["anthropic-beta"].split(",")
      // Default conversation without model = no context-1m (opus-only)
      expect(flags).toEqual(buildBetaFlags("conversation"))
    })

    it("beta flags for opus include context-1m", () => {
      const headers = buildHeaders(mockAuth, "s", "conversation", "claude-opus-4-6")
      const flags = headers["anthropic-beta"].split(",")
      expect(flags).toContain(BetaFlagId.CONTEXT_1M_20250807)
    })

    it("quota beta flags are a smaller set", () => {
      const headers = buildHeaders(mockAuth, "s", "quota")
      const flags = headers["anthropic-beta"].split(",")
      expect(flags).toHaveLength(5)
      expect(flags).not.toContain(BetaFlagId.CLAUDE_CODE_20250219)
      expect(flags).toContain(BetaFlagId.REDACT_THINKING_20260212)
    })

    // Pin the canonical opus-conversation flag string. Live 2.1.118 capture
    // sends 9 flags (.node-net-dbg/.../fetch-024-01-req-meta.json). minimal-agent
    // intentionally omits `redact-thinking-2026-02-12` so unsigned thinking
    // remains visible in this research client. Pinned ordering catches drift.
    it("opus conversation flag string matches the pinned ordering", () => {
      const headers = buildHeaders(mockAuth, "s", "conversation", "claude-opus-4-7")
      expect(headers["anthropic-beta"]).toBe(
        [
          "claude-code-20250219",
          "oauth-2025-04-20",
          "context-1m-2025-08-07",
          "interleaved-thinking-2025-05-14",
          // redact-thinking deliberately omitted (see buildBetaFlags note)
          "context-management-2025-06-27",
          "prompt-caching-scope-2026-01-05",
          "advanced-tool-use-2025-11-20",
          "effort-2025-11-24",
          // 2026-05-28: added for v2.1.154 parity with live capture
          "mid-conversation-system-2026-04-07",
          "extended-cache-ttl-2025-04-11",
        ].join(","),
      )
    })

    // Regression guard for TODOS.md T-7c3f02 (root cause:
    // private/tool-bugs-and-improvements/08-ROOT-CAUSE-corrected.md).
    // opus-4-8 with interleaved-thinking emits huge parallel tool batches whose
    // mid-turn thinking hallucinates same-turn tool results. We OMIT the
    // interleaved-thinking beta for opus-4-8 only; opus-4.6/4.7 + sonnet keep
    // it (they sequence tool use correctly).
    it("omits interleaved-thinking for opus-4-8 (T-7c3f02)", () => {
      const flags = buildBetaFlags("conversation", "claude-opus-4-8")
      expect(flags).not.toContain(BetaFlagId.INTERLEAVED_THINKING_20250514)
      // Still a normal conversation request otherwise.
      expect(flags).toContain(BetaFlagId.CLAUDE_CODE_20250219)
      expect(flags).toContain(BetaFlagId.CONTEXT_MANAGEMENT_20250627)
      expect(flags).toContain(BetaFlagId.CONTEXT_1M_20250807)
    })

    it("keeps interleaved-thinking for opus-4-7 and sonnet-4-6 (T-7c3f02 scope)", () => {
      expect(buildBetaFlags("conversation", "claude-opus-4-7")).toContain(
        BetaFlagId.INTERLEAVED_THINKING_20250514,
      )
      expect(buildBetaFlags("conversation", "claude-sonnet-4-6")).toContain(
        BetaFlagId.INTERLEAVED_THINKING_20250514,
      )
    })

    it("MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1 restores it for opus-4-8", () => {
      const prev = process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING
      process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING = "1"
      try {
        expect(buildBetaFlags("conversation", "claude-opus-4-8")).toContain(
          BetaFlagId.INTERLEAVED_THINKING_20250514,
        )
      } finally {
        if (prev === undefined) delete process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING
        else process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING = prev
      }
    })
  })

  describe("verify against captured traffic", () => {
    it("header keys match a real .node-net-dbg request", () => {
      let sessions: string[]
      try {
        sessions = readdirSync(NET_DBG_DIR).sort()
      } catch {
        console.warn("SKIP: .node-net-dbg not found")
        return
      }

      const latestSession = sessions[sessions.length - 1]
      if (!latestSession) return

      const sessionDir = join(NET_DBG_DIR, latestSession)
      const metaFiles = readdirSync(sessionDir)
        .filter((f) => f.includes("req-meta") && f.includes("fetch"))
        .sort()

      // Find a conversation request (not quota check — those omit claude-code beta)
      let capturedHeaders: Record<string, string> | null = null
      for (const file of metaFiles) {
        try {
          const raw = readFileSync(join(sessionDir, file), "utf-8")
          const meta = JSON.parse(raw)
          if (meta.headers?.["anthropic-beta"]?.includes("claude-code-20250219")) {
            capturedHeaders = meta.headers
            break
          }
        } catch {
          continue
        }
      }

      if (!capturedHeaders) {
        console.warn("SKIP: no captured conversation request found")
        return
      }

      // Our headers should have all the same keys
      const ourHeaders = buildHeaders(mockAuth, "test")
      const missingKeys: string[] = []
      for (const key of Object.keys(capturedHeaders)) {
        if (key === "authorization") continue // token differs
        if (!(key in ourHeaders)) {
          missingKeys.push(key)
        }
      }
      expect(missingKeys).toEqual([])

      // Static values: anthropic-version and x-app must match; user-agent
      // and package-version may drift when captured traffic is from a
      // newer CLI version than the one hardcoded in our constants.
      expect(capturedHeaders["anthropic-version"]).toBe(ANTHROPIC_VERSION)
      expect(capturedHeaders["x-app"]).toBe("cli")
      // User-agent format check (version may differ from captured traffic)
      expect(capturedHeaders["user-agent"]).toMatch(/^claude-cli\/[\d.]+ \(external, cli\)$/)
    })
  })
})

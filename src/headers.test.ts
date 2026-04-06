import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildHeaders,
  buildBetaFlags,
  VERSION,
  ANTHROPIC_VERSION,
  BETA_FLAGS,
  STAINLESS_SDK_VERSION,
  USER_AGENT,
} from "./headers.ts";
import type { AuthResult } from "./auth.ts";

const NET_DBG_DIR = join(
  process.env.HOME ?? "",
  "Projects/claude-cli-versions/.node-net-dbg",
);

describe("headers", () => {
  const mockAuth: AuthResult = {
    type: "oauth",
    token: "sk-ant-oat01-FAKE-TOKEN",
    accountUuid: "00000000-0000-0000-0000-000000000000",
  };

  describe("buildHeaders", () => {
    it("includes all expected keys for OAuth", () => {
      const headers = buildHeaders(mockAuth, "test-session-id");

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
      ];

      for (const key of expectedKeys) {
        expect(headers).toHaveProperty(key);
      }
    });

    it("sets correct static values", () => {
      const headers = buildHeaders(mockAuth, "sess-123");

      expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers["x-app"]).toBe("cli");
      expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
      expect(headers["x-stainless-package-version"]).toBe(STAINLESS_SDK_VERSION);
      expect(headers["x-stainless-lang"]).toBe("js");
      expect(headers["x-stainless-runtime"]).toBe("node");
      expect(headers["x-stainless-timeout"]).toBe("600");
      expect(headers["x-claude-code-session-id"]).toBe("sess-123");
    });

    it("sets authorization as Bearer for OAuth", () => {
      const headers = buildHeaders(mockAuth, "s");
      expect(headers.authorization).toBe("Bearer sk-ant-oat01-FAKE-TOKEN");
      expect(headers).not.toHaveProperty("x-api-key");
    });

    it("sets x-api-key for API key auth", () => {
      const apiKeyAuth: AuthResult = { type: "api-key", token: "sk-ant-123" };
      const headers = buildHeaders(apiKeyAuth, "s");
      expect(headers["x-api-key"]).toBe("sk-ant-123");
      expect(headers).not.toHaveProperty("authorization");
      // No beta flags for API key
      expect(headers).not.toHaveProperty("anthropic-beta");
    });

    it("x-client-request-id is a UUID", () => {
      const headers = buildHeaders(mockAuth, "s");
      expect(headers["x-client-request-id"]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("generates unique x-client-request-id per call", () => {
      const h1 = buildHeaders(mockAuth, "s");
      const h2 = buildHeaders(mockAuth, "s");
      expect(h1["x-client-request-id"]).not.toBe(h2["x-client-request-id"]);
    });

    it("beta flags match conversation set (default)", () => {
      const headers = buildHeaders(mockAuth, "s", "conversation");
      const flags = headers["anthropic-beta"].split(",");
      // Default conversation without model = no context-1m (opus-only)
      expect(flags).toEqual(buildBetaFlags("conversation"));
    });

    it("beta flags for opus include context-1m", () => {
      const headers = buildHeaders(mockAuth, "s", "conversation", "claude-opus-4-6");
      const flags = headers["anthropic-beta"].split(",");
      expect(flags).toContain("context-1m-2025-08-07");
    });

    it("quota beta flags are a smaller set", () => {
      const headers = buildHeaders(mockAuth, "s", "quota");
      const flags = headers["anthropic-beta"].split(",");
      expect(flags).toHaveLength(5);
      expect(flags).not.toContain("claude-code-20250219");
      expect(flags).toContain("redact-thinking-2026-02-12");
    });
  });

  describe("verify against captured traffic", () => {
    it("header keys match a real .node-net-dbg request", () => {
      let sessions: string[];
      try {
        sessions = readdirSync(NET_DBG_DIR).sort();
      } catch {
        console.warn("SKIP: .node-net-dbg not found");
        return;
      }

      const latestSession = sessions[sessions.length - 1];
      if (!latestSession) return;

      const sessionDir = join(NET_DBG_DIR, latestSession);
      const metaFiles = readdirSync(sessionDir)
        .filter((f) => f.includes("req-meta") && f.includes("fetch"))
        .sort();

      // Find a conversation request (not quota check — those omit claude-code beta)
      let capturedHeaders: Record<string, string> | null = null;
      for (const file of metaFiles) {
        try {
          const raw = readFileSync(join(sessionDir, file), "utf-8");
          const meta = JSON.parse(raw);
          if (
            meta.headers?.["anthropic-beta"]?.includes("claude-code-20250219")
          ) {
            capturedHeaders = meta.headers;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!capturedHeaders) {
        console.warn("SKIP: no captured conversation request found");
        return;
      }

      // Our headers should have all the same keys
      const ourHeaders = buildHeaders(mockAuth, "test");
      const missingKeys: string[] = [];
      for (const key of Object.keys(capturedHeaders)) {
        if (key === "authorization") continue; // token differs
        if (!(key in ourHeaders)) {
          missingKeys.push(key);
        }
      }
      expect(missingKeys).toEqual([]);

      // Static values must match exactly
      expect(capturedHeaders["anthropic-version"]).toBe(ANTHROPIC_VERSION);
      expect(capturedHeaders["user-agent"]).toBe(USER_AGENT);
      expect(capturedHeaders["x-app"]).toBe("cli");
      expect(capturedHeaders["x-stainless-package-version"]).toBe(
        STAINLESS_SDK_VERSION,
      );
    });
  });
});

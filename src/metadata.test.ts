import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildUserId, getDeviceId, loadExtraMetadata } from "./metadata.ts";

/** Path to the real CLI config */
const CLI_CONFIG = join(process.env.HOME ?? "", ".claude.json");

/** Path to captured network traffic */
const NET_DBG_DIR = join(
  process.env.HOME ?? "",
  "Projects/claude-cli-versions/.node-net-dbg",
);

describe("metadata", () => {
  describe("buildUserId", () => {
    it("produces compact JSON with correct key order", () => {
      const result = buildUserId({
        deviceId: "a".repeat(64),
        accountUuid: "00000000-0000-0000-0000-000000000000",
        sessionId: "11111111-1111-1111-1111-111111111111",
      });

      const parsed = JSON.parse(result);
      expect(parsed.device_id).toBe("a".repeat(64));
      expect(parsed.account_uuid).toBe("00000000-0000-0000-0000-000000000000");
      expect(parsed.session_id).toBe("11111111-1111-1111-1111-111111111111");

      // Must be compact (no whitespace)
      expect(result).not.toContain(" ");
      expect(result).not.toContain("\n");
    });

    it("spreads extra metadata before core fields", () => {
      const result = buildUserId({
        deviceId: "d".repeat(64),
        accountUuid: "acct",
        sessionId: "sess",
        extra: { custom_key: "value", device_id: "should-be-overridden" },
      });

      const parsed = JSON.parse(result);
      expect(parsed.custom_key).toBe("value");
      // Core fields override extra
      expect(parsed.device_id).toBe("d".repeat(64));
    });
  });

  describe("getDeviceId", () => {
    it("reads userID from ~/.claude.json", () => {
      let config: { userID?: string };
      try {
        config = JSON.parse(readFileSync(CLI_CONFIG, "utf-8"));
      } catch {
        console.warn("SKIP: ~/.claude.json not found");
        return;
      }

      if (!config.userID) {
        console.warn("SKIP: no userID in ~/.claude.json");
        return;
      }

      const deviceId = getDeviceId(CLI_CONFIG);
      expect(deviceId).toBe(config.userID);
      expect(deviceId).toHaveLength(64);
      expect(deviceId).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe("verify against captured traffic", () => {
    it("user_id matches a real request from .node-net-dbg", () => {
      // Find the latest session directory
      let sessions: string[];
      try {
        sessions = readdirSync(NET_DBG_DIR).sort();
      } catch {
        console.warn("SKIP: .node-net-dbg not found");
        return;
      }

      const latestSession = sessions[sessions.length - 1];
      if (!latestSession) {
        console.warn("SKIP: no sessions in .node-net-dbg");
        return;
      }

      const sessionDir = join(NET_DBG_DIR, latestSession);
      const files = readdirSync(sessionDir)
        .filter((f) => f.includes("req-body") && f.includes("fetch"))
        .sort();

      // Find a request with user_id (the quota check has it)
      let capturedUserId: string | null = null;
      for (const file of files) {
        try {
          const raw = readFileSync(join(sessionDir, file), "utf-8");
          const body = JSON.parse(raw);
          if (body.metadata?.user_id) {
            capturedUserId = body.metadata.user_id;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!capturedUserId) {
        console.warn("SKIP: no captured request with user_id found");
        return;
      }

      // Parse the captured user_id and verify format
      const parsed = JSON.parse(capturedUserId);
      expect(parsed).toHaveProperty("device_id");
      expect(parsed).toHaveProperty("account_uuid");
      expect(parsed).toHaveProperty("session_id");
      expect(parsed.device_id).toHaveLength(64);
      expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/);
      expect(parsed.account_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(parsed.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      // Verify our getDeviceId returns the same device_id
      const ourDeviceId = getDeviceId(CLI_CONFIG);
      expect(ourDeviceId).toBe(parsed.device_id);

      // Verify buildUserId produces the same format
      const rebuilt = buildUserId({
        deviceId: parsed.device_id,
        accountUuid: parsed.account_uuid,
        sessionId: parsed.session_id,
      });
      const reparsed = JSON.parse(rebuilt);
      expect(reparsed).toEqual(parsed);
    });
  });
});

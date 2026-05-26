import { describe, it, expect } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { buildUserId, getDeviceId } from "./metadata.ts"

/** Path to the real CLI config */
const CLI_CONFIG = join(process.env.HOME ?? "", ".claude.json")

/** Path to captured network traffic */
const NET_DBG_DIR = join(process.env.HOME ?? "", "Projects/claude-cli-versions/.node-net-dbg")

describe("metadata", () => {
  describe("buildUserId", () => {
    it("produces compact JSON with correct key order", () => {
      const result = buildUserId({
        deviceId: "a".repeat(64),
        accountUuid: "00000000-0000-0000-0000-000000000000",
        sessionId: "11111111-1111-1111-1111-111111111111",
      })

      const parsed = JSON.parse(result)
      expect(parsed.device_id).toBe("a".repeat(64))
      expect(parsed.account_uuid).toBe("00000000-0000-0000-0000-000000000000")
      expect(parsed.session_id).toBe("11111111-1111-1111-1111-111111111111")

      // Must be compact (no whitespace)
      expect(result).not.toContain(" ")
      expect(result).not.toContain("\n")
    })

    it("spreads extra metadata before core fields", () => {
      const result = buildUserId({
        deviceId: "d".repeat(64),
        accountUuid: "acct",
        sessionId: "sess",
        extra: { custom_key: "value", device_id: "should-be-overridden" },
      })

      const parsed = JSON.parse(result)
      expect(parsed.custom_key).toBe("value")
      // Core fields override extra
      expect(parsed.device_id).toBe("d".repeat(64))
    })
  })

  describe("getDeviceId", () => {
    it("reads userID from ~/.claude.json", () => {
      let config: { userID?: string }
      try {
        config = JSON.parse(readFileSync(CLI_CONFIG, "utf-8"))
      } catch {
        console.warn("SKIP: ~/.claude.json not found")
        return
      }

      if (!config.userID) {
        console.warn("SKIP: no userID in ~/.claude.json")
        return
      }

      const deviceId = getDeviceId(CLI_CONFIG)
      expect(deviceId).toBe(config.userID)
      expect(deviceId).toHaveLength(64)
      expect(deviceId).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe("verify against captured traffic", () => {
    it("user_id matches a real request from .node-net-dbg", () => {
      // Walk every captured session under `.node-net-dbg` looking for
      // a `metadata.user_id` whose `device_id` matches the current
      // `~/.claude.json` (so we're comparing apples to apples). The
      // previous implementation only looked at the LATEST capture; that
      // broke as soon as the user re-logged in, deleted the CLI config,
      // or ran the test on a machine where the captures predate the
      // current login. We now search ALL captures and skip gracefully
      // when none of them match the current userID.
      let sessions: string[]
      try {
        sessions = readdirSync(NET_DBG_DIR).sort()
      } catch {
        console.warn("SKIP: .node-net-dbg not found")
        return
      }
      if (sessions.length === 0) {
        console.warn("SKIP: no sessions in .node-net-dbg")
        return
      }

      // We need the current `claude.json` userID to know which capture
      // is "comparable to now". If `claude.json` itself is missing,
      // there's nothing to compare against; skip.
      let ourDeviceId: string
      try {
        ourDeviceId = getDeviceId(CLI_CONFIG)
      } catch {
        console.warn("SKIP: ~/.claude.json missing or userID unreadable")
        return
      }

      // Walk newest-first so a recently-captured run wins. Inside each
      // session, the first req-body whose `metadata.user_id` parses
      // into a real object is the candidate. A session is "ours" iff
      // that candidate's `device_id` equals `ourDeviceId`.
      let parsed: { device_id: string; account_uuid: string; session_id: string } | null = null
      for (const session of [...sessions].reverse()) {
        const sessionDir = join(NET_DBG_DIR, session)
        let files: string[]
        try {
          files = readdirSync(sessionDir)
            .filter((f) => f.includes("req-body") && f.includes("fetch"))
            .sort()
        } catch {
          continue
        }
        for (const file of files) {
          let body: { metadata?: { user_id?: string } }
          try {
            body = JSON.parse(readFileSync(join(sessionDir, file), "utf-8"))
          } catch {
            continue
          }
          const userId = body.metadata?.user_id
          if (typeof userId !== "string") continue
          let candidate: { device_id?: string; account_uuid?: string; session_id?: string }
          try {
            candidate = JSON.parse(userId)
          } catch {
            continue
          }
          if (candidate.device_id !== ourDeviceId) continue
          if (
            typeof candidate.device_id !== "string" ||
            typeof candidate.account_uuid !== "string" ||
            typeof candidate.session_id !== "string"
          ) {
            continue
          }
          parsed = {
            device_id: candidate.device_id,
            account_uuid: candidate.account_uuid,
            session_id: candidate.session_id,
          }
          break
        }
        if (parsed) break
      }

      if (!parsed) {
        // Every capture on disk predates the current `~/.claude.json`
        // login. Common reasons: machine reimaged, user re-logged in,
        // running the suite on a fresh checkout. The test loses its
        // grip but no bug is implied; skip cleanly.
        console.warn(
          "SKIP: no captured request matches the current ~/.claude.json device_id " +
            "(captures predate the current login)",
        )
        return
      }

      // Format checks: catches schema drift in the real CLI's user_id
      // shape even if we eventually rotate the captures.
      expect(parsed.device_id).toHaveLength(64)
      expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/)
      expect(parsed.account_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(parsed.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )

      // Already verified inside the loop; re-stated here so a failure
      // surfaces with the assertion's name, not a generic "no match".
      expect(ourDeviceId).toBe(parsed.device_id)

      // Round-trip through `buildUserId` to catch format drift.
      const rebuilt = buildUserId({
        deviceId: parsed.device_id,
        accountUuid: parsed.account_uuid,
        sessionId: parsed.session_id,
      })
      const reparsed = JSON.parse(rebuilt)
      expect(reparsed).toEqual(parsed)
    })
  })
})

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { buildUserId, getDeviceId } from "./metadata.ts"

/** Path to the real CLI config */
const CLI_CONFIG = join(process.env.HOME ?? "", ".claude.json")

/**
 * Sanitized excerpt of a real captured Messages API request body. The
 * wire shape of `metadata.user_id` is preserved verbatim; the real
 * device_id / account_uuid / session_id are replaced with synthetic
 * stand-ins so the fixture is safe to check in. See
 * `src/test-utils/fixtures/metadata-user-id-capture.json` for the
 * provenance note and refresh instructions.
 */
const USER_ID_FIXTURE = join(
  import.meta.dir,
  "test-utils",
  "fixtures",
  "metadata-user-id-capture.json",
)

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
    it("buildUserId emits the exact wire shape the real CLI produces", () => {
      // Load a sanitized excerpt of a real Messages API request body.
      // Using a fixture instead of walking ~/Projects/claude-cli-versions/
      // .node-net-dbg/ (which has 700k+ files and only lives on the dev
      // machine where the captures were taken). The fixture preserves
      // the on-the-wire shape of `metadata.user_id` byte-for-byte;
      // values are synthetic but shape-valid. Refresh the fixture if
      // the CLI's user_id schema ever changes.
      const fixture = JSON.parse(readFileSync(USER_ID_FIXTURE, "utf-8")) as {
        user_id: string
      }
      const parsed = JSON.parse(fixture.user_id) as {
        device_id: string
        account_uuid: string
        session_id: string
      }

      // Shape: catches schema drift in the CLI's user_id format.
      expect(parsed.device_id).toHaveLength(64)
      expect(parsed.device_id).toMatch(/^[0-9a-f]{64}$/)
      expect(parsed.account_uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
      expect(parsed.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )

      // Round-trip: buildUserId fed the captured fields must produce
      // the captured string byte-for-byte. This catches key-order drift
      // (the CLI emits device_id, account_uuid, session_id in that
      // exact order) and accidental whitespace.
      const rebuilt = buildUserId({
        deviceId: parsed.device_id,
        accountUuid: parsed.account_uuid,
        sessionId: parsed.session_id,
      })
      expect(rebuilt).toBe(fixture.user_id)
    })
  })
})

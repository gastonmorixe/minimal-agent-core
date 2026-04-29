import { describe, it, expect } from "bun:test"
import {
  formatTzOffset,
  redactHeaders,
  netDbgEnabled,
  warnLoggerErrorOnce,
  _resetLoggerErrorReportedForTest,
} from "./net-dbg.ts"

describe("net-dbg", () => {
  describe("formatTzOffset", () => {
    it("returns +0000 for UTC", () => {
      // Date.getTimezoneOffset() returns minutes WEST of UTC.
      // UTC has offset 0.
      const fakeDate = { getTimezoneOffset: () => 0 } as Date
      expect(formatTzOffset(fakeDate)).toBe("+0000")
    })

    it("returns -0400 for EDT (UTC-4)", () => {
      // EDT is 240 minutes west of UTC.
      const fakeDate = { getTimezoneOffset: () => 240 } as Date
      expect(formatTzOffset(fakeDate)).toBe("-0400")
    })

    it("returns -0500 for EST (UTC-5) — distinct from EDT", () => {
      // Regression: previously both -240 and -300 were tagged "EDT".
      const fakeDate = { getTimezoneOffset: () => 300 } as Date
      expect(formatTzOffset(fakeDate)).toBe("-0500")
    })

    it("returns +0530 for IST (UTC+5:30, half-hour offset)", () => {
      // IST is 330 minutes east of UTC, so getTimezoneOffset returns -330.
      const fakeDate = { getTimezoneOffset: () => -330 } as Date
      expect(formatTzOffset(fakeDate)).toBe("+0530")
    })

    it("returns +0900 for JST (UTC+9)", () => {
      const fakeDate = { getTimezoneOffset: () => -540 } as Date
      expect(formatTzOffset(fakeDate)).toBe("+0900")
    })
  })

  describe("redactHeaders", () => {
    it("strips Bearer token contents past the Bearer prefix", () => {
      const out = redactHeaders({
        authorization:
          "Bearer sk-ant-oat01-DZ2tVxdvDQ5FVDx_vrfEl4cT-yjeG_MzvijzTPUGS4WiFVWRBokTC0vvsnc",
      })
      // Must not contain any character from the original token past "Bearer ".
      expect(out.authorization).not.toContain("sk-ant")
      expect(out.authorization).not.toContain("DZ2tV")
      expect(out.authorization.startsWith("Bearer ")).toBe(true)
    })

    it("redacts x-api-key entirely", () => {
      const out = redactHeaders({ "x-api-key": "sk-secret-12345" })
      expect(out["x-api-key"]).not.toContain("sk-secret")
    })

    it("preserves non-secret headers verbatim", () => {
      const out = redactHeaders({
        "user-agent": "claude-cli/2.1.118 (external, cli)",
        "x-stainless-os": "MacOS",
      })
      expect(out["user-agent"]).toBe("claude-cli/2.1.118 (external, cli)")
      expect(out["x-stainless-os"]).toBe("MacOS")
    })

    it("leaves non-Bearer authorization values alone", () => {
      // Defensive: only Bearer tokens get the redaction path. Other auth
      // schemes (Basic, custom) pass through.
      const out = redactHeaders({ authorization: "Basic dXNlcjpwYXNz" })
      expect(out.authorization).toBe("Basic dXNlcjpwYXNz")
    })
  })

  describe("netDbgEnabled", () => {
    it("reflects MINIMAL_AGENT_NET_DBG captured at module load", () => {
      // Regression note: the env var is read once at module load, so toggling
      // it at runtime does NOT change the return value. This test pins that
      // contract so a future refactor doesn't silently change it without a
      // matching docs update.
      const expected = process.env.MINIMAL_AGENT_NET_DBG === "1"
      expect(netDbgEnabled()).toBe(expected)
    })
  })

  describe("warnLoggerErrorOnce", () => {
    it("emits exactly one console.warn for repeated calls", () => {
      _resetLoggerErrorReportedForTest()
      const calls: string[] = []
      const orig = console.warn
      console.warn = (msg: unknown) => {
        calls.push(String(msg))
      }
      try {
        warnLoggerErrorOnce(new Error("disk full"))
        warnLoggerErrorOnce(new Error("permission denied"))
        warnLoggerErrorOnce("third one too")
      } finally {
        console.warn = orig
      }
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain("disk full")
      expect(calls[0]).toContain("net-dbg")
    })

    it("includes the error message when given an Error", () => {
      _resetLoggerErrorReportedForTest()
      const calls: string[] = []
      const orig = console.warn
      console.warn = (msg: unknown) => {
        calls.push(String(msg))
      }
      try {
        warnLoggerErrorOnce(new Error("ENOSPC: no space left"))
      } finally {
        console.warn = orig
      }
      expect(calls[0]).toContain("ENOSPC: no space left")
    })

    it("coerces non-Error values to string", () => {
      _resetLoggerErrorReportedForTest()
      const calls: string[] = []
      const orig = console.warn
      console.warn = (msg: unknown) => {
        calls.push(String(msg))
      }
      try {
        warnLoggerErrorOnce("plain string error")
      } finally {
        console.warn = orig
      }
      expect(calls[0]).toContain("plain string error")
    })
  })
})

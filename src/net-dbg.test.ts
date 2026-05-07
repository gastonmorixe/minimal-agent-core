import { describe, it, expect } from "bun:test"
import {
  formatTzOffset,
  formatSessionDirName,
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

  describe("formatSessionDirName", () => {
    // A fixed UUID-shaped sid so tests don't depend on randomUUID() output.
    const SID = "34b34421-3b9d-48a0-8807-9e48f0046e03"

    // Build a Date stand-in that returns deterministic local-time fields,
    // independent of the host TZ. We intentionally don't use `new Date(iso)`
    // because that would make the assertions TZ-dependent.
    function fakeDate(parts: {
      year: number
      month: number // 0-indexed (Date convention)
      day: number
      weekday: number // 0=Sunday
      hours: number
      minutes: number
      seconds: number
      tzOffsetMin: number // minutes WEST of UTC, matches getTimezoneOffset()
    }): Date {
      return {
        getFullYear: () => parts.year,
        getMonth: () => parts.month,
        getDate: () => parts.day,
        getDay: () => parts.weekday,
        getHours: () => parts.hours,
        getMinutes: () => parts.minutes,
        getSeconds: () => parts.seconds,
        getTimezoneOffset: () => parts.tzOffsetMin,
      } as unknown as Date
    }

    it("matches the documented shape: <epoch>-<DD>-<MON>-<YYYY>-<WEEKDAY>--<HH>h<MM>m<SS>s<±HHMM>-minimal-agent-<sid>", () => {
      // 2026-05-06 19:25:12 EDT (UTC-4), a Wednesday.
      const d = fakeDate({
        year: 2026,
        month: 4, // May
        day: 6,
        weekday: 3, // Wednesday
        hours: 19,
        minutes: 25,
        seconds: 12,
        tzOffsetMin: 240,
      })
      const name = formatSessionDirName(1778109912827, d, SID)
      expect(name).toBe(`1778109912827-06-MAY-2026-WEDNESDAY--19h25m12s-0400-minimal-agent-${SID}`)
    })

    it("zero-pads single-digit day/hour/minute/second fields", () => {
      // 2026-01-02 03:04:05, Friday, UTC. Every clock field is single-digit.
      const d = fakeDate({
        year: 2026,
        month: 0, // January
        day: 2,
        weekday: 5, // Friday
        hours: 3,
        minutes: 4,
        seconds: 5,
        tzOffsetMin: 0,
      })
      const name = formatSessionDirName(1, d, SID)
      expect(name).toBe(`1-02-JAN-2026-FRIDAY--03h04m05s+0000-minimal-agent-${SID}`)
    })

    it("includes the session id verbatim at the end", () => {
      // Regression: the sid suffix is what lets a recording be cross-
      // referenced with the agent's session id (and the corresponding
      // ~/.minimal-agent/sessions/<sid>.jsonl). Pin that it ends with the
      // exact UUID, not a truncated/short version.
      const d = fakeDate({
        year: 2026,
        month: 4,
        day: 6,
        weekday: 3,
        hours: 19,
        minutes: 25,
        seconds: 12,
        tzOffsetMin: 240,
      })
      const name = formatSessionDirName(1778109912827, d, SID)
      expect(name.endsWith(`-${SID}`)).toBe(true)
      expect(name).toContain(SID)
    })

    it("starts with the epoch (lexicographic-by-time sort is preserved)", () => {
      // Regression: the leading epoch is what makes `ls .net-dbg/` come out
      // chronologically. If a future refactor moves the epoch later in the
      // name, sorting silently breaks. Pin the leading position.
      const d = fakeDate({
        year: 2026,
        month: 4,
        day: 6,
        weekday: 3,
        hours: 19,
        minutes: 25,
        seconds: 12,
        tzOffsetMin: 240,
      })
      expect(formatSessionDirName(1, d, SID).startsWith("1-")).toBe(true)
      expect(formatSessionDirName(999999999999, d, SID).startsWith("999999999999-")).toBe(true)
    })

    it("contains the literal '-minimal-agent-' tag immediately before the sid", () => {
      // Regression: external tooling (or a curious user grepping `ls`) keys
      // off the `-minimal-agent-<sid>` suffix to find this agent's recordings
      // among unrelated `.net-dbg/` siblings. Pin that the tag is present
      // and adjacent to the sid.
      const d = fakeDate({
        year: 2026,
        month: 4,
        day: 6,
        weekday: 3,
        hours: 19,
        minutes: 25,
        seconds: 12,
        tzOffsetMin: 240,
      })
      const name = formatSessionDirName(1778109912827, d, SID)
      expect(name).toContain(`-minimal-agent-${SID}`)
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

import { describe, expect, it } from "bun:test"

import { getDiagnosticBus, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { createNetDebugObserver } from "../network/net-dbg-observer.ts"

import {
  _resetLoggerErrorReportedForTest,
  formatSessionDirName,
  formatTzOffset,
  netDbgSessionDir,
  redactHeaders,
  warnLoggerErrorOnce,
} from "./net-dbg.ts"

/** Run `fn` and return the warning diagnostics it emitted. */
function captureWarnings(fn: () => void): LogEvent[] {
  const events: LogEvent[] = []
  const off = getDiagnosticBus().on(Severity.Warning, (e) => events.push(e))
  try {
    fn()
  } finally {
    off()
  }
  return events
}

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
    const SID = "00000000-0000-4000-8000-bad9c9054767"

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

  describe("netDbgSessionDir", () => {
    const SID = "00000000-0000-4000-8000-bad9c9054767"
    const d = {
      getFullYear: () => 2026,
      getMonth: () => 4,
      getDate: () => 6,
      getDay: () => 3,
      getHours: () => 19,
      getMinutes: () => 25,
      getSeconds: () => 12,
      getTimezoneOffset: () => 240,
    } as unknown as Date

    it("places the recording under <agent-home>/net-dbg, NOT the cwd", () => {
      // Regression: net-dbg historically wrote to `${cwd}/.net-dbg`, which
      // scattered captures across every project dir. It now lives under the
      // resolved agent home so all captures collect in one place.
      const dir = netDbgSessionDir(1778109912827, d, SID, {
        MINIMAL_AGENT_HOME: "/tmp/ma-home",
      })
      expect(dir).toBe(
        `/tmp/ma-home/net-dbg/1778109912827-06-MAY-2026-WEDNESDAY--19h25m12s-0400-minimal-agent-${SID}`,
      )
      expect(dir.startsWith("/tmp/ma-home/net-dbg/")).toBe(true)
      expect(dir).not.toContain(`${process.cwd()}/.net-dbg`)
    })

    it("honors MINIMAL_AGENT_HOME relocation for the base", () => {
      const dir = netDbgSessionDir(1, d, SID, { MINIMAL_AGENT_HOME: "/relocated/ma" })
      expect(dir.startsWith("/relocated/ma/net-dbg/")).toBe(true)
    })

    it("composes the leaf name from formatSessionDirName verbatim", () => {
      const env = { MINIMAL_AGENT_HOME: "/tmp/ma" }
      const dir = netDbgSessionDir(42, d, SID, env)
      expect(dir).toBe(`/tmp/ma/net-dbg/${formatSessionDirName(42, d, SID)}`)
    })
  })

  describe("redactHeaders", () => {
    it("strips Bearer token contents past the Bearer prefix", () => {
      const out = redactHeaders({
        authorization: "Bearer sk-ant-oat01-FAKE-TOKEN-FOR-REDACTION-TEST-0123456789abcdef",
      })
      // Must not contain any character from the original token past "Bearer ".
      expect(out.authorization).not.toContain("sk-ant")
      expect(out.authorization).not.toContain("FAKE-TOKEN")
      expect(out.authorization.startsWith("Bearer ")).toBe(true)
    })

    it("redacts x-api-key entirely", () => {
      const out = redactHeaders({ "x-api-key": "sk-secret-12345" })
      expect(out["x-api-key"]).not.toContain("sk-secret")
    })

    it("preserves non-secret headers verbatim", () => {
      const out = redactHeaders({
        "user-agent": "test-cli/2.1.118 (external, cli)",
        "x-test-os": "MacOS",
      })
      expect(out["user-agent"]).toBe("test-cli/2.1.118 (external, cli)")
      expect(out["x-test-os"]).toBe("MacOS")
    })

    it("leaves non-Bearer authorization values alone", () => {
      // Defensive: only Bearer tokens get the redaction path. Other auth
      // schemes (Basic, custom) pass through.
      const out = redactHeaders({ authorization: "Basic dXNlcjpwYXNz" })
      expect(out.authorization).toBe("Basic dXNlcjpwYXNz")
    })
  })

  describe("createNetDebugObserver", () => {
    it("takes its level as an argument: disabled means no handlers", () => {
      // The logger reads neither env nor config (spec S26). The network
      // client resolves the level once and passes it in.
      expect(createNetDebugObserver({ enabled: false })).toEqual({})
      const on = createNetDebugObserver({ enabled: true })
      expect(typeof on.onRequest).toBe("function")
      expect(typeof on.onEnd).toBe("function")
    })
  })

  describe("warnLoggerErrorOnce", () => {
    it("emits exactly one warning diagnostic for repeated calls", () => {
      _resetLoggerErrorReportedForTest()
      const events = captureWarnings(() => {
        warnLoggerErrorOnce(new Error("disk full"))
        warnLoggerErrorOnce(new Error("permission denied"))
        warnLoggerErrorOnce("third one too")
      })
      expect(events).toHaveLength(1)
      expect(events[0]?.message).toContain("disk full")
      expect(events[0]?.source).toContain("net-dbg")
    })

    it("includes the error message when given an Error", () => {
      _resetLoggerErrorReportedForTest()
      const events = captureWarnings(() => warnLoggerErrorOnce(new Error("ENOSPC: no space left")))
      expect(events[0]?.message).toContain("ENOSPC: no space left")
    })

    it("coerces non-Error values to string", () => {
      _resetLoggerErrorReportedForTest()
      const events = captureWarnings(() => warnLoggerErrorOnce("plain string error"))
      expect(events[0]?.message).toContain("plain string error")
    })

    it("latches once per diagnostics handle, so each session handle gets its own warning", () => {
      _resetLoggerErrorReportedForTest()
      const a: LogEvent[] = []
      const b: LogEvent[] = []
      const handleA = createDiagnostics({ emit: (e) => a.push(e) }, { sessionId: "sess-a" })
      const handleB = createDiagnostics({ emit: (e) => b.push(e) }, { sessionId: "sess-b" })
      warnLoggerErrorOnce(new Error("disk full A"), handleA)
      warnLoggerErrorOnce(new Error("disk full A again"), handleA)
      warnLoggerErrorOnce(new Error("disk full B"), handleB)
      warnLoggerErrorOnce(new Error("disk full B again"), handleB)
      expect(a.map((e) => e.message)).toEqual([expect.stringContaining("disk full A")])
      expect(b.map((e) => e.message)).toEqual([expect.stringContaining("disk full B")])
      expect(a[0]?.sessionId).toBe("sess-a")
      expect(b[0]?.sessionId).toBe("sess-b")
    })
  })
})

describe("resolveNetDbgEnabled", () => {
  it("env=1 forces on, env=0 forces off, otherwise config decides", async () => {
    const { resolveNetDbgEnabled } = await import("./net-dbg.ts")
    expect(resolveNetDbgEnabled("1", false)).toBe(true)
    expect(resolveNetDbgEnabled("0", true)).toBe(false)
    expect(resolveNetDbgEnabled(undefined, true)).toBe(true)
    expect(resolveNetDbgEnabled(undefined, false)).toBe(false)
    expect(resolveNetDbgEnabled(undefined, undefined)).toBe(false)
  })
})

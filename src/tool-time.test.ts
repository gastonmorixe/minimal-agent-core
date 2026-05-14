import { describe, expect, it } from "bun:test"
import { fmtToolTime, ToolTimeTracker } from "./tool-time.ts"

// Local-TZ epoch helper: builds a Date in the test process's TZ for the
// given Y/M/D/h/m/s and returns the epoch ms. We deliberately use the
// local-TZ getters (the production code uses `d.getHours()` etc.), so a
// local-TZ-constructed date round-trips cleanly regardless of the host's
// TZ. Using `Date.UTC` here would mis-align in non-UTC zones.
function ms(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

describe("fmtToolTime — cold start (lastShownDay is null)", () => {
  it("returns Mon DD HH:MM:SS", () => {
    const out = fmtToolTime(ms(2026, 5, 14, 15, 42, 3), null)
    expect(out.text).toBe("May 14 15:42:03")
    expect(out.day).toBe(new Date(2026, 4, 14).toDateString())
  })

  it("zero-pads single-digit hours/minutes/seconds", () => {
    const out = fmtToolTime(ms(2026, 1, 5, 9, 7, 4), null)
    expect(out.text).toBe("Jan 5 09:07:04")
  })

  it("does NOT zero-pad single-digit day", () => {
    const out = fmtToolTime(ms(2026, 3, 9, 0, 0, 0), null)
    // Avoiding "Mar 09" — `Mon DD` reads more naturally without zero-pad.
    expect(out.text).toBe("Mar 9 00:00:00")
  })
})

describe("fmtToolTime — same day (lastShownDay matches)", () => {
  it("drops the date prefix and returns just HH:MM:SS", () => {
    const earlier = fmtToolTime(ms(2026, 5, 14, 9, 0, 0), null)
    const later = fmtToolTime(ms(2026, 5, 14, 9, 0, 1), earlier.day)
    expect(later.text).toBe("09:00:01")
    expect(later.day).toBe(earlier.day)
  })

  it("preserves the day key across calls on the same day", () => {
    const a = fmtToolTime(ms(2026, 7, 4, 10, 0, 0), null)
    const b = fmtToolTime(ms(2026, 7, 4, 23, 59, 59), a.day)
    expect(a.day).toBe(b.day)
    expect(b.text).toBe("23:59:59")
  })
})

describe("fmtToolTime — day rollover", () => {
  it("re-emits Mon DD when the calendar day changes", () => {
    const dayOne = fmtToolTime(ms(2026, 5, 14, 23, 59, 59), null)
    const dayTwo = fmtToolTime(ms(2026, 5, 15, 0, 0, 1), dayOne.day)
    expect(dayTwo.text).toBe("May 15 00:00:01")
    expect(dayTwo.day).not.toBe(dayOne.day)
  })

  it("re-emits Mon DD across month boundaries", () => {
    const a = fmtToolTime(ms(2026, 5, 31, 23, 59, 59), null)
    const b = fmtToolTime(ms(2026, 6, 1, 0, 0, 0), a.day)
    expect(b.text).toBe("Jun 1 00:00:00")
  })

  it("re-emits Mon DD across year boundaries (year still hidden inline)", () => {
    const a = fmtToolTime(ms(2026, 12, 31, 23, 59, 59), null)
    const b = fmtToolTime(ms(2027, 1, 1, 0, 0, 0), a.day)
    expect(b.text).toBe("Jan 1 00:00:00")
    // The day key DOES include the year, so the prefix correctly
    // re-emits on Jan 1 even though the inline display omits it.
    expect(a.day).not.toBe(b.day)
  })
})

describe("fmtToolTime — month coverage", () => {
  it("formats every month with its English short name", () => {
    const expected = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ]
    for (let i = 0; i < 12; i++) {
      const out = fmtToolTime(ms(2026, i + 1, 15, 12, 0, 0), null)
      expect(out.text.startsWith(`${expected[i]} 15 `)).toBe(true)
    }
  })
})

describe("ToolTimeTracker", () => {
  it("emits date prefix on cold start, drops it on same-day repeats", () => {
    const t = new ToolTimeTracker()
    expect(t.format(ms(2026, 5, 14, 15, 42, 3))).toBe("May 14 15:42:03")
    expect(t.format(ms(2026, 5, 14, 15, 42, 7))).toBe("15:42:07")
    expect(t.format(ms(2026, 5, 14, 16, 0, 0))).toBe("16:00:00")
  })

  it("re-emits date prefix once on day rollover, then drops again", () => {
    const t = new ToolTimeTracker()
    t.format(ms(2026, 5, 14, 23, 0, 0)) // primes day = May 14
    expect(t.format(ms(2026, 5, 15, 0, 0, 1))).toBe("May 15 00:00:01")
    expect(t.format(ms(2026, 5, 15, 0, 0, 5))).toBe("00:00:05")
  })

  it("reset() forces the date prefix on the next call", () => {
    const t = new ToolTimeTracker()
    t.format(ms(2026, 5, 14, 9, 0, 0))
    expect(t.format(ms(2026, 5, 14, 9, 0, 1))).toBe("09:00:01")
    t.reset()
    expect(t.format(ms(2026, 5, 14, 9, 0, 2))).toBe("May 14 09:00:02")
  })
})

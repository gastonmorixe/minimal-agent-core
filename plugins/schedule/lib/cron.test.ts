/**
 * Tests for the 5-field cron parser + evaluator.
 *
 * @module schedule/lib/cron.test
 */

import { describe, expect, it } from "bun:test"

import { CronError, isValidCron, matches, nextFire, parseCron } from "./cron.ts"

/** Local-time Date builder. month is 1-based for readability. */
function at(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

describe("parseCron — acceptance", () => {
  it("accepts the canonical examples from the docs", () => {
    for (const e of [
      "*/5 * * * *",
      "0 * * * *",
      "7 * * * *",
      "0 9 * * *",
      "0 9 * * 1-5",
      "30 14 15 3 *",
      "1,15,30 * * * *",
      "0 0 1 1 *",
      "0 9 * * 0",
      "0 9 * * 7",
    ]) {
      expect(isValidCron(e)).toBe(true)
    }
  })

  it("collapses extra whitespace", () => {
    expect(isValidCron("  */5   *  *   *   *  ")).toBe(true)
  })
})

describe("parseCron — rejection", () => {
  it("rejects wrong field counts", () => {
    expect(() => parseCron("* * * *")).toThrow(CronError)
    expect(() => parseCron("* * * * * *")).toThrow(CronError)
    expect(() => parseCron("")).toThrow(CronError)
  })

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/)
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/)
    expect(() => parseCron("* * 0 * *")).toThrow(/out of range/) // dom min is 1
    expect(() => parseCron("* * * 13 *")).toThrow(/out of range/)
    expect(() => parseCron("* * * * 8")).toThrow(/out of range/)
  })

  it("rejects extended syntax (names, L, W, ?, #)", () => {
    expect(() => parseCron("* * * * MON")).toThrow(CronError)
    expect(() => parseCron("0 0 L * *")).toThrow(CronError)
    expect(() => parseCron("0 0 15W * *")).toThrow(CronError)
    expect(() => parseCron("0 0 ? * *")).toThrow(CronError)
    expect(() => parseCron("0 0 * * 1#2")).toThrow(CronError)
    expect(() => parseCron("0 0 * JAN *")).toThrow(CronError)
  })

  it("rejects malformed steps and ranges", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(CronError)
    expect(() => parseCron("*/-1 * * * *")).toThrow(CronError)
    expect(() => parseCron("5-1 * * * *")).toThrow(/out of range/) // lo > hi
  })
})

describe("matches", () => {
  it("every 5 minutes", () => {
    const e = parseCron("*/5 * * * *")
    expect(matches(e, at(2026, 5, 30, 10, 0))).toBe(true)
    expect(matches(e, at(2026, 5, 30, 10, 5))).toBe(true)
    expect(matches(e, at(2026, 5, 30, 10, 3))).toBe(false)
  })

  it("daily at 9am local", () => {
    const e = parseCron("0 9 * * *")
    expect(matches(e, at(2026, 5, 30, 9, 0))).toBe(true)
    expect(matches(e, at(2026, 5, 30, 9, 1))).toBe(false)
    expect(matches(e, at(2026, 5, 30, 8, 0))).toBe(false)
  })

  it("weekdays at 9am (dow range)", () => {
    const e = parseCron("0 9 * * 1-5")
    // 2026-05-29 is a Friday; 2026-05-30 is a Saturday.
    expect(matches(e, at(2026, 5, 29, 9, 0))).toBe(true)
    expect(matches(e, at(2026, 5, 30, 9, 0))).toBe(false)
  })

  it("specific date (March 15 at 2:30pm)", () => {
    const e = parseCron("30 14 15 3 *")
    expect(matches(e, at(2026, 3, 15, 14, 30))).toBe(true)
    expect(matches(e, at(2026, 3, 16, 14, 30))).toBe(false)
  })

  it("sunday via both 0 and 7", () => {
    // 2026-05-31 is a Sunday.
    expect(matches(parseCron("0 9 * * 0"), at(2026, 5, 31, 9, 0))).toBe(true)
    expect(matches(parseCron("0 9 * * 7"), at(2026, 5, 31, 9, 0))).toBe(true)
  })

  it("vixie OR semantics: dom AND dow both constrained → either matches", () => {
    // "at 00:00 on day-of-month 1 OR on Monday"
    const e = parseCron("0 0 1 * 1")
    // 2026-06-01 is a Monday → matches (both, certainly true)
    expect(matches(e, at(2026, 6, 1, 0, 0))).toBe(true)
    // 2026-06-08 is a Monday, not the 1st → still matches (dow)
    expect(matches(e, at(2026, 6, 8, 0, 0))).toBe(true)
    // 2026-07-01 is a Wednesday, the 1st → matches (dom)
    expect(matches(e, at(2026, 7, 1, 0, 0))).toBe(true)
    // 2026-06-10 is a Wednesday, the 10th → matches neither
    expect(matches(e, at(2026, 6, 10, 0, 0))).toBe(false)
  })

  it("AND semantics when only one of dom/dow is constrained", () => {
    // dom constrained, dow is * → only the 15th matches
    const e = parseCron("0 0 15 * *")
    expect(matches(e, at(2026, 6, 15, 0, 0))).toBe(true)
    expect(matches(e, at(2026, 6, 16, 0, 0))).toBe(false)
  })
})

describe("nextFire", () => {
  it("finds the next 5-minute boundary", () => {
    const e = parseCron("*/5 * * * *")
    const n = nextFire(e, at(2026, 5, 30, 10, 2))
    expect(n).toEqual(at(2026, 5, 30, 10, 5))
  })

  it("rolls to the next day for a daily job", () => {
    const e = parseCron("0 9 * * *")
    const n = nextFire(e, at(2026, 5, 30, 10, 0))
    expect(n).toEqual(at(2026, 5, 31, 9, 0))
  })

  it("skips weekends for a weekday job", () => {
    const e = parseCron("0 9 * * 1-5")
    // From Saturday 2026-05-30, next is Monday 2026-06-01 09:00.
    const n = nextFire(e, at(2026, 5, 30, 12, 0))
    expect(n).toEqual(at(2026, 6, 1, 9, 0))
  })

  it("is exclusive of the current matching minute", () => {
    const e = parseCron("0 9 * * *")
    const n = nextFire(e, at(2026, 5, 30, 9, 0))
    expect(n).toEqual(at(2026, 5, 31, 9, 0))
  })

  it("returns null past the horizon (Feb 30 never happens)", () => {
    const e = parseCron("0 0 30 2 *")
    expect(nextFire(e, at(2026, 1, 1, 0, 0), 366)).toBeNull()
  })
})

describe("nextFire — property: result matches and nothing in between does", () => {
  it("every-15-min job: nextFire is the first matching minute after `from`", () => {
    const e = parseCron("*/15 * * * *")
    let seed = 12345
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let i = 0; i < 200; i++) {
      const from = new Date(
        2026,
        Math.floor(rand() * 12),
        1 + Math.floor(rand() * 27),
        Math.floor(rand() * 24),
        Math.floor(rand() * 60),
        Math.floor(rand() * 60),
      )
      const n = nextFire(e, from)
      expect(n).not.toBeNull()
      if (!n) continue
      expect(matches(e, n)).toBe(true)
      // No matching minute strictly between `from` (minute) and `n`.
      const cur = new Date(from.getTime())
      cur.setSeconds(0, 0)
      cur.setMinutes(cur.getMinutes() + 1)
      while (cur.getTime() < n.getTime()) {
        expect(matches(e, cur)).toBe(false)
        cur.setMinutes(cur.getMinutes() + 1)
      }
    }
  })
})

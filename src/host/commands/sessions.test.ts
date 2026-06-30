import { describe, expect, test } from "bun:test"

import type { IndexRecord } from "../../session-store.ts"
import type { SessionUsage } from "../../session-usage.ts"
import {
  formatBytes,
  formatTokenCell,
  formatTokenCount,
  renderSessionsCommandRows,
} from "../ui/chrome/sessions-command.ts"

import { fuzzyMatch, matchesQuery } from "./sessions.ts"

function usage(over: Partial<SessionUsage> = {}): SessionUsage {
  return {
    tokens: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    estimated: false,
    turns: 0,
    realTurns: 0,
    ...over,
  }
}

describe("formatBytes", () => {
  test("formats sub-kB sizes in plain bytes", () => {
    expect(formatBytes(0).trim()).toBe("0 B")
    expect(formatBytes(312).trim()).toBe("312 B")
    expect(formatBytes(1023).trim()).toBe("1023 B")
  })

  test("formats kB / MB / GB at the binary thresholds", () => {
    expect(formatBytes(1024).trim()).toBe("1.0 kB")
    expect(formatBytes(1536).trim()).toBe("1.5 kB")
    expect(formatBytes(1024 * 1024).trim()).toBe("1.0 MB")
    expect(formatBytes(1024 * 1024 * 1024).trim()).toBe("1.00 GB")
  })

  test("returns a sentinel for non-finite / negative input", () => {
    expect(formatBytes(Number.NaN).trim()).toBe("—")
    expect(formatBytes(-1).trim()).toBe("—")
  })

  test("output is fixed-width (right-aligned) for table layout", () => {
    // Every formatted size should share the same display width so the
    // column lines up. The exact width is `SIZE_COL_WIDTH = 9` but the
    // test stays robust to a future widening by asserting equality
    // across representative samples.
    const samples = [
      formatBytes(0),
      formatBytes(312),
      formatBytes(1024),
      formatBytes(1024 * 1024),
      formatBytes(2.5 * 1024 * 1024 * 1024),
      formatBytes(Number.NaN),
    ]
    const widths = new Set(samples.map((s) => s.length))
    expect(widths.size).toBe(1)
  })
})

describe("formatTokenCount", () => {
  test("renders plain counts under 1000", () => {
    expect(formatTokenCount(0)).toBe("0")
    expect(formatTokenCount(847)).toBe("847")
    expect(formatTokenCount(999)).toBe("999")
  })

  test("renders k / M with a dropped trailing .0", () => {
    expect(formatTokenCount(1000)).toBe("1k")
    expect(formatTokenCount(12_300)).toBe("12.3k")
    expect(formatTokenCount(1_000_000)).toBe("1M")
    expect(formatTokenCount(1_200_000)).toBe("1.2M")
  })

  test("returns a sentinel for non-finite / negative", () => {
    expect(formatTokenCount(Number.NaN)).toBe("—")
    expect(formatTokenCount(-5)).toBe("—")
  })
})

describe("formatTokenCell", () => {
  test("marks real (saved) counts with [R]", () => {
    const cell = formatTokenCell(
      usage({ tokens: 12_300, estimated: false, turns: 3, realTurns: 3 }),
    )
    expect(cell.trim()).toBe("12.3k [R]")
  })

  test("marks estimated counts with [E]", () => {
    const cell = formatTokenCell(usage({ tokens: 5_000, estimated: true, turns: 2, realTurns: 0 }))
    expect(cell.trim()).toBe("5k [E]")
  })

  test("shows an em-dash for a session with no assistant turns", () => {
    expect(formatTokenCell(usage({ turns: 0 })).trim()).toBe("—")
  })

  test("cells are fixed width for column alignment", () => {
    const samples = [
      formatTokenCell(usage({ tokens: 12_300, estimated: false, turns: 1, realTurns: 1 })),
      formatTokenCell(usage({ tokens: 5_000, estimated: true, turns: 1 })),
      formatTokenCell(usage({ tokens: 1_200_000, estimated: false, turns: 1, realTurns: 1 })),
      formatTokenCell(usage({ turns: 0 })),
    ]
    const widths = new Set(samples.map((s) => s.length))
    expect(widths.size).toBe(1)
  })
})

describe("fuzzyMatch", () => {
  test("empty needle matches anything", () => {
    expect(fuzzyMatch("", "")).toBe(true)
    expect(fuzzyMatch("", "anything")).toBe(true)
  })

  test("exact substring matches", () => {
    expect(fuzzyMatch("abc", "abcdef")).toBe(true)
    expect(fuzzyMatch("def", "abcdef")).toBe(true)
  })

  test("subsequence (non-contiguous) matches", () => {
    expect(fuzzyMatch("ace", "abcdef")).toBe(true)
    expect(fuzzyMatch("af", "abcdef")).toBe(true)
  })

  test("case-insensitive on both sides", () => {
    expect(fuzzyMatch("ABC", "abcdef")).toBe(true)
    expect(fuzzyMatch("abc", "ABCDEF")).toBe(true)
  })

  test("characters out of order don't match", () => {
    expect(fuzzyMatch("cba", "abcdef")).toBe(false)
  })

  test("missing character anywhere fails", () => {
    expect(fuzzyMatch("abz", "abcdef")).toBe(false)
  })
})

describe("matchesQuery", () => {
  const rec: IndexRecord = {
    sid: "4c2e3c84-e659-4793-93dc-38e2028413dc",
    createdAt: "2026-04-28T05:24:32.231Z",
    cwd: "/Users/gaston/Projects/minimal-agent",
    model: "test-model-1",
  }

  test("empty query matches every record", () => {
    expect(matchesQuery(rec, "")).toBe(true)
  })

  test("matches a fragment of the session id", () => {
    expect(matchesQuery(rec, "4c2e3c84")).toBe(true)
    expect(matchesQuery(rec, "38e2028413dc")).toBe(true)
  })

  test("matches a fragment of the cwd (workdir)", () => {
    expect(matchesQuery(rec, "minimal-agent")).toBe(true)
    expect(matchesQuery(rec, "gaston")).toBe(true)
  })

  test("matches a date prefix from createdAt", () => {
    expect(matchesQuery(rec, "2026-04-28")).toBe(true)
    expect(matchesQuery(rec, "2026-04")).toBe(true)
  })

  test("per-field boundaries: a query mostly in cwd plus a sid char does not match", () => {
    // Joined-haystack matching used to let "minimal-agentX" (cwd plus
    // one sid char) succeed via subsequence across the boundary. The
    // per-field OR is strict: the FULL needle has to appear as a
    // subsequence of ONE field.
    expect(matchesQuery(rec, "minimal-agentXXX")).toBe(false)
  })

  test("doesn't search the model (out of stated scope)", () => {
    // User explicitly scoped this to date/sid/cwd. The model column
    // can be filtered with a downstream pipe if anyone needs it.
    expect(
      matchesQuery({ ...rec, cwd: "/x", sid: "00000000-0000-0000-0000-000000000000" }, "tests"),
    ).toBe(false)
  })

  test("non-matching query is rejected", () => {
    expect(matchesQuery(rec, "zzzzz")).toBe(false)
  })

  test("tolerates a missing cwd field", () => {
    const noCwd = { ...rec, cwd: undefined as unknown as string }
    expect(matchesQuery(noCwd, "4c2e3c84")).toBe(true) // still matches sid
    expect(matchesQuery(noCwd, "minimal-agent")).toBe(false)
  })
})

describe("renderSessionsCommandRows", () => {
  test("renders empty state rows without direct console output", () => {
    const out = renderSessionsCommandRows({
      allCount: 0,
      rows: [],
      sessionsDir: "/tmp/sessions",
    }).join("\n")
    expect(out).toContain("no saved sessions yet")
    expect(out).toContain("sessions are stored at")
  })

  test("renders matching table rows and summary", () => {
    const out = renderSessionsCommandRows({
      allCount: 2,
      query: "alpha",
      sessionsDir: "/tmp/sessions",
      rows: [
        {
          createdAt: "2026-04-28T05:24:32.231Z",
          sid: "abc123",
          model: "test-model",
          bytes: 1536,
          usage: usage({ tokens: 12_300, estimated: false, turns: 2, realTurns: 2 }),
          cwd: "/Users/gaston/Projects/minimal-agent",
          snippet: "hello",
        },
      ],
    }).join("\n")

    expect(out).toContain("when")
    expect(out).toContain("abc123")
    expect(out).toContain("1.5 kB")
    expect(out).toContain("12.3k [R]")
    expect(out).toContain('1 of 2 session(s) matching "alpha"')
  })
})

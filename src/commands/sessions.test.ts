import { describe, expect, test } from "bun:test"

import type { IndexRecord } from "../session-store.ts"

import { formatBytes, fuzzyMatch, matchesQuery } from "./sessions.ts"

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
    model: "claude-opus-4-7",
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
      matchesQuery({ ...rec, cwd: "/x", sid: "00000000-0000-0000-0000-000000000000" }, "opus"),
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

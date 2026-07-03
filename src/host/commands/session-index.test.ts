import { describe, expect, test } from "bun:test"

import type { IndexRecord } from "../../session/session-store.ts"

import { resolveSidByPrefix } from "./session-index.ts"

function rec(sid: string): IndexRecord {
  return { sid, createdAt: "2026-01-01T00:00:00Z", cwd: "/tmp", model: "test" }
}

const FIXTURE: IndexRecord[] = [
  rec("abc12345-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
  rec("abd67890-bbbb-bbbb-bbbb-bbbbbbbbbbbb"),
  rec("abc12345-cccc-cccc-cccc-cccccccccccc"),
  rec("zzz99999-dddd-dddd-dddd-dddddddddddd"),
]

describe("resolveSidByPrefix", () => {
  test("exactly one prefix match returns that sid", () => {
    expect(resolveSidByPrefix("abd", FIXTURE)).toBe("abd67890-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
  })

  test("multiple prefixes with an exact match returns the exact match", () => {
    // Both "abc12345-aaaa-..." and "abc12345-cccc-..." start with "abc12345".
    // An exact search for the full sid of the first one should return it.
    const exact = "abc12345-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    expect(resolveSidByPrefix(exact, FIXTURE)).toBe(exact)
  })

  test("multiple prefix matches, no exact, returns null (ambiguous)", () => {
    // Two sessions start with "abc1" and neither is the full sid.
    expect(resolveSidByPrefix("abc1", FIXTURE)).toBeNull()
  })

  test("no prefix match returns target unchanged (pass-through)", () => {
    expect(resolveSidByPrefix("nosuch", FIXTURE)).toBe("nosuch")
  })

  test("case insensitive matching", () => {
    expect(resolveSidByPrefix("ZZZ", FIXTURE)).toBe("zzz99999-dddd-dddd-dddd-dddddddddddd")
  })

  test("empty records returns target unchanged", () => {
    expect(resolveSidByPrefix("abc", [])).toBe("abc")
  })

  test("full exact sid matches itself as a prefix", () => {
    const full = "zzz99999-dddd-dddd-dddd-dddddddddddd"
    expect(resolveSidByPrefix(full, FIXTURE)).toBe(full)
  })

  test("empty target matches everything and returns null (ambiguous)", () => {
    expect(resolveSidByPrefix("", FIXTURE)).toBeNull()
  })
})

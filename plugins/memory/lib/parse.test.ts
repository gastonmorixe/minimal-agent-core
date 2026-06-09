/**
 * Tests for the bullet parser, formatter, and id helpers.
 *
 * Coverage strategy:
 *   - parseBullet: every combination of optional prefix fields, plus
 *     non-bullet lines and edge cases (extra whitespace, empty body).
 *   - parseFile / parseFileWithLines / serializeFile: round-trip lossless
 *     on real memory files (legacy + new format mixed).
 *   - formatBullet: idempotent round-trip with parseBullet for all
 *     supported shapes.
 *   - newPersistentId: shape, sortability under controlled clock.
 *   - legacyIdFor: stable, distinct on metadata change.
 *   - nextShortTermId: gap-resistant, ignores non-integer ids.
 */

import { describe, expect, it } from "bun:test"

import {
  formatBullet,
  legacyIdFor,
  localIsoSeconds,
  newPersistentId,
  nextShortTermId,
  parseBullet,
  parseFile,
  parseFileWithLines,
  serializeFile,
} from "./parse.ts"

// ---------------------------------------------------------------------------
// parseBullet
// ---------------------------------------------------------------------------

describe("parseBullet", () => {
  it("parses a fully-tagged new-format bullet", () => {
    const line =
      "- [#lwq8tg-a8f3] [2026-05-08T16:57:30-04:00] [session:057b9dff-78cd-45db-8883-fb3966bfe2a9] hello world"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toBe("lwq8tg-a8f3")
    expect(b.ts).toBe("2026-05-08T16:57:30-04:00")
    expect(b.sid).toBe("057b9dff-78cd-45db-8883-fb3966bfe2a9")
    expect(b.body).toBe("hello world")
    expect(b.isLegacy).toBe(false)
    expect(b.raw).toBe(line)
  })

  it("parses a new-format bullet without sid", () => {
    const line = "- [#abc-1234] [2026-05-08T16:57:30-04:00] body text"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toBe("abc-1234")
    expect(b.ts).toBe("2026-05-08T16:57:30-04:00")
    expect(b.sid).toBeNull()
    expect(b.body).toBe("body text")
    expect(b.isLegacy).toBe(false)
  })

  it("parses a short-term bullet (integer id)", () => {
    const line = "- [#3] [2026-05-08T17:02:11-04:00] short-term scratch"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toBe("3")
    expect(b.body).toBe("short-term scratch")
    expect(b.isLegacy).toBe(false)
  })

  it("parses a legacy ts+sid bullet (no [#id] prefix)", () => {
    const line =
      "- [2026-05-05T21:06:20-04:00] [session:a4da0710-fc5a-4959-bc71-c965a46d1231] legacy body"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toMatch(/^legacy:[0-9a-f]{12}$/)
    expect(b.ts).toBe("2026-05-05T21:06:20-04:00")
    expect(b.sid).toBe("a4da0710-fc5a-4959-bc71-c965a46d1231")
    expect(b.body).toBe("legacy body")
    expect(b.isLegacy).toBe(true)
  })

  it("parses a legacy ts-only bullet", () => {
    const line = "- [2026-05-05T21:06:20-04:00] just a body"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toMatch(/^legacy:/)
    expect(b.ts).toBe("2026-05-05T21:06:20-04:00")
    expect(b.sid).toBeNull()
    expect(b.body).toBe("just a body")
    expect(b.isLegacy).toBe(true)
  })

  it("parses a fully-untagged legacy bullet", () => {
    const line = "- legacy bullet, no metadata at all"
    const b = parseBullet(line)
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.id).toMatch(/^legacy:/)
    expect(b.ts).toBeNull()
    expect(b.sid).toBeNull()
    expect(b.body).toBe("legacy bullet, no metadata at all")
    expect(b.isLegacy).toBe(true)
  })

  it("returns null for non-bullet lines", () => {
    expect(parseBullet("")).toBeNull()
    expect(parseBullet("   ")).toBeNull()
    expect(parseBullet("# Heading")).toBeNull()
    expect(parseBullet("plain prose line")).toBeNull()
    // Indented continuation — not a top-level bullet.
    expect(parseBullet("  - indented")).toBeNull()
  })

  it("strips the trailing newline from `raw`", () => {
    const b = parseBullet("- body\n")
    expect(b).not.toBeNull()
    if (!b) return
    expect(b.raw).toBe("- body")
  })

  it("two legacy bullets with identical body but different metadata get distinct ids", () => {
    const a = parseBullet("- [2026-05-05T21:06:20-04:00] same body")
    const b = parseBullet("- [2026-05-05T21:06:21-04:00] same body")
    expect(a?.id).not.toBe(b?.id)
  })

  it("two legacy bullets with byte-identical lines get identical ids (idempotent)", () => {
    const a = parseBullet("- same line")
    const b = parseBullet("- same line")
    expect(a?.id).toBe(b?.id)
  })
})

// ---------------------------------------------------------------------------
// parseFile / parseFileWithLines / serializeFile (round-trip)
// ---------------------------------------------------------------------------

describe("parseFile", () => {
  it("collects bullets in source order, skipping non-bullet lines", () => {
    const content =
      "# Heading\n" +
      "\n" +
      "- [#abc-1234] [2026-05-08T16:57:30-04:00] one\n" +
      "some prose\n" +
      "- [#xyz-5678] [2026-05-08T16:58:00-04:00] two\n"
    const bullets = parseFile(content)
    expect(bullets.length).toBe(2)
    expect(bullets[0]?.id).toBe("abc-1234")
    expect(bullets[1]?.id).toBe("xyz-5678")
  })

  it("handles empty file", () => {
    expect(parseFile("")).toEqual([])
  })
})

describe("parseFileWithLines + serializeFile", () => {
  it("round-trips a file losslessly when no bullets are mutated", () => {
    const content =
      "# Heading\n" +
      "\n" +
      "- [#abc-1234] [2026-05-08T16:57:30-04:00] one\n" +
      "some prose\n" +
      "- legacy bullet\n" +
      "\n"
    const lines = parseFileWithLines(content)
    expect(serializeFile(lines)).toBe(content)
  })

  it("preserves trailing newline via empty trailing entry", () => {
    const content = "- one\n"
    const lines = parseFileWithLines(content)
    // ["- one", ""] — the trailing empty string is the bytes after the
    // final \n, and represents the file's trailing newline on serialize.
    expect(lines.length).toBe(2)
    expect(lines[0]?.kind).toBe("bullet")
    expect(lines[1]?.kind).toBe("other")
    expect(lines[1]?.raw).toBe("")
    expect(serializeFile(lines)).toBe(content)
  })

  it("file without trailing newline round-trips without adding one", () => {
    const content = "- one\n- two"
    const lines = parseFileWithLines(content)
    expect(serializeFile(lines)).toBe(content)
  })
})

// ---------------------------------------------------------------------------
// formatBullet
// ---------------------------------------------------------------------------

describe("formatBullet", () => {
  it("emits all fields when present", () => {
    const out = formatBullet({
      id: "lwq8tg-a8f3",
      ts: "2026-05-08T16:57:30-04:00",
      sid: "057b9dff-78cd-45db-8883-fb3966bfe2a9",
      body: "hello world",
    })
    expect(out).toBe(
      "- [#lwq8tg-a8f3] [2026-05-08T16:57:30-04:00] [session:057b9dff-78cd-45db-8883-fb3966bfe2a9] hello world",
    )
  })

  it("omits sid when null", () => {
    const out = formatBullet({
      id: "abc-1234",
      ts: "2026-05-08T16:57:30-04:00",
      sid: null,
      body: "no sid",
    })
    expect(out).toBe("- [#abc-1234] [2026-05-08T16:57:30-04:00] no sid")
  })

  it("omits ts when null", () => {
    const out = formatBullet({
      id: "abc-1234",
      ts: null,
      sid: null,
      body: "no metadata",
    })
    expect(out).toBe("- [#abc-1234] no metadata")
  })

  it("collapses multi-line bodies to single line", () => {
    const out = formatBullet({
      id: "1",
      ts: null,
      sid: null,
      body: "first line\n  second line\n\nthird",
    })
    expect(out).toBe("- [#1] first line second line third")
  })

  it("round-trips with parseBullet (full shape)", () => {
    const input = {
      id: "lwq8tg-a8f3",
      ts: "2026-05-08T16:57:30-04:00",
      sid: "057b9dff-78cd-45db-8883-fb3966bfe2a9",
      body: "round trip",
    }
    const line = formatBullet(input)
    const parsed = parseBullet(line)
    expect(parsed?.id).toBe(input.id)
    expect(parsed?.ts).toBe(input.ts)
    expect(parsed?.sid).toBe(input.sid)
    expect(parsed?.body).toBe(input.body)
    expect(parsed?.isLegacy).toBe(false)
  })

  it("round-trips with parseBullet (id only)", () => {
    const input = { id: "3", ts: null, sid: null, body: "minimal" }
    const line = formatBullet(input)
    const parsed = parseBullet(line)
    expect(parsed?.id).toBe("3")
    expect(parsed?.body).toBe("minimal")
  })
})

// ---------------------------------------------------------------------------
// newPersistentId
// ---------------------------------------------------------------------------

describe("newPersistentId", () => {
  it("emits `<base36-millis>-<4hex>`", () => {
    const id = newPersistentId()
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
  })

  it("is sortable by time when called with a controlled clock", () => {
    let t = 1_000_000_000_000
    const fixed =
      (_n: number): (() => Buffer) =>
      () =>
        Buffer.from([0xab, 0xcd])
    const a = newPersistentId(() => t, fixed(0))
    t += 1
    const b = newPersistentId(() => t, fixed(0))
    t += 1000
    const c = newPersistentId(() => t, fixed(0))
    expect(a < b).toBe(true)
    expect(b < c).toBe(true)
  })

  it("two calls in the same millisecond produce different ids (random tail)", () => {
    const t = 1_000_000_000_000
    const a = newPersistentId(() => t)
    const b = newPersistentId(() => t)
    // 16-bit collision is 1/65536 — flake risk is real but not for 2 calls
    // in a synchronous test; if this ever fails investigate, don't ignore.
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// legacyIdFor
// ---------------------------------------------------------------------------

describe("legacyIdFor", () => {
  it("emits `legacy:<12 hex>`", () => {
    expect(legacyIdFor("- some line")).toMatch(/^legacy:[0-9a-f]{12}$/)
  })

  it("is deterministic for the same input", () => {
    expect(legacyIdFor("- a")).toBe(legacyIdFor("- a"))
  })

  it("differs on any byte change", () => {
    expect(legacyIdFor("- a")).not.toBe(legacyIdFor("- b"))
    expect(legacyIdFor("- a ")).not.toBe(legacyIdFor("- a"))
  })
})

// ---------------------------------------------------------------------------
// nextShortTermId
// ---------------------------------------------------------------------------

describe("nextShortTermId", () => {
  it("returns 1 for an empty list", () => {
    expect(nextShortTermId([])).toBe(1)
  })

  it("returns max+1 across integer ids only", () => {
    const bullets = [
      { id: "1", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
      { id: "5", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
      { id: "3", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
    ]
    expect(nextShortTermId(bullets)).toBe(6)
  })

  it("ignores non-integer ids (persistent + legacy)", () => {
    const bullets = [
      { id: "lwq8tg-a8f3", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
      { id: "legacy:abcdef012345", ts: null, sid: null, body: "", isLegacy: true, raw: "" },
      { id: "2", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
    ]
    expect(nextShortTermId(bullets)).toBe(3)
  })

  it("never reuses gaps left by deletes (max+1, not first-free)", () => {
    // After deleting id 2 from {1,2,3}, max-seen is 3 and next is 4.
    const bullets = [
      { id: "1", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
      { id: "3", ts: null, sid: null, body: "", isLegacy: false, raw: "" },
    ]
    expect(nextShortTermId(bullets)).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// localIsoSeconds (re-export sanity check; main coverage stays in
// handlers/memory.test.ts)
// ---------------------------------------------------------------------------

describe("localIsoSeconds", () => {
  it("formats with the expected shape", () => {
    const out = localIsoSeconds(new Date(2026, 4, 5, 21, 6, 20))
    expect(out).toMatch(/^2026-05-05T21:06:20[+-]\d{2}:\d{2}$/)
  })
})

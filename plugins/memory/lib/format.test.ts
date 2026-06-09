/**
 * Unit tests for the pure formatting helpers in `lib/format.ts`.
 *
 * Pagination + body-clip behavior used to be exercised only through
 * the `MemoryTool` handler tests. Lifting it to a dedicated unit suite
 * gives faster feedback when the header format changes and makes the
 * pagination shape (offset / limit / nextOffset semantics) a first-
 * class testable contract.
 */

import { describe, expect, it } from "bun:test"

import {
  buildListHeader,
  buildNextPageHint,
  bulletsToJson,
  bulletToJson,
  formatAdded,
  formatCleared,
  formatEdited,
  formatList,
  formatRead,
  formatRemoved,
  LIST_PREVIEW_MAX,
} from "./format.ts"
import type { Bullet } from "./parse.ts"

function mkBullet(
  id: string,
  body: string,
  ts: string | null = null,
  sid: string | null = null,
): Bullet {
  return { id, body, ts, sid, isLegacy: false, raw: "" }
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

// ---------------------------------------------------------------------------
// buildListHeader: header text shapes
// ---------------------------------------------------------------------------

describe("buildListHeader", () => {
  it("renders 'no entries' for empty stores", () => {
    expect(buildListHeader({ scope: "project", shown: 0, total: 0 })).toBe("project (no entries)")
  })

  it("renders 'no entries matching X' when a query was applied", () => {
    expect(buildListHeader({ scope: "project", shown: 0, total: 0, query: "wrap" })).toBe(
      'project (no entries matching "wrap")',
    )
  })

  it("uses singular 'entry' for exactly 1 result", () => {
    expect(buildListHeader({ scope: "project", shown: 1, total: 1 })).toBe("project (1 entry)")
  })

  it("uses plural 'entries' for >1 result", () => {
    expect(buildListHeader({ scope: "project", shown: 3, total: 3 })).toBe("project (3 entries)")
  })

  it("renders 'showing N of M entries, offset O' when paginated", () => {
    expect(buildListHeader({ scope: "project", shown: 20, total: 122, offset: 0 })).toBe(
      "project (showing 20 of 122 entries, offset 0)",
    )
  })

  it("includes the offset on later pages", () => {
    expect(buildListHeader({ scope: "project", shown: 22, total: 122, offset: 100 })).toBe(
      "project (showing 22 of 122 entries, offset 100)",
    )
  })

  it("includes 'matching X' when query and pagination both apply", () => {
    expect(
      buildListHeader({
        scope: "project",
        shown: 5,
        total: 17,
        offset: 0,
        query: "compositor",
      }),
    ).toBe('project (showing 5 of 17 entries matching "compositor", offset 0)')
  })

  it("treats offset=0 by default", () => {
    // Caller forgot to pass offset; we still render the paginated form.
    expect(buildListHeader({ scope: "project", shown: 5, total: 10 })).toBe(
      "project (showing 5 of 10 entries, offset 0)",
    )
  })

  it("treats single-page result as un-paginated regardless of offset value", () => {
    // shown === total → header drops the paged shape entirely.
    expect(buildListHeader({ scope: "project", shown: 3, total: 3, offset: 0 })).toBe(
      "project (3 entries)",
    )
  })
})

// ---------------------------------------------------------------------------
// buildNextPageHint: actionable next-call hint
// ---------------------------------------------------------------------------

describe("buildNextPageHint", () => {
  it("returns empty when nextOffset is null", () => {
    expect(buildNextPageHint({ scope: "project", nextOffset: null, limit: 20 })).toBe("")
  })

  it("returns empty when nextOffset is undefined", () => {
    expect(buildNextPageHint({ scope: "project", limit: 20 })).toBe("")
  })

  it("returns empty when limit is missing (incomplete pagination context)", () => {
    // Without a limit, the hint can't synthesize a callable shape.
    expect(buildNextPageHint({ scope: "project", nextOffset: 20 })).toBe("")
  })

  it("renders a complete tool-call hint when nextOffset + limit are both set", () => {
    expect(buildNextPageHint({ scope: "project", nextOffset: 20, limit: 20 })).toBe(
      'next: MemoryTool({action: "list", scope: "project", offset: 20, limit: 20})',
    )
  })

  it("includes the query in the hint when present", () => {
    expect(
      buildNextPageHint({
        scope: "project",
        nextOffset: 20,
        limit: 20,
        query: "compositor",
      }),
    ).toBe(
      'next: MemoryTool({action: "list", scope: "project", offset: 20, limit: 20, query: "compositor"})',
    )
  })

  it("JSON-escapes query strings with embedded quotes", () => {
    expect(
      buildNextPageHint({
        scope: "project",
        nextOffset: 20,
        limit: 20,
        query: 'has "quoted" thing',
      }),
    ).toContain(`query: "has \\"quoted\\" thing"`)
  })
})

// ---------------------------------------------------------------------------
// formatList: composition + body clip + ANSI
// ---------------------------------------------------------------------------

describe("formatList", () => {
  it("renders header + per-bullet rows + trailing newline (no ANSI)", () => {
    const out = formatList(
      [mkBullet("aaa-1111", "first", "2026-05-08T16:57:30-04:00"), mkBullet("bbb-2222", "second")],
      { scope: "project", ansi: false },
    )
    expect(out.endsWith("\n")).toBe(true)
    const lines = out.split("\n")
    expect(lines[0]).toBe("project (2 entries)")
    expect(lines[1]).toContain("#aaa-1111")
    expect(lines[1]).toContain("2026-05-08 16:57:30")
    expect(lines[1]).toContain("first")
    expect(lines[2]).toContain("#bbb-2222")
    expect(lines[2]).toContain("(no ts)")
    expect(lines[2]).toContain("second")
  })

  it("clips long bodies to LIST_PREVIEW_MAX by default", () => {
    const longBody = "x".repeat(LIST_PREVIEW_MAX + 50)
    const out = formatList([mkBullet("a", longBody)], { scope: "project", ansi: false })
    expect(out).toContain("…")
    // Pulling the rendered body length out via a regex on the row.
    const row = out.split("\n").find((l) => l.includes("#a")) ?? ""
    // x-run is at most LIST_PREVIEW_MAX - 1 (one char for the ellipsis).
    const xs = row.match(/x+/)?.[0] ?? ""
    expect(xs.length).toBeLessThanOrEqual(LIST_PREVIEW_MAX - 1)
  })

  it("respects an explicit bodyMax override", () => {
    const longBody = "x".repeat(100)
    const out = formatList([mkBullet("a", longBody)], {
      scope: "project",
      ansi: false,
      bodyMax: 20,
    })
    expect(out).toContain("…")
    const row = out.split("\n").find((l) => l.includes("#a")) ?? ""
    const xs = row.match(/x+/)?.[0] ?? ""
    expect(xs.length).toBeLessThanOrEqual(19)
  })

  it("uses ANSI codes when ansi=true and omits them when ansi=false", () => {
    const ansiOut = formatList([mkBullet("a", "body")], { scope: "project", ansi: true })
    const plainOut = formatList([mkBullet("a", "body")], { scope: "project", ansi: false })
    expect(ansiOut).toContain("\x1b[")
    expect(plainOut).not.toContain("\x1b[")
    // Plain form should be the ANSI form stripped (modulo column padding).
    expect(stripAnsi(ansiOut)).toBe(plainOut)
  })

  it("renders next-page hint when nextOffset + limit are provided", () => {
    const out = formatList([mkBullet("a", "body"), mkBullet("b", "body")], {
      scope: "project",
      ansi: false,
      total: 100,
      offset: 0,
      limit: 2,
      nextOffset: 2,
    })
    expect(out).toContain('next: MemoryTool({action: "list"')
    expect(out).toContain("offset: 2")
    expect(out).toContain("limit: 2")
  })

  it("omits next-page hint on the last page (nextOffset=null)", () => {
    const out = formatList([mkBullet("a", "body")], {
      scope: "project",
      ansi: false,
      total: 21,
      offset: 20,
      limit: 20,
      nextOffset: null,
    })
    expect(out).not.toContain("next:")
  })

  it("paginated header reflects shown vs total", () => {
    const out = formatList([mkBullet("a", "body"), mkBullet("b", "body")], {
      scope: "project",
      ansi: false,
      total: 122,
      offset: 0,
      limit: 2,
      nextOffset: 2,
    })
    expect(out.split("\n")[0]).toBe("project (showing 2 of 122 entries, offset 0)")
  })

  it("threads query string into both header and hint", () => {
    const out = formatList([mkBullet("a", "body")], {
      scope: "project",
      ansi: false,
      total: 5,
      offset: 0,
      limit: 1,
      nextOffset: 1,
      query: "wrap",
    })
    expect(out).toContain('matching "wrap"')
    expect(out).toContain(`query: "wrap"`)
  })

  it("returns 'no entries' header alone when bullets is empty", () => {
    const out = formatList([], { scope: "global", ansi: false })
    expect(out.trimEnd()).toBe("global (no entries)")
  })
})

// ---------------------------------------------------------------------------
// Single-bullet formatters: read / add / edit / remove / clear
// ---------------------------------------------------------------------------

describe("formatRead", () => {
  it("renders id, scope, timestamp, and body", () => {
    const b = mkBullet("abc-1234", "thing happened", "2026-05-08T16:57:30-04:00")
    const out = formatRead(b, "project", false)
    expect(out).toContain("project")
    expect(out).toContain("#abc-1234")
    expect(out).toContain("2026-05-08 16:57:30")
    expect(out).toContain("thing happened")
  })

  it("includes the session id when present", () => {
    const b = mkBullet("a", "body", null, "sid-uuid")
    const out = formatRead(b, "project", false)
    expect(out).toContain("[session:sid-uuid]")
  })
})

describe("formatAdded / formatEdited / formatRemoved", () => {
  it("formatAdded surfaces evicted count when nonzero", () => {
    const b = mkBullet("a", "body")
    expect(formatAdded(b, "short-term", 0, false)).toContain("saved [short-term#a]")
    expect(formatAdded(b, "short-term", 2, false)).toContain("(evicted 2 oldest)")
  })

  it("formatEdited tags scope#id", () => {
    const b = mkBullet("a", "new body")
    expect(formatEdited(b, "project", false)).toBe("edited [project#a]: new body\n")
  })

  it("formatRemoved tags scope#id", () => {
    const b = mkBullet("a", "old body")
    expect(formatRemoved(b, "project", false)).toBe("removed [project#a]: old body\n")
  })
})

describe("formatCleared", () => {
  it("reports the count and scope", () => {
    expect(formatCleared(7, "short-term", false)).toBe("cleared 7 short-term entries\n")
  })
})

// ---------------------------------------------------------------------------
// JSON shape
// ---------------------------------------------------------------------------

describe("bulletToJson / bulletsToJson", () => {
  it("maps the canonical fields and renames isLegacy", () => {
    const b: Bullet = {
      id: "a",
      ts: "2026-05-01T00:00:00Z",
      sid: "sid",
      body: "body",
      isLegacy: true,
      raw: "",
    }
    expect(bulletToJson(b)).toEqual({
      id: "a",
      ts: "2026-05-01T00:00:00Z",
      sid: "sid",
      body: "body",
      is_legacy: true,
    })
  })

  it("bulletsToJson maps each bullet through bulletToJson", () => {
    const items = [mkBullet("a", "x"), mkBullet("b", "y")]
    expect(bulletsToJson(items).map((j) => j.id)).toEqual(["a", "b"])
  })
})

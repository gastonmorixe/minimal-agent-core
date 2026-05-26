import { describe, expect, it } from "bun:test"

import { CATS, type CatExpression, catBlock, catFace, catRows, DEFAULT_CAT } from "./cats.ts"
import { displayWidth } from "./term-width.ts"

describe("cats", () => {
  it("default cat is happy", () => {
    expect(DEFAULT_CAT).toBe("happy")
  })

  it("catRows returns three rows", () => {
    const rows = catRows("happy")
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain("/\\_/\\")
    expect(rows[1]).toContain("^.^")
    expect(rows[2]).toContain("ω")
  })

  it("catRows defaults to the cute one when no expression given", () => {
    expect(catRows()).toEqual(catRows(DEFAULT_CAT))
  })

  it("catBlock joins rows with newlines", () => {
    const block = catBlock("curious")
    const lines = block.split("\n")
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe("( o.o )")
  })

  it("catFace returns just the face row", () => {
    expect(catFace("error")).toBe("( x.x )")
    expect(catFace("love")).toBe("( ♥.♥ )")
  })

  // Width invariance matters: callers right-align the cat next to a
  // header, and a mood swap that changed the cat's display width would
  // shift the layout. Pin the property here.
  it("all expressions share the same display width per row", () => {
    const ref = catRows("happy")
    const refWidths = ref.map((r) => displayWidth(r))
    for (const expr of Object.keys(CATS) as CatExpression[]) {
      const rows = catRows(expr)
      const widths = rows.map((r) => displayWidth(r))
      expect(widths).toEqual(refWidths)
    }
  })

  it("covers the full mood spectrum", () => {
    // Sanity: if someone deletes a mood, this catches it. The list is
    // intentionally explicit rather than `Object.keys(CATS).length` so
    // additions/removals show up as test diffs.
    const moods: CatExpression[] = [
      "curious",
      "happy",
      "sleepy",
      "thinking",
      "focused",
      "surprised",
      "love",
      "error",
      "smug",
      "asleep",
      "angry",
      "crying",
    ]
    for (const m of moods) expect(CATS[m]).toBeDefined()
    expect(Object.keys(CATS).sort()).toEqual([...moods].sort())
  })
})

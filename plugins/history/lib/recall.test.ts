/**
 * Tests for the ↑/↓ recall FSM. Pure logic — no filesystem, no editor.
 *
 * Naming: each test names the symptom in user terms ("↑ from empty
 * buffer recalls newest"). The recall's three implicit states (IDLE,
 * BROWSING, EDITED) are exercised through normal arrow-key sequences
 * the user would actually produce.
 */
import { describe, expect, it } from "bun:test"

import { createRecall } from "./recall.ts"

const seed = (...texts: string[]) => texts.map((text) => ({ text }))

describe("recall / empty store", () => {
  it("↑ on empty store is a pass-through (no buffer mutation, no halt)", () => {
    const r = createRecall([])
    const result = r.up("")
    expect(result.halt).toBe(false)
    expect(result.buffer).toBeUndefined()
  })

  it("↓ on empty store is a pass-through", () => {
    const r = createRecall([])
    expect(r.down("").halt).toBe(false)
  })
})

describe("recall / basic up/down navigation", () => {
  it("↑ from empty buffer recalls newest entry", () => {
    const r = createRecall(seed("oldest", "middle", "newest"))
    const result = r.up("")
    expect(result.halt).toBe(true)
    expect(result.buffer).toBe("newest")
    expect(r.cursor()).toBe(2)
  })

  it("two ↑ presses walk older", () => {
    const r = createRecall(seed("oldest", "middle", "newest"))
    expect(r.up("").buffer).toBe("newest")
    expect(r.up("newest").buffer).toBe("middle")
    expect(r.cursor()).toBe(1)
  })

  it("walks all the way to the oldest, then ↑ stays there", () => {
    const r = createRecall(seed("a", "b", "c"))
    expect(r.up("").buffer).toBe("c")
    expect(r.up("c").buffer).toBe("b")
    expect(r.up("b").buffer).toBe("a")
    // Extra ↑ at the head returns oldest again (halt true, no walk).
    const extra = r.up("a")
    expect(extra.halt).toBe(true)
    expect(extra.buffer).toBe("a")
    expect(r.cursor()).toBe(0)
  })

  it("↓ walks newer", () => {
    const r = createRecall(seed("a", "b", "c"))
    r.up("")
    r.up("c")
    r.up("b") // now on "a"
    expect(r.down("a").buffer).toBe("b")
    expect(r.down("b").buffer).toBe("c")
  })

  it("↓ overshoot past newest restores the empty draft and returns to IDLE", () => {
    const r = createRecall(seed("a", "b"))
    r.up("") // on "b"
    const overshoot = r.down("b") // overshoot
    expect(overshoot.halt).toBe(true)
    expect(overshoot.buffer).toBe("")
    expect(r.cursor()).toBe(-1)
  })
})

describe("recall / draft snapshot", () => {
  it("captures user's in-flight draft on first ↑ and restores it on overshoot", () => {
    const r = createRecall(seed("a", "b"))
    const overshoot1 = r.up("half-typed").buffer // first ↑ snapshots "half-typed"
    expect(overshoot1).toBe("b")
    expect(r.cursor()).toBe(1)
    const after = r.down("b") // overshoot back to draft
    expect(after.buffer).toBe("half-typed")
    expect(r.cursor()).toBe(-1)
  })

  it("draft snapshot is captured ONCE per browsing session, not on every ↑", () => {
    const r = createRecall(seed("a", "b"))
    r.up("draft-1") // captures "draft-1"
    r.up("b") // does NOT re-capture
    const after = r.down("a") // walk newer
    expect(after.buffer).toBe("b")
    const overshoot = r.down("b")
    // Draft was captured ONCE — must be "draft-1", not "b".
    expect(overshoot.buffer).toBe("draft-1")
  })
})

describe("recall / EDITED state (user changes recalled text)", () => {
  it("once the user edits a recalled entry, ↑ becomes a pass-through", () => {
    const r = createRecall(seed("a", "b", "c"))
    r.up("") // on "c"
    // The user is now editing "c" — say they appended " — wait, no"
    const upAfterEdit = r.up("c — wait, no")
    expect(upAfterEdit.halt).toBe(false)
    expect(upAfterEdit.buffer).toBeUndefined()
  })

  it("EDITED state also blocks ↓ pass-through", () => {
    const r = createRecall(seed("a", "b"))
    r.up("") // on "b"
    const downAfterEdit = r.down("b!")
    expect(downAfterEdit.halt).toBe(false)
  })

  it("a submit (push) followed by a fresh ↑ re-enters BROWSING", () => {
    const r = createRecall(seed("a", "b"))
    r.up("") // on "b"
    r.push("c") // submits "c", resets cursor to IDLE
    expect(r.cursor()).toBe(-1)
    const up = r.up("")
    expect(up.buffer).toBe("c") // newest is now "c"
  })
})

describe("recall / push semantics", () => {
  it("push adds a new entry at the tail and resets cursor", () => {
    const r = createRecall(seed("a"))
    expect(r.size()).toBe(1)
    r.push("b")
    expect(r.size()).toBe(2)
    expect(r.up("").buffer).toBe("b")
  })

  it("push de-dups against the previous entry", () => {
    const r = createRecall(seed("a"))
    r.push("a")
    expect(r.size()).toBe(1) // not appended
  })

  it("push skips empty / whitespace-only text", () => {
    const r = createRecall(seed("a"))
    r.push("")
    r.push("   ")
    r.push("\n\t")
    expect(r.size()).toBe(1)
  })

  it("push resets the recall cursor even when de-duped", () => {
    const r = createRecall(seed("a", "b"))
    r.up("")
    r.up("b") // on "a", cursor = 0
    r.push("a") // de-duped (last entry was "b", "a" != "b" — actually appends)
    // OK that case doesn't dedup. Let's do a real dedup:
    const r2 = createRecall(seed("a", "b"))
    r2.up("")
    r2.up("b") // on "a", cursor = 0
    r2.push("b") // de-duped
    expect(r2.cursor()).toBe(-1)
  })
})

describe("recall / resetCursor", () => {
  it("returns to IDLE so the next ↑ starts from newest", () => {
    const r = createRecall(seed("a", "b"))
    r.up("")
    r.up("b") // on "a"
    r.resetCursor()
    expect(r.cursor()).toBe(-1)
    expect(r.up("").buffer).toBe("b")
  })
})

describe("recall / edge cases", () => {
  it("single-entry store: ↑ recalls it, ↑ again stays, ↓ overshoots", () => {
    const r = createRecall(seed("only"))
    expect(r.up("").buffer).toBe("only")
    expect(r.up("only").buffer).toBe("only") // stuck at head
    expect(r.down("only").buffer).toBe("") // overshoot → draft
  })

  it("multi-line entries survive round-trip with embedded \\n", () => {
    const r = createRecall(seed("line1\nline2\nline3"))
    expect(r.up("").buffer).toBe("line1\nline2\nline3")
  })

  it("identical adjacent entries are NOT collapsed in the store (only push dedups)", () => {
    // Construction allows duplicates (seeded from disk); push dedup is
    // a separate behavior for newly-typed prompts.
    const r = createRecall(seed("a", "a", "b"))
    expect(r.size()).toBe(3)
    expect(r.up("").buffer).toBe("b")
    expect(r.up("b").buffer).toBe("a") // duplicate
    expect(r.up("a").buffer).toBe("a") // also duplicate
  })
})

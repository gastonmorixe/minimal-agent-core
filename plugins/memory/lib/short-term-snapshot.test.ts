/**
 * Tests for the per-turn short-term snapshot producer.
 *
 * Coverage:
 *   - null/empty sid → no attachment
 *   - missing/empty file → no attachment
 *   - one-or-more bullets → attachment text shape (`<ma::agent::short-term-memory>…</ma::agent::short-term-memory>`)
 *   - bullet ordering preserved (file order = insertion order)
 *   - reads fresh from disk on each call (mutation visible immediately)
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { ShortTermSnapshot } from "./short-term-snapshot.ts"
import { MemoryStore } from "./store.ts"

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-snapshot-test-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

describe("ShortTermSnapshot — no-op cases", () => {
  it("null sid → no attachment", () => {
    const s = new ShortTermSnapshot(null, { home: tmpHome })
    expect(s.toAttachment()).toBeNull()
    expect(s.toText()).toBeNull()
  })

  it("empty/whitespace sid → no attachment", () => {
    expect(new ShortTermSnapshot("", { home: tmpHome }).toAttachment()).toBeNull()
    expect(new ShortTermSnapshot("   ", { home: tmpHome }).toAttachment()).toBeNull()
  })

  it("missing file → no attachment", () => {
    const s = new ShortTermSnapshot("sid-missing", { home: tmpHome })
    expect(s.toAttachment()).toBeNull()
  })

  it("empty file → no attachment", () => {
    const sid = "sid-empty"
    // Create+truncate via clear()
    const store = MemoryStore.shortTerm(sid, { home: tmpHome })
    store.add("temporary")
    store.clear()
    const snap = new ShortTermSnapshot(sid, { home: tmpHome })
    expect(snap.toAttachment()).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Happy path — single and multiple bullets
// ---------------------------------------------------------------------------

describe("ShortTermSnapshot — happy path", () => {
  it("renders a single bullet as `[#<id>] <body>` between tags", () => {
    const sid = "sid-1"
    MemoryStore.shortTerm(sid, { home: tmpHome }).add("active hypothesis: width 80")
    const snap = new ShortTermSnapshot(sid, { home: tmpHome })
    expect(snap.toText()).toBe(
      "<ma::agent::short-term-memory>\n[#1] active hypothesis: width 80\n</ma::agent::short-term-memory>",
    )
  })

  it("renders multiple bullets in file order", () => {
    const sid = "sid-multi"
    const store = MemoryStore.shortTerm(sid, { home: tmpHome })
    store.add("first")
    store.add("second")
    store.add("third")
    const snap = new ShortTermSnapshot(sid, { home: tmpHome })
    expect(snap.toText()).toBe(
      "<ma::agent::short-term-memory>\n[#1] first\n[#2] second\n[#3] third\n</ma::agent::short-term-memory>",
    )
  })

  it("returns a ContentBlock with type='text'", () => {
    const sid = "sid-block"
    MemoryStore.shortTerm(sid, { home: tmpHome }).add("hi")
    const att = new ShortTermSnapshot(sid, { home: tmpHome }).toAttachment()
    expect(att).not.toBeNull()
    expect(att?.type).toBe("text")
  })
})

// ---------------------------------------------------------------------------
// Freshness — re-reads on every call
// ---------------------------------------------------------------------------

describe("ShortTermSnapshot — fresh-read semantics", () => {
  it("sees a bullet added between two toAttachment calls", () => {
    const sid = "sid-fresh"
    const store = MemoryStore.shortTerm(sid, { home: tmpHome })
    const snap = new ShortTermSnapshot(sid, { home: tmpHome })

    expect(snap.toText()).toBeNull()

    store.add("just added")
    expect(snap.toText()).toContain("just added")
  })

  it("sees a removal between two toAttachment calls", () => {
    const sid = "sid-fresh-rm"
    const store = MemoryStore.shortTerm(sid, { home: tmpHome })
    const a = store.add("a").bullet
    store.add("b")

    const snap = new ShortTermSnapshot(sid, { home: tmpHome })
    expect(snap.toText()).toContain("[#1] a")
    expect(snap.toText()).toContain("[#2] b")

    store.remove(a.id)
    expect(snap.toText()).not.toContain("[#1] a")
    expect(snap.toText()).toContain("[#2] b")
  })

  it("sees an edit between two toAttachment calls", () => {
    const sid = "sid-fresh-edit"
    const store = MemoryStore.shortTerm(sid, { home: tmpHome })
    const b = store.add("original").bullet
    const snap = new ShortTermSnapshot(sid, { home: tmpHome })
    expect(snap.toText()).toContain("[#1] original")
    store.edit(b.id, "revised")
    expect(snap.toText()).toContain("[#1] revised")
    expect(snap.toText()).not.toContain("original")
  })
})

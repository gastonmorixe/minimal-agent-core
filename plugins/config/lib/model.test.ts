/**
 * Tests for ConfigModel: load → resolve values → stage → save.
 *
 * @module config/lib/model.test
 */

import { describe, expect, it } from "bun:test"

import { parseJsonc } from "./mini-jsonc.ts"
import { ConfigModel, type FsDeps, UNSET } from "./model.ts"
import { fieldById } from "./schema.ts"

/** In-memory fs fake. */
function fakeFs(initial: string | null): FsDeps & { current: string | null } {
  const box = { current: initial }
  return {
    path: "/fake/config.jsonc",
    read: () => box.current,
    write: (t: string) => {
      box.current = t
    },
    get current() {
      return box.current
    },
  } as FsDeps & { current: string | null }
}

describe("ConfigModel — load + resolve", () => {
  it("resolves current values from disk", () => {
    const fs = fakeFs(`{ "effort": "high", "skipQuota": true }`)
    const m = ConfigModel.load(fs)
    expect(m.value(fieldById("effort")!).current).toBe("high")
    expect(m.value(fieldById("skipQuota")!).current).toBe(true)
    expect(m.value(fieldById("model")!).current).toBeUndefined()
  })

  it("resolves a nested path (statusBar.segments)", () => {
    const fs = fakeFs(`{ "statusBar": { "segments": ["quota", "model"] } }`)
    const m = ConfigModel.load(fs)
    expect(m.value(fieldById("statusBarSegments")!).current).toEqual(["quota", "model"])
  })

  it("treats a missing file as an empty doc", () => {
    const m = ConfigModel.load(fakeFs(null))
    expect(m.error).toBeNull()
    expect(m.dirtyCount()).toBe(0)
  })

  it("flags a parse error and blocks save", () => {
    const m = ConfigModel.load(fakeFs(`{ not json `))
    expect(m.error).not.toBeNull()
    expect(() => m.save()).toThrow(/parse error/)
  })
})

describe("ConfigModel — stage + dirty", () => {
  it("marks a changed field dirty, an unchanged stage not dirty", () => {
    const fs = fakeFs(`{ "effort": "high" }`)
    const m = ConfigModel.load(fs)
    m.set("effort", "low")
    expect(m.value(fieldById("effort")!).dirty).toBe(true)
    expect(m.dirtyCount()).toBe(1)
    m.set("effort", "high") // back to disk value
    expect(m.value(fieldById("effort")!).dirty).toBe(false)
    expect(m.dirtyCount()).toBe(0)
  })

  it("staging a clear on a set key is dirty; on an unset key is not", () => {
    const fs = fakeFs(`{ "effort": "high" }`)
    const m = ConfigModel.load(fs)
    m.clear("effort")
    expect(m.value(fieldById("effort")!).dirty).toBe(true)
    m.clear("model") // already unset
    expect(m.value(fieldById("model")!).dirty).toBe(false)
  })

  it("revert + revertAll drop staged edits", () => {
    const m = ConfigModel.load(fakeFs(`{ "effort": "high" }`))
    m.set("effort", "low")
    m.set("model", "claude")
    expect(m.dirtyCount()).toBe(2)
    m.revert("effort")
    expect(m.dirtyCount()).toBe(1)
    m.revertAll()
    expect(m.dirtyCount()).toBe(0)
  })
})

describe("ConfigModel — save", () => {
  it("writes staged edits, preserving comments", () => {
    const fs = fakeFs(`{
  // keep this note
  "effort": "high"
}`)
    const m = ConfigModel.load(fs)
    m.set("effort", "low")
    m.set("model", "claude-opus-4-8")
    const out = m.save()
    expect(out).toContain("// keep this note")
    expect(parseJsonc(out)).toEqual({ effort: "low", model: "claude-opus-4-8" })
    expect(fs.current).toBe(out)
    // After save the stage is clean.
    expect(m.dirtyCount()).toBe(0)
  })

  it("removes a key when staged UNSET", () => {
    const fs = fakeFs(`{ "effort": "high", "model": "x" }`)
    const m = ConfigModel.load(fs)
    m.clear("effort")
    const out = m.save()
    expect(parseJsonc(out)).toEqual({ model: "x" })
  })

  it("writes a nested list path into a fresh file", () => {
    const fs = fakeFs(null)
    const m = ConfigModel.load(fs)
    m.set("statusBarSegments", ["context", "model"])
    const out = m.save()
    expect(parseJsonc(out)).toEqual({ statusBar: { segments: ["context", "model"] } })
  })

  it("UNSET sentinel is the documented clear signal", () => {
    // Guard: the sentinel is a stable symbol the handler layer references.
    expect(typeof UNSET).toBe("symbol")
  })
})

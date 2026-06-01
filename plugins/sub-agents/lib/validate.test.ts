import { describe, expect, it } from "bun:test"

import { parseIdArg, parseSpawnRequest } from "./validate.ts"

describe("parseSpawnRequest — basics", () => {
  it("requires a non-empty task", () => {
    expect(parseSpawnRequest({}).ok).toBe(false)
    expect(parseSpawnRequest({ task: "   " }).ok).toBe(false)
    const r = parseSpawnRequest({ task: "do X" })
    expect(r.ok && r.value.task).toBe("do X")
  })

  it("rejects a bad isolation value", () => {
    expect(parseSpawnRequest({ task: "x", isolation: "weird" }).ok).toBe(false)
    expect(parseSpawnRequest({ task: "x", isolation: "fork" }).ok).toBe(true)
  })
})

describe("parseSpawnRequest — expectArtifacts (FIX 4 contract)", () => {
  it("parses an array of non-empty paths", () => {
    const r = parseSpawnRequest({ task: "make files", expectArtifacts: ["/a/b.md", "/c/d.txt"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.expectArtifacts).toEqual(["/a/b.md", "/c/d.txt"])
  })

  it("trims entries and drops empty / non-string ones", () => {
    const r = parseSpawnRequest({ task: "x", expectArtifacts: ["  /a.md  ", "", 7, "  ", "/b.md"] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.expectArtifacts).toEqual(["/a.md", "/b.md"])
  })

  it("omits the field entirely when not an array or all-empty", () => {
    const r1 = parseSpawnRequest({ task: "x", expectArtifacts: "nope" })
    expect(r1.ok && "expectArtifacts" in r1.value).toBe(false)
    const r2 = parseSpawnRequest({ task: "x", expectArtifacts: ["", "   "] })
    expect(r2.ok && "expectArtifacts" in r2.value).toBe(false)
    const r3 = parseSpawnRequest({ task: "x" })
    expect(r3.ok && "expectArtifacts" in r3.value).toBe(false)
  })

  it("caps the list length (bounded)", () => {
    const many = Array.from({ length: 100 }, (_, i) => `/p/${i}.md`)
    const r = parseSpawnRequest({ task: "x", expectArtifacts: many })
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.value.expectArtifacts?.length ?? 0) <= 32).toBe(true)
  })
})

describe("parseIdArg", () => {
  it("accepts id / agent / target aliases", () => {
    expect(parseIdArg({ id: "A2" })).toBe("A2")
    expect(parseIdArg({ agent: "A3" })).toBe("A3")
    expect(parseIdArg({ target: "A4" })).toBe("A4")
    expect(parseIdArg({})).toBeUndefined()
  })
})

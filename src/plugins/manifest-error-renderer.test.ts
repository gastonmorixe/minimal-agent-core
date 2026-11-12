import { describe, expect, it } from "bun:test"

import { parseManifest } from "./manifest.ts"
import { parseErrorRenderers } from "./manifest-error-renderer.ts"

function run(raw: unknown) {
  const warns: string[] = []
  const out = parseErrorRenderers(raw, (m) => warns.push(m))
  return { out, warns }
}

describe("parseErrorRenderers", () => {
  it("returns undefined for an absent key", () => {
    expect(run(undefined)).toEqual({ out: undefined, warns: [] })
  })
  it("parses a valid entry and keeps export", () => {
    const { out, warns } = run([{ id: "dev", entry: "./x.ts", export: "make" }])
    expect(out).toEqual([{ id: "dev", entry: "./x.ts", export: "make" }])
    expect(warns).toEqual([])
  })
  it("leaves export unset when absent", () => {
    expect(run([{ id: "a", entry: "./a.ts" }]).out).toEqual([{ id: "a", entry: "./a.ts" }])
  })
  it("ignores a non-array with a warning", () => {
    const { out, warns } = run({ id: "a" })
    expect(out).toBeUndefined()
    expect(warns).toEqual(["errorRenderers:not_array"])
  })
  it("skips bad entries with a warning each", () => {
    const { out, warns } = run([
      null,
      { id: "", entry: "./a.ts" },
      { id: "a", entry: "" },
      { id: "b", entry: "./b.ts", export: "" },
      { id: "c", entry: 3 },
      { id: "ok", entry: "./ok.ts" },
    ])
    expect(out).toEqual([{ id: "ok", entry: "./ok.ts" }])
    expect(warns).toEqual([
      "errorRenderers[0]:not_object",
      "errorRenderers[1]:id",
      "errorRenderers[2]:entry",
      "errorRenderers[3]:export",
      "errorRenderers[4]:entry",
    ])
  })
  it("skips a duplicate id", () => {
    const { out, warns } = run([
      { id: "a", entry: "./a.ts" },
      { id: "a", entry: "./b.ts" },
    ])
    expect(out).toEqual([{ id: "a", entry: "./a.ts" }])
    expect(warns).toEqual(["errorRenderers[1]:duplicate_id"])
  })
  it("passes through parseManifest", () => {
    const warns: string[] = []
    const m = parseManifest(
      {
        id: "p",
        name: "p",
        version: "0.1.0",
        description: "d",
        errorRenderers: [{ id: "dev", entry: "./x.ts" }],
      },
      "/x/manifest.json",
      { warn: (w: string) => warns.push(w) },
    )
    expect(m.errorRenderers).toEqual([{ id: "dev", entry: "./x.ts" }])
  })
})

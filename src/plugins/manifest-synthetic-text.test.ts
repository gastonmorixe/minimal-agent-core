import { describe, expect, it } from "bun:test"

import { parseManifest } from "./manifest.ts"
import { parseSyntheticText, parseToolText } from "./manifest-synthetic-text.ts"

function run(raw: unknown) {
  const warns: string[] = []
  const out = parseSyntheticText(raw, (m) => warns.push(m), "/x/manifest.json")
  return { out, warns }
}

describe("parseSyntheticText", () => {
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
    expect(warns).toEqual(["syntheticText:not_array"])
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
      "syntheticText[0]:not_object",
      "syntheticText[1]:id",
      "syntheticText[2]:entry",
      "syntheticText[3]:export",
      "syntheticText[4]:entry",
    ])
  })
  it("skips a duplicate id", () => {
    const { out, warns } = run([
      { id: "a", entry: "./a.ts" },
      { id: "a", entry: "./b.ts" },
    ])
    expect(out).toEqual([{ id: "a", entry: "./a.ts" }])
    expect(warns).toEqual(["syntheticText[1]:duplicate_id"])
  })
  it("passes through parseManifest", () => {
    const warns: string[] = []
    const m = parseManifest(
      {
        id: "p",
        name: "p",
        version: "0.1.0",
        description: "d",
        syntheticText: [{ id: "dev", entry: "./x.ts" }],
      },
      "/x/manifest.json",
      { warn: (w: string) => warns.push(w) },
    )
    expect(m.syntheticText).toEqual([{ id: "dev", entry: "./x.ts" }])
  })
})

describe("parseSyntheticText kinds", () => {
  it("keeps a list of known kinds", () => {
    const { out, warns } = run([
      { id: "a", entry: "./a.ts", kinds: ["continue.max_tokens", "tool_text.Bash.error"] },
    ])
    expect(out).toEqual([
      { id: "a", entry: "./a.ts", kinds: ["continue.max_tokens", "tool_text.Bash.error"] },
    ])
    expect(warns).toEqual([])
  })
  it("skips an entry with an unknown, duplicate, empty or non-array kinds list", () => {
    const { out, warns } = run([
      { id: "a", entry: "./a.ts", kinds: ["no.such_kind"] },
      { id: "b", entry: "./b.ts", kinds: ["mode.change", "mode.change"] },
      { id: "c", entry: "./c.ts", kinds: [] },
      { id: "d", entry: "./d.ts", kinds: "mode.change" },
      { id: "ok", entry: "./ok.ts", kinds: ["mode.change"] },
    ])
    expect(out).toEqual([{ id: "ok", entry: "./ok.ts", kinds: ["mode.change"] }])
    expect(warns).toEqual([
      "syntheticText[0]:kinds",
      "syntheticText[1]:kinds",
      "syntheticText[2]:kinds",
      "syntheticText[3]:kinds",
    ])
  })
})

function runTools(raw: unknown) {
  const warns: string[] = []
  const out = parseToolText(raw, (m) => warns.push(m), "/x/manifest.json")
  return { out, warns }
}

describe("parseToolText", () => {
  it("returns undefined for an absent key", () => {
    expect(runTools(undefined)).toEqual({ out: undefined, warns: [] })
  })
  it("parses a valid entry with export and tools", () => {
    const { out, warns } = runTools([
      { id: "t", entry: "./t.ts", export: "make", tools: ["Read", "Bash"] },
    ])
    expect(out).toEqual([{ id: "t", entry: "./t.ts", export: "make", tools: ["Read", "Bash"] }])
    expect(warns).toEqual([])
  })
  it("ignores a non-array with a warning", () => {
    expect(runTools({}).warns).toEqual(["toolText:not_array"])
  })
  it("skips bad entries with a warning each", () => {
    const { out, warns } = runTools([
      null,
      { id: "", entry: "./a.ts", tools: ["Read"] },
      { id: "a", entry: "", tools: ["Read"] },
      { id: "b", entry: "./b.ts", export: "", tools: ["Read"] },
      { id: "c", entry: "./c.ts" },
      { id: "d", entry: "./d.ts", tools: ["Read", "Read"] },
      { id: "e", entry: "./e.ts", tools: [""] },
      { id: "ok", entry: "./ok.ts", tools: ["Read"] },
      { id: "ok", entry: "./ok2.ts", tools: ["Bash"] },
    ])
    expect(out).toEqual([{ id: "ok", entry: "./ok.ts", tools: ["Read"] }])
    expect(warns).toEqual([
      "toolText[0]:not_object",
      "toolText[1]:id",
      "toolText[2]:entry",
      "toolText[3]:export",
      "toolText[4]:tools",
      "toolText[5]:tools",
      "toolText[6]:tools",
      "toolText[8]:duplicate_id",
    ])
  })
  it("passes through parseManifest", () => {
    const m = parseManifest(
      {
        id: "p",
        name: "p",
        version: "0.1.0",
        description: "d",
        toolText: [{ id: "t", entry: "./t.ts", tools: ["Read"] }],
      },
      "/x/manifest.json",
      { warn: () => {} },
    )
    expect(m.toolText).toEqual([{ id: "t", entry: "./t.ts", tools: ["Read"] }])
  })
})

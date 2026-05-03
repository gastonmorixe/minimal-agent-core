import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadUserConfig } from "./config.ts"

describe("loadUserConfig", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-cfg-"))
    path = join(dir, "config.json")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  it("returns {} when the file does not exist", () => {
    expect(loadUserConfig()).toEqual({})
  })

  it("parses a valid config", () => {
    writeFileSync(
      path,
      JSON.stringify({
        model: "claude-opus-4-7",
        effort: "high",
        thinkingDisplay: "summarized",
        spinner: "dots",
      }),
    )
    expect(loadUserConfig()).toEqual({
      model: "claude-opus-4-7",
      effort: "high",
      thinkingDisplay: "summarized",
      spinner: "dots",
    })
  })

  it("drops invalid enum values silently", () => {
    writeFileSync(
      path,
      JSON.stringify({
        effort: "ludicrous", // invalid
        thinkingDisplay: "encrypted", // invalid
        model: "claude-opus-4-7", // valid
      }),
    )
    expect(loadUserConfig()).toEqual({ model: "claude-opus-4-7" })
  })

  it("ignores unknown keys", () => {
    writeFileSync(path, JSON.stringify({ model: "x", banana: 42, nested: { a: 1 } }))
    expect(loadUserConfig()).toEqual({ model: "x" })
  })

  it("returns {} on malformed JSON (does not throw)", () => {
    writeFileSync(path, "{not json")
    expect(loadUserConfig()).toEqual({})
  })

  it("returns {} when JSON root is not an object", () => {
    writeFileSync(path, JSON.stringify(["a", "b"]))
    expect(loadUserConfig()).toEqual({})
  })

  it("drops empty-string model/spinner/formatter", () => {
    writeFileSync(path, JSON.stringify({ model: "", spinner: "", formatter: "" }))
    expect(loadUserConfig()).toEqual({})
  })

  it("accepts all four effort values", () => {
    for (const e of ["low", "medium", "high", "max"] as const) {
      writeFileSync(path, JSON.stringify({ effort: e }))
      expect(loadUserConfig().effort).toBe(e)
    }
  })

  it("accepts both thinkingDisplay values", () => {
    for (const d of ["summarized", "omitted"] as const) {
      writeFileSync(path, JSON.stringify({ thinkingDisplay: d }))
      expect(loadUserConfig().thinkingDisplay).toBe(d)
    }
  })

  it("accepts JSONC syntax: line comments, block comments, trailing commas", () => {
    writeFileSync(
      path,
      `{
        // model preference
        "model": "claude-opus-4-7", // 1m flavor was tested
        /* opus-4.7 needs this to stream visible thinking,
           because its server default is "omitted" */
        "thinkingDisplay": "summarized",
        "effort": "high", // trailing comma allowed
      }`,
    )
    expect(loadUserConfig()).toEqual({
      model: "claude-opus-4-7",
      thinkingDisplay: "summarized",
      effort: "high",
    })
  })
})

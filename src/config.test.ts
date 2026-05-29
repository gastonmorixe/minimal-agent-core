import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  loadDisabledPluginIds,
  loadEnabledPluginIds,
  loadPluginEnabledOverrides,
  loadUserConfig,
} from "./config.ts"

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

  it("drops invalid enum values silently (effort is pass-through)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        effort: "ludicrous", // pass-through: server validates, not us
        thinkingDisplay: "encrypted", // invalid enum, dropped
        model: "claude-opus-4-7", // valid
      }),
    )
    expect(loadUserConfig()).toEqual({
      model: "claude-opus-4-7",
      effort: "ludicrous",
    })
  })

  it("drops empty-string effort", () => {
    writeFileSync(path, JSON.stringify({ effort: "" }))
    expect(loadUserConfig()).toEqual({})
  })

  it("ignores unknown keys", () => {
    writeFileSync(path, JSON.stringify({ model: "x", banana: 42, nested: { a: 1 } }))
    expect(loadUserConfig()).toEqual({ model: "x" })
  })

  it("parses statusBar.segments (string[] shape)", () => {
    writeFileSync(path, JSON.stringify({ statusBar: { segments: ["context", "quota", "sid"] } }))
    expect(loadUserConfig()).toEqual({ statusBar: { segments: ["context", "quota", "sid"] } })
  })

  it("drops a non-array / empty statusBar.segments", () => {
    writeFileSync(path, JSON.stringify({ statusBar: { segments: "quota" } }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ statusBar: { segments: [] } }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ statusBar: {} }))
    expect(loadUserConfig()).toEqual({})
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

  it("parses formatterArgs as a string array", () => {
    writeFileSync(path, JSON.stringify({ formatterArgs: ["--table-fit", "--foo"] }))
    expect(loadUserConfig()).toEqual({ formatterArgs: ["--table-fit", "--foo"] })
  })

  it("parses formatterArgs as a shell-style string", () => {
    writeFileSync(path, JSON.stringify({ formatterArgs: "--table-fit --title 'My Doc'" }))
    expect(loadUserConfig()).toEqual({ formatterArgs: ["--table-fit", "--title", "My Doc"] })
  })

  it("filters non-string / empty entries from formatterArgs array", () => {
    writeFileSync(path, JSON.stringify({ formatterArgs: ["--table-fit", "", 42, null, "--ok"] }))
    expect(loadUserConfig()).toEqual({ formatterArgs: ["--table-fit", "--ok"] })
  })

  it("drops empty/invalid formatterArgs", () => {
    writeFileSync(path, JSON.stringify({ formatterArgs: [] }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ formatterArgs: "" }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ formatterArgs: 42 }))
    expect(loadUserConfig()).toEqual({})
  })

  it("parses nerdGlyphCells: 1 | 2 | 'auto'", () => {
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: 1 }))
    expect(loadUserConfig()).toEqual({ nerdGlyphCells: 1 })
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: 2 }))
    expect(loadUserConfig()).toEqual({ nerdGlyphCells: 2 })
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: "auto" }))
    expect(loadUserConfig()).toEqual({ nerdGlyphCells: "auto" })
  })

  it("rejects unsupported nerdGlyphCells shapes (strings '1'/'2', 0, 3, null)", () => {
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: "1" }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: 0 }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: 3 }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ nerdGlyphCells: null }))
    expect(loadUserConfig()).toEqual({})
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

  it("parses apiKeys (openai + openrouter)", () => {
    writeFileSync(
      path,
      JSON.stringify({ apiKeys: { openai: "sk-openai", openrouter: "sk-or" } }),
    )
    expect(loadUserConfig()).toEqual({ apiKeys: { openai: "sk-openai", openrouter: "sk-or" } })
  })

  it("drops non-string / empty apiKeys entries, keeps the valid ones", () => {
    writeFileSync(
      path,
      JSON.stringify({ apiKeys: { openai: "sk-openai", openrouter: "", other: 42, nope: null } }),
    )
    expect(loadUserConfig()).toEqual({ apiKeys: { openai: "sk-openai" } })
  })

  it("omits apiKeys when the map is empty / all-invalid / not an object", () => {
    writeFileSync(path, JSON.stringify({ apiKeys: {} }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ apiKeys: { openai: "", openrouter: 7 } }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ apiKeys: "sk-openai" }))
    expect(loadUserConfig()).toEqual({})
    writeFileSync(path, JSON.stringify({ apiKeys: ["sk-openai"] }))
    expect(loadUserConfig()).toEqual({})
  })

  it("omits apiKeys when the key is absent entirely", () => {
    writeFileSync(path, JSON.stringify({ model: "x" }))
    expect(loadUserConfig()).toEqual({ model: "x" })
  })
})

describe("loadDisabledPluginIds", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-disabled-"))
    path = join(dir, "config.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  it("returns empty set when file is missing", () => {
    process.env.MINIMAL_AGENT_CONFIG = join(dir, "nope.jsonc")
    expect(loadDisabledPluginIds()).toEqual(new Set())
  })

  it("returns empty set when no plugins section", () => {
    writeFileSync(path, JSON.stringify({ model: "x" }))
    expect(loadDisabledPluginIds()).toEqual(new Set())
  })

  it("collects ids with enabled === false", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: {
          "web-search": { enabled: false },
          "diff-view": { enabled: true },
          "env-info": {}, // no enabled key → enabled
          "ask-mode": { enabled: false },
        },
      }),
    )
    expect(loadDisabledPluginIds()).toEqual(new Set(["web-search", "ask-mode"]))
  })

  it("ignores non-object plugin blocks", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: { "web-search": "yes", "diff-view": null, memory: { enabled: false } },
      }),
    )
    expect(loadDisabledPluginIds()).toEqual(new Set(["memory"]))
  })

  it("treats truthy non-false values as enabled", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: {
          a: { enabled: true },
          b: { enabled: 0 }, // not literal false
          c: { enabled: null },
          d: { enabled: false },
        },
      }),
    )
    expect(loadDisabledPluginIds()).toEqual(new Set(["d"]))
  })

  it("malformed JSON → empty set, no throw", () => {
    writeFileSync(path, "{ not valid")
    expect(loadDisabledPluginIds()).toEqual(new Set())
  })
})

describe("loadEnabledPluginIds + loadPluginEnabledOverrides", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-enabled-"))
    path = join(dir, "config.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  it("collects ids with enabled === true (literal only)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: {
          "interleave-thinking": { enabled: true },
          "diff-view": { enabled: false },
          "env-info": {}, // no key
          "ask-mode": { enabled: 1 }, // truthy but not literal true
        },
      }),
    )
    expect(loadEnabledPluginIds()).toEqual(new Set(["interleave-thinking"]))
  })

  it("loadPluginEnabledOverrides returns both sets in one walk", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: {
          a: { enabled: true },
          b: { enabled: false },
          c: { enabled: true },
          d: { enabled: false },
          e: {},
        },
      }),
    )
    const overrides = loadPluginEnabledOverrides()
    expect(overrides.forceEnabled).toEqual(new Set(["a", "c"]))
    expect(overrides.forceDisabled).toEqual(new Set(["b", "d"]))
  })

  it("missing config → both sets empty", () => {
    process.env.MINIMAL_AGENT_CONFIG = join(dir, "nope.jsonc")
    const overrides = loadPluginEnabledOverrides()
    expect(overrides.forceEnabled).toEqual(new Set())
    expect(overrides.forceDisabled).toEqual(new Set())
  })

  it("malformed JSON → both sets empty, no throw", () => {
    writeFileSync(path, "{ not valid")
    const overrides = loadPluginEnabledOverrides()
    expect(overrides.forceEnabled).toEqual(new Set())
    expect(overrides.forceDisabled).toEqual(new Set())
  })
})

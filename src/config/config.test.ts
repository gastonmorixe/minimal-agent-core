import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  loadDisabledPluginIds,
  loadEnabledPluginIds,
  loadPluginEnabledOverrides,
  loadPluginPromptsConfig,
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
        model: "test-model-1",
        provider: "test-provider",
        effort: "high",
        thinkingDisplay: "summarized",
      }),
    )
    expect(loadUserConfig()).toEqual({
      model: "test-model-1",
      provider: "test-provider",
      effort: "high",
      thinkingDisplay: "summarized",
    })
  })

  it("drops invalid enum values silently (effort is pass-through)", () => {
    writeFileSync(
      path,
      JSON.stringify({
        effort: "ludicrous", // pass-through: server validates, not us
        thinkingDisplay: "encrypted", // invalid enum, dropped
        model: "test-model-1", // valid
      }),
    )
    expect(loadUserConfig()).toEqual({
      model: "test-model-1",
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

  it("drops the terminal and plugin keys: the CLI and the quota-status plugin read them", () => {
    writeFileSync(
      path,
      JSON.stringify({
        spinner: "dots",
        formatter: "bat",
        formatterArgs: ["--table-fit"],
        header: true,
        autoAsk: false,
        skipQuota: true,
        nerdGlyphCells: 2,
        scrollback: { submittedAt: "off" },
        statusBar: { segments: ["quota"] },
      }),
    )
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

  it("drops empty-string model", () => {
    writeFileSync(path, JSON.stringify({ model: "" }))
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

  it("accepts both cacheTtl buckets", () => {
    for (const t of ["5m", "1h"] as const) {
      writeFileSync(path, JSON.stringify({ cacheTtl: t }))
      expect(loadUserConfig().cacheTtl).toBe(t)
    }
  })

  it("accepts a boolean netDbg and drops other types", () => {
    writeFileSync(path, JSON.stringify({ netDbg: true }))
    expect(loadUserConfig().netDbg).toBe(true)
    writeFileSync(path, JSON.stringify({ netDbg: false }))
    expect(loadUserConfig().netDbg).toBe(false)
    writeFileSync(path, JSON.stringify({ netDbg: "yes" }))
    expect(loadUserConfig().netDbg).toBeUndefined()
  })

  it("drops an invalid cacheTtl value", () => {
    writeFileSync(path, JSON.stringify({ cacheTtl: "2h" }))
    expect(loadUserConfig().cacheTtl).toBeUndefined()
  })

  it("accepts JSONC syntax: line comments, block comments, trailing commas", () => {
    writeFileSync(
      path,
      `{
        // model preference
        "model": "test-model-1", // large-context flavor was tested
        /* test-model-1 needs this to stream visible thinking,
           because its server default is "omitted" */
        "thinkingDisplay": "summarized",
        "effort": "high", // trailing comma allowed
      }`,
    )
    expect(loadUserConfig()).toEqual({
      model: "test-model-1",
      thinkingDisplay: "summarized",
      effort: "high",
    })
  })

  it("ignores apiKeys because provider auth belongs in the auth store", () => {
    writeFileSync(path, JSON.stringify({ apiKeys: { acme: "sk-acme", globex: "sk-glx" } }))
    expect(loadUserConfig()).toEqual({})
  })

  it("loads model when apiKeys is absent", () => {
    writeFileSync(path, JSON.stringify({ model: "x" }))
    expect(loadUserConfig()).toEqual({ model: "x" })
  })

  it("loads provider when model is absent", () => {
    writeFileSync(path, JSON.stringify({ provider: "test-gateway" }))
    expect(loadUserConfig()).toEqual({ provider: "test-gateway" })
  })

  it("parses systemPrompt with string values as text replacements", () => {
    writeFileSync(
      path,
      JSON.stringify({
        systemPrompt: {
          identity: "custom identity",
          instructions: "custom instructions",
        },
      }),
    )
    expect(loadUserConfig()).toEqual({
      systemPrompt: { identity: "custom identity", instructions: "custom instructions" },
    })
  })

  it("parses systemPrompt with false/null as omit signals", () => {
    writeFileSync(
      path,
      JSON.stringify({
        systemPrompt: {
          loopSafety: false,
          toolOutputConventions: null,
        },
      }),
    )
    expect(loadUserConfig()).toEqual({
      systemPrompt: { loopSafety: false, toolOutputConventions: null },
    })
  })

  it("parses systemPrompt file keys", () => {
    writeFileSync(
      path,
      JSON.stringify({
        systemPrompt: {
          instructionsFile: "/tmp/instructions.md",
          identityFile: "/tmp/identity.md",
        },
      }),
    )
    expect(loadUserConfig()).toEqual({
      systemPrompt: { instructionsFile: "/tmp/instructions.md", identityFile: "/tmp/identity.md" },
    })
  })

  it("parses systemPrompt unsafeProviderOverrides", () => {
    writeFileSync(
      path,
      JSON.stringify({
        systemPrompt: { unsafeProviderOverrides: true },
      }),
    )
    expect(loadUserConfig()).toEqual({
      systemPrompt: { unsafeProviderOverrides: true },
    })
  })

  it("drops unknown systemPrompt keys", () => {
    writeFileSync(
      path,
      JSON.stringify({
        systemPrompt: { identity: "x", banana: 42 },
      }),
    )
    expect(loadUserConfig()).toEqual({ systemPrompt: { identity: "x" } })
  })

  it("drops empty systemPrompt object", () => {
    writeFileSync(path, JSON.stringify({ systemPrompt: {} }))
    expect(loadUserConfig()).toEqual({})
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

describe("loadPluginPromptsConfig", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-prompts-"))
    path = join(dir, "config.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  it("returns true for a boolean true", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: true } }))
    expect(loadPluginPromptsConfig()).toBe(true)
  })

  it("returns false for a boolean false", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: false } }))
    expect(loadPluginPromptsConfig()).toBe(false)
  })

  it("returns the object shape with keep and suppress", () => {
    writeFileSync(
      path,
      JSON.stringify({ plugins: { prompts: { keep: ["memory"], suppress: ["skills"] } } }),
    )
    expect(loadPluginPromptsConfig()).toEqual({ keep: ["memory"], suppress: ["skills"] })
  })

  it("returns the object shape with all", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: { all: true } } }))
    expect(loadPluginPromptsConfig()).toEqual({ all: true })
  })

  it("drops non-string list entries", () => {
    writeFileSync(
      path,
      JSON.stringify({ plugins: { prompts: { keep: ["memory", 7, ""], suppress: "nope" } } }),
    )
    expect(loadPluginPromptsConfig()).toEqual({ keep: ["memory"] })
  })

  it("an object with an enabled key is a plugin block, not this feature", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: { enabled: false } } }))
    expect(loadPluginPromptsConfig()).toBeUndefined()
  })

  it("an object with an unknown key is not this feature", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: { keep: ["a"], other: 1 } } }))
    expect(loadPluginPromptsConfig()).toBeUndefined()
  })

  it("per-plugin enable blocks are untouched by this reader", () => {
    writeFileSync(
      path,
      JSON.stringify({
        plugins: { "diff-view": { enabled: false }, prompts: { keep: ["memory"] } },
      }),
    )
    expect(loadPluginPromptsConfig()).toEqual({ keep: ["memory"] })
    expect(loadEnabledPluginIds()).toEqual(new Set())
    expect(loadDisabledPluginIds()).toEqual(new Set(["diff-view"]))
  })

  it("missing key, missing file, and bad JSON → undefined", () => {
    writeFileSync(path, JSON.stringify({ model: "x" }))
    expect(loadPluginPromptsConfig()).toBeUndefined()
    process.env.MINIMAL_AGENT_CONFIG = join(dir, "nope.jsonc")
    expect(loadPluginPromptsConfig()).toBeUndefined()
    writeFileSync(path, "{ not valid")
    expect(loadPluginPromptsConfig()).toBeUndefined()
  })

  it("loadUserConfig surfaces the prompts value", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: { suppress: ["skills"] } } }))
    expect(loadUserConfig().plugins).toEqual({ prompts: { suppress: ["skills"] } })
  })

  it("loadUserConfig omits plugins when the value is a plugin block", () => {
    writeFileSync(path, JSON.stringify({ plugins: { prompts: { enabled: true } } }))
    expect(loadUserConfig().plugins).toBeUndefined()
  })
})

/**
 * Tests for the web-search plugin's config loader.
 *
 * Covers: defaults, full happy-path, partial overrides, malformed values
 * (dropped silently), `enabled` toggle, provider-config blocks under
 * `plugins["web-search"].<id>`, missing file → defaults.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { defaultConfig, loadWebSearchConfig, parseWebSearchConfig } from "./config.ts"

describe("parseWebSearchConfig", () => {
  test("non-object input → defaults", () => {
    expect(parseWebSearchConfig(null)).toEqual(defaultConfig())
    expect(parseWebSearchConfig(42)).toEqual(defaultConfig())
    expect(parseWebSearchConfig([])).toEqual(defaultConfig())
  })

  test('missing plugins["web-search"] → defaults', () => {
    expect(parseWebSearchConfig({})).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: {} })).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: { other: {} } })).toEqual(defaultConfig())
    expect(parseWebSearchConfig({ plugins: { websearch: { enabled: false } } })).toEqual(
      defaultConfig(),
    )
  })

  test("happy-path full config", () => {
    const cfg = parseWebSearchConfig({
      plugins: {
        "web-search": {
          enabled: true,
          providers: ["brave", "tavily"],
          defaults: { count: 5, safesearch: "off", country: "US", lang: "en", type: "news" },
          brave: { apiKeyEnv: "BRAVE_API_KEY" },
          tavily: { apiKey: "secret" },
        },
      },
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.providers).toEqual(["brave", "tavily"])
    expect(cfg.defaults.count).toBe(5)
    expect(cfg.defaults.safesearch).toBe("off")
    expect(cfg.defaults.type).toBe("news")
    expect(cfg.providerConfigs.brave).toEqual({ apiKeyEnv: "BRAVE_API_KEY" })
    expect(cfg.providerConfigs.tavily).toEqual({ apiKey: "secret" })
  })

  test("disabled flag", () => {
    const cfg = parseWebSearchConfig({ plugins: { "web-search": { enabled: false } } })
    expect(cfg.enabled).toBe(false)
  })

  test("invalid types are dropped silently", () => {
    const cfg = parseWebSearchConfig({
      plugins: {
        "web-search": {
          providers: [42, "brave", null, ""],
          defaults: { count: -1, safesearch: "yolo", country: 123, type: "videos" },
          brave: "not-an-object",
        },
      },
    })
    expect(cfg.providers).toEqual(["brave"]) // non-strings dropped
    expect(cfg.defaults.count).toBe(10) // default kept
    expect(cfg.defaults.safesearch).toBe("moderate") // invalid enum dropped
    expect(cfg.defaults.country).toBe("ALL") // wrong type dropped
    expect(cfg.defaults.type).toBeUndefined() // unsupported vertical dropped
    // brave block was a string, so the default config block is kept.
    expect(cfg.providerConfigs.brave).toEqual({ apiKeyEnv: "BRAVE_API_KEY" })
  })

  test("partial defaults merge with built-ins", () => {
    const cfg = parseWebSearchConfig({
      plugins: { "web-search": { defaults: { count: 3 } } },
    })
    expect(cfg.defaults.count).toBe(3)
    expect(cfg.defaults.safesearch).toBe("moderate") // built-in survives
    expect(cfg.defaults.country).toBe("ALL")
  })

  test("empty providers array → defaults survive", () => {
    const cfg = parseWebSearchConfig({
      plugins: { "web-search": { providers: [] } },
    })
    expect(cfg.providers).toEqual(["brave"])
  })
})

describe("loadWebSearchConfig", () => {
  let tmpDir: string
  let prevConfigEnv: string | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ws-cfg-"))
    prevConfigEnv = process.env.MINIMAL_AGENT_CONFIG
  })

  afterEach(() => {
    if (prevConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfigEnv
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test("missing file → defaults", () => {
    process.env.MINIMAL_AGENT_CONFIG = join(tmpDir, "nope.jsonc")
    expect(loadWebSearchConfig()).toEqual(defaultConfig())
  })

  test("reads jsonc with comments + trailing commas", () => {
    const path = join(tmpDir, "config.jsonc")
    writeFileSync(
      path,
      `{
        // model is unrelated; we only care about plugins["web-search"]
        "model": "claude-opus-4-7",
        "plugins": {
          "web-search": {
            "providers": ["brave"],
            "defaults": { "count": 3, },
            "brave": { "apiKey": "inline-key" },
          },
        },
      }`,
    )
    process.env.MINIMAL_AGENT_CONFIG = path
    const cfg = loadWebSearchConfig()
    expect(cfg.providers).toEqual(["brave"])
    expect(cfg.defaults.count).toBe(3)
    expect(cfg.providerConfigs.brave).toEqual({ apiKey: "inline-key" })
  })

  test("malformed jsonc → defaults (no throw)", () => {
    const path = join(tmpDir, "bad.jsonc")
    writeFileSync(path, "{ not valid")
    process.env.MINIMAL_AGENT_CONFIG = path
    expect(loadWebSearchConfig()).toEqual(defaultConfig())
  })
})

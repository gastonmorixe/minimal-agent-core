/**
 * Tests for {@link loadMemoryConfig} and {@link resolveMemoryConfig}.
 *
 * Strategy: write a temp config file, point the loader at it via the
 * `path` option, assert the returned shape. `resolveMemoryConfig` is
 * tested directly with hand-constructed raw slices so we get unit
 * coverage on the back-compat branch without round-tripping through
 * JSONC.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import {
  DEFAULT_MEMORY_CONFIG,
  loadMemoryConfig,
  memoryConfigPath,
  resolveMemoryConfig,
} from "./memory-config.ts"

const tempDirs: string[] = []

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mem-config-test-"))
  tempDirs.push(d)
  return d
}

function writeConfig(content: string): string {
  const dir = makeTempDir()
  const path = join(dir, "config.jsonc")
  writeFileSync(path, content)
  return path
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  }
})

// ---------------------------------------------------------------------------
// loadMemoryConfig: file I/O + defaults
// ---------------------------------------------------------------------------

describe("loadMemoryConfig: defaults", () => {
  it("returns defaults when file is missing", () => {
    const cfg = loadMemoryConfig({ path: "/no/such/path" })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it("returns defaults when file is empty", () => {
    const path = writeConfig("")
    const cfg = loadMemoryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it("default inject mode is 'latest'", () => {
    // Regression guard: the default from v0.4+ is "latest" — inject the
    // N most-recent bullets per scope so the model has memory access
    // without blowing up context. If this ever flips back accidentally,
    // the system prompt silently loses pre-loaded memories.
    expect(DEFAULT_MEMORY_CONFIG.inject).toBe("latest")
  })

  it("returns defaults when file has no plugins section", () => {
    const path = writeConfig(`{"model": "claude-opus-4-7"}`)
    const cfg = loadMemoryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it("returns defaults when plugins.memory is missing", () => {
    const path = writeConfig(`{"plugins": {"web-search": {"enabled": true}}}`)
    const cfg = loadMemoryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it("returns defaults when plugins.memory is present but empty", () => {
    const path = writeConfig(`{"plugins": {"memory": {}}}`)
    const cfg = loadMemoryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })

  it("returns defaults when JSON is malformed", () => {
    const path = writeConfig(`{this is not json`)
    const cfg = loadMemoryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_CONFIG)
  })
})

// ---------------------------------------------------------------------------
// resolveMemoryConfig: inject knob
// ---------------------------------------------------------------------------

describe("resolveMemoryConfig: inject mode", () => {
  it("accepts inject='none'", () => {
    const cfg = resolveMemoryConfig({ inject: "none" })
    expect(cfg.inject).toBe("none")
  })

  it("accepts inject='verbatim'", () => {
    const cfg = resolveMemoryConfig({ inject: "verbatim" })
    expect(cfg.inject).toBe("verbatim")
  })

  it("accepts inject='summary'", () => {
    const cfg = resolveMemoryConfig({ inject: "summary" })
    expect(cfg.inject).toBe("summary")
  })

  it("ignores unknown inject value, keeps default", () => {
    const cfg = resolveMemoryConfig({ inject: "everything" })
    expect(cfg.inject).toBe(DEFAULT_MEMORY_CONFIG.inject)
  })

  it("ignores non-string inject value", () => {
    const cfg = resolveMemoryConfig({ inject: true as unknown as string })
    expect(cfg.inject).toBe(DEFAULT_MEMORY_CONFIG.inject)
  })

  it("returns default 'latest' when nothing is set", () => {
    const cfg = resolveMemoryConfig({})
    expect(cfg.inject).toBe("latest")
  })
})

// ---------------------------------------------------------------------------
// resolveMemoryConfig: back-compat for legacy `summary.enabled`
// ---------------------------------------------------------------------------

describe("resolveMemoryConfig: legacy summary.enabled back-compat", () => {
  it("legacy summary.enabled=true with no inject resolves to inject='summary'", () => {
    const cfg = resolveMemoryConfig({ summary: { enabled: true } })
    expect(cfg.inject).toBe("summary")
  })

  it("legacy summary.enabled=false with no inject keeps default 'latest'", () => {
    // The old default was verbatim under enabled=false. The new default
    // is `latest`. Existing users who never touched the knob are migrated
    // into the lightweight injection world: that's the explicit intent.
    const cfg = resolveMemoryConfig({ summary: { enabled: false } })
    expect(cfg.inject).toBe("latest")
  })

  it("explicit inject='verbatim' overrides legacy summary.enabled=true", () => {
    const cfg = resolveMemoryConfig({
      inject: "verbatim",
      summary: { enabled: true },
    })
    expect(cfg.inject).toBe("verbatim")
  })

  it("explicit inject='none' overrides legacy summary.enabled=true", () => {
    const cfg = resolveMemoryConfig({
      inject: "none",
      summary: { enabled: true },
    })
    expect(cfg.inject).toBe("none")
  })

  it("legacy summary.enabled string 'true' is NOT treated as boolean true", () => {
    // We deliberately match strict `=== true` so a typo like
    // `"enabled": "true"` falls through to the new default instead of
    // silently re-enabling old behavior.
    const cfg = resolveMemoryConfig({ summary: { enabled: "true" } })
    expect(cfg.inject).toBe("latest")
  })
})

// ---------------------------------------------------------------------------
// resolveMemoryConfig: summary param parsing
// ---------------------------------------------------------------------------

describe("resolveMemoryConfig: summary params", () => {
  it("parses custom model", () => {
    const cfg = resolveMemoryConfig({ summary: { model: "claude-sonnet-4-6" } })
    expect(cfg.summary.model).toBe("claude-sonnet-4-6")
  })

  it("parses minBullets / minBytes / dirtyBullets", () => {
    const cfg = resolveMemoryConfig({
      summary: { minBullets: 50, minBytes: 30_000, dirtyBullets: 5 },
    })
    expect(cfg.summary.minBullets).toBe(50)
    expect(cfg.summary.minBytes).toBe(30_000)
    expect(cfg.summary.dirtyBullets).toBe(5)
  })

  it("ignores invalid types (per-key)", () => {
    const cfg = resolveMemoryConfig({
      summary: {
        model: 123,
        minBullets: -5,
        minBytes: "huge",
        dirtyBullets: null,
      },
    })
    expect(cfg.summary.model).toBe(DEFAULT_MEMORY_CONFIG.summary.model)
    expect(cfg.summary.minBullets).toBe(DEFAULT_MEMORY_CONFIG.summary.minBullets)
    expect(cfg.summary.minBytes).toBe(DEFAULT_MEMORY_CONFIG.summary.minBytes)
    expect(cfg.summary.dirtyBullets).toBe(DEFAULT_MEMORY_CONFIG.summary.dirtyBullets)
  })

  it("floors non-integer minBullets", () => {
    const cfg = resolveMemoryConfig({ summary: { minBullets: 42.9 } })
    expect(cfg.summary.minBullets).toBe(42)
  })

  it("rejects empty model string", () => {
    const cfg = resolveMemoryConfig({ summary: { model: "" } })
    expect(cfg.summary.model).toBe(DEFAULT_MEMORY_CONFIG.summary.model)
  })

  it("preserves default summary params when only inject is set", () => {
    const cfg = resolveMemoryConfig({ inject: "summary" })
    expect(cfg.summary).toEqual(DEFAULT_MEMORY_CONFIG.summary)
  })
})

// ---------------------------------------------------------------------------
// loadMemoryConfig: round-trip via JSONC
// ---------------------------------------------------------------------------

describe("loadMemoryConfig: JSONC round-trip", () => {
  it("respects JSONC comments and trailing commas", () => {
    const path = writeConfig(`
      // top-level
      {
        "plugins": {
          "memory": {
            "inject": "verbatim", // legacy verbatim mode
            "summary": {
              "minBullets": 40, /* trailing comma below */
            },
          },
        },
      }
    `)
    const cfg = loadMemoryConfig({ path })
    expect(cfg.inject).toBe("verbatim")
    expect(cfg.summary.minBullets).toBe(40)
  })

  it("end-to-end: inject='summary' with custom params", () => {
    const path = writeConfig(
      JSON.stringify({
        plugins: {
          memory: {
            inject: "summary",
            summary: {
              model: "claude-sonnet-4-6",
              minBullets: 50,
              minBytes: 30_000,
              dirtyBullets: 5,
            },
          },
        },
      }),
    )
    const cfg = loadMemoryConfig({ path })
    expect(cfg.inject).toBe("summary")
    expect(cfg.summary.model).toBe("claude-sonnet-4-6")
    expect(cfg.summary.minBullets).toBe(50)
    expect(cfg.summary.minBytes).toBe(30_000)
    expect(cfg.summary.dirtyBullets).toBe(5)
  })

  it("end-to-end: legacy summary.enabled=true migrates", () => {
    const path = writeConfig(
      JSON.stringify({
        plugins: { memory: { summary: { enabled: true, minBullets: 25 } } },
      }),
    )
    const cfg = loadMemoryConfig({ path })
    expect(cfg.inject).toBe("summary")
    expect(cfg.summary.minBullets).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// memoryConfigPath
// ---------------------------------------------------------------------------

describe("memoryConfigPath", () => {
  it("respects MINIMAL_AGENT_CONFIG override", () => {
    const path = memoryConfigPath({
      env: { MINIMAL_AGENT_CONFIG: "/forced/path.jsonc" } as NodeJS.ProcessEnv,
    })
    expect(path).toBe("/forced/path.jsonc")
  })

  it("prefers .jsonc when present", () => {
    const dir = makeTempDir()
    const jsoncPath = join(dir, ".minimal-agent", "config.jsonc")
    mkdirSync(join(dir, ".minimal-agent"), { recursive: true })
    writeFileSync(jsoncPath, "{}")
    const resolved = memoryConfigPath({ home: dir, env: {} as NodeJS.ProcessEnv })
    expect(resolved).toBe(jsoncPath)
  })

  it("falls back to .json when .jsonc absent", () => {
    const dir = makeTempDir()
    const resolved = memoryConfigPath({ home: dir, env: {} as NodeJS.ProcessEnv })
    expect(resolved).toBe(join(dir, ".minimal-agent", "config.json"))
  })
})

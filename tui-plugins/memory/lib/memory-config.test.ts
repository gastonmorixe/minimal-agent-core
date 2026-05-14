/**
 * Tests for {@link loadMemorySummaryConfig}.
 *
 * Strategy: write a temp config file, point the loader at it via the
 * `path` option, assert the returned shape.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  DEFAULT_MEMORY_SUMMARY_CONFIG,
  loadMemorySummaryConfig,
  memoryConfigPath,
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

describe("loadMemorySummaryConfig — defaults", () => {
  it("returns defaults when file is missing", () => {
    const cfg = loadMemorySummaryConfig({ path: "/no/such/path" })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })

  it("returns defaults when file is empty", () => {
    const path = writeConfig("")
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })

  it("returns defaults when file has no plugins section", () => {
    const path = writeConfig(`{"model": "claude-opus-4-7"}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })

  it("returns defaults when plugins.memory is missing", () => {
    const path = writeConfig(`{"plugins": {"web-search": {"enabled": true}}}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })

  it("returns defaults when plugins.memory.summary is missing", () => {
    const path = writeConfig(`{"plugins": {"memory": {"enabled": true}}}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })

  it("returns defaults when JSON is malformed", () => {
    const path = writeConfig(`{this is not json`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg).toEqual(DEFAULT_MEMORY_SUMMARY_CONFIG)
  })
})

describe("loadMemorySummaryConfig — key parsing", () => {
  it("parses enabled=true", () => {
    const path = writeConfig(`{"plugins":{"memory":{"summary":{"enabled":true}}}}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.enabled).toBe(true)
  })

  it("parses custom model", () => {
    const path = writeConfig(
      `{"plugins":{"memory":{"summary":{"model":"claude-sonnet-4-6"}}}}`,
    )
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.model).toBe("claude-sonnet-4-6")
  })

  it("parses minBullets / minBytes / dirtyBullets", () => {
    const path = writeConfig(
      `{"plugins":{"memory":{"summary":{"minBullets":50,"minBytes":30000,"dirtyBullets":5}}}}`,
    )
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.minBullets).toBe(50)
    expect(cfg.minBytes).toBe(30_000)
    expect(cfg.dirtyBullets).toBe(5)
  })

  it("respects JSONC comments and trailing commas", () => {
    const path = writeConfig(`
      // top-level
      {
        "plugins": {
          "memory": {
            "summary": {
              // enable summarization
              "enabled": true,
              "minBullets": 40, /* trailing comma below */
            },
          },
        },
      }
    `)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.enabled).toBe(true)
    expect(cfg.minBullets).toBe(40)
  })

  it("ignores invalid types (falls back to defaults per-key)", () => {
    const path = writeConfig(`
      {"plugins":{"memory":{"summary":{
        "enabled": "yes",
        "model": 123,
        "minBullets": -5,
        "minBytes": "huge",
        "dirtyBullets": null
      }}}}
    `)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.enabled).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.enabled)
    expect(cfg.model).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.model)
    // minBullets: -5 fails the `>= 0` check, falls back
    expect(cfg.minBullets).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.minBullets)
    expect(cfg.minBytes).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.minBytes)
    expect(cfg.dirtyBullets).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.dirtyBullets)
  })

  it("floors non-integer minBullets", () => {
    const path = writeConfig(`{"plugins":{"memory":{"summary":{"minBullets":42.9}}}}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.minBullets).toBe(42)
  })

  it("rejects empty model string", () => {
    const path = writeConfig(`{"plugins":{"memory":{"summary":{"model":""}}}}`)
    const cfg = loadMemorySummaryConfig({ path })
    expect(cfg.model).toBe(DEFAULT_MEMORY_SUMMARY_CONFIG.model)
  })
})

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
    // create the .jsonc file
    const { mkdirSync, writeFileSync: wf } = require("node:fs") as typeof import("node:fs")
    mkdirSync(join(dir, ".minimal-agent"), { recursive: true })
    wf(jsoncPath, "{}")
    const resolved = memoryConfigPath({ home: dir, env: {} as NodeJS.ProcessEnv })
    expect(resolved).toBe(jsoncPath)
  })

  it("falls back to .json when .jsonc absent", () => {
    const dir = makeTempDir()
    const resolved = memoryConfigPath({ home: dir, env: {} as NodeJS.ProcessEnv })
    expect(resolved).toBe(join(dir, ".minimal-agent", "config.json"))
  })
})

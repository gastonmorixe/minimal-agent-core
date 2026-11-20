import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  DEFAULT_MAX_CONCURRENT_TOOL_CALLS,
  MAX_CONCURRENT_TOOL_CALLS_ENV,
  normalizeMaxConcurrentToolCalls,
  parseMaxConcurrentToolCallsEnv,
  resolveMaxConcurrentToolCalls,
} from "./concurrency-cap.ts"
import { loadUserConfig } from "./config.ts"

describe("resolveMaxConcurrentToolCalls", () => {
  it("the default is 10", () => {
    expect(DEFAULT_MAX_CONCURRENT_TOOL_CALLS).toBe(10)
    expect(resolveMaxConcurrentToolCalls({})).toEqual({ value: 10, source: "default" })
  })

  it("uses the config value", () => {
    expect(resolveMaxConcurrentToolCalls({ config: 4 })).toEqual({ value: 4, source: "config" })
  })

  it("the env value wins over the config value", () => {
    expect(resolveMaxConcurrentToolCalls({ env: "7", config: 4 })).toEqual({
      value: 7,
      source: "env",
    })
  })

  it("ignores an invalid env value and uses the next layer", () => {
    for (const env of ["", "0", "-2", "1.5", "abc", "3x", " "]) {
      expect(resolveMaxConcurrentToolCalls({ env, config: 4 })).toEqual({
        value: 4,
        source: "config",
      })
    }
  })

  it("ignores an invalid config value", () => {
    for (const config of [0, -1, 2.5, "4", true, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveMaxConcurrentToolCalls({ config })).toEqual({ value: 10, source: "default" })
    }
  })

  it("normalize accepts integers >= 1; the env parse accepts digit strings", () => {
    expect(normalizeMaxConcurrentToolCalls(1)).toBe(1)
    expect(normalizeMaxConcurrentToolCalls("10")).toBeUndefined()
    expect(parseMaxConcurrentToolCallsEnv(" 10 ")).toBe(10)
    expect(parseMaxConcurrentToolCallsEnv(undefined)).toBeUndefined()
    expect(normalizeMaxConcurrentToolCalls(0)).toBeUndefined()
    expect(normalizeMaxConcurrentToolCalls(undefined)).toBeUndefined()
  })

  it("names the env key", () => {
    expect(MAX_CONCURRENT_TOOL_CALLS_ENV).toBe("MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS")
  })
})

describe("loadUserConfig maxConcurrentToolCalls", () => {
  let dir: string
  let path: string
  const prevEnv = process.env.MINIMAL_AGENT_CONFIG

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-cap-"))
    path = join(dir, "config.json")
    process.env.MINIMAL_AGENT_CONFIG = path
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevEnv
  })

  it("keeps a valid integer", () => {
    writeFileSync(path, JSON.stringify({ maxConcurrentToolCalls: 6 }))
    expect(loadUserConfig()).toEqual({ maxConcurrentToolCalls: 6 })
  })

  it("drops an invalid value", () => {
    for (const v of [0, -3, 1.5, "6", false]) {
      writeFileSync(path, JSON.stringify({ maxConcurrentToolCalls: v }))
      expect(loadUserConfig()).toEqual({})
    }
  })
})

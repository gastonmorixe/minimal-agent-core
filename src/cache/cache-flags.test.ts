import { describe, expect, it } from "bun:test"

import { resolveCacheAnchor, resolveThinkingHistory } from "./cache-flags.ts"

describe("resolveCacheAnchor", () => {
  it("defaults to ON", () => {
    expect(resolveCacheAnchor({})).toEqual({ enabled: true, source: "default" })
  })

  it("each layer can turn the default off", () => {
    expect(resolveCacheAnchor({ cli: false })).toEqual({ enabled: false, source: "cli" })
    expect(resolveCacheAnchor({ env: "0" })).toEqual({ enabled: false, source: "env" })
    expect(resolveCacheAnchor({ config: false })).toEqual({ enabled: false, source: "config" })
  })

  it("precedence: cli > env > config", () => {
    expect(resolveCacheAnchor({ cli: false, env: "1", config: true })).toEqual({
      enabled: false,
      source: "cli",
    })
    expect(resolveCacheAnchor({ env: "1", config: false })).toEqual({
      enabled: true,
      source: "env",
    })
    expect(resolveCacheAnchor({ env: "off", config: true })).toEqual({
      enabled: false,
      source: "env",
    })
    expect(resolveCacheAnchor({ env: "", config: true })).toEqual({
      enabled: true,
      source: "config",
    })
    expect(resolveCacheAnchor({ env: "bogus" })).toEqual({ enabled: true, source: "default" })
  })
})

describe("resolveThinkingHistory", () => {
  it("defaults to strip", () => {
    expect(resolveThinkingHistory({})).toEqual({ mode: "strip", source: "default" })
  })

  it("precedence: cli > env > config, invalid values fall through", () => {
    expect(resolveThinkingHistory({ cli: "keep", env: "strip", config: "strip" })).toEqual({
      mode: "keep",
      source: "cli",
    })
    expect(resolveThinkingHistory({ cli: "nope", env: "keep" })).toEqual({
      mode: "keep",
      source: "env",
    })
    expect(resolveThinkingHistory({ env: "", config: "keep" })).toEqual({
      mode: "keep",
      source: "config",
    })
  })
})

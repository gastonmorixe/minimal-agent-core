/**
 * Tests for diagnostics config resolution. Defaults are "types + format, fast";
 * the slow/noisy linter is opt-in. Parsing is pure over a raw object so it
 * tests without touching the real config file.
 */
import { describe, expect, it } from "bun:test"

import { DEFAULT_CONFIG, resolveConfig } from "./config.ts"

describe("resolveConfig", () => {
  it("returns defaults for an empty / missing block", () => {
    expect(resolveConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG)
  })

  it("defaults: enabled, type+format on, lint off", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CONFIG.type).toBe(true)
    expect(DEFAULT_CONFIG.format).toBe(true)
    expect(DEFAULT_CONFIG.lint).toBe(false)
  })

  it("honors explicit overrides", () => {
    const c = resolveConfig({ enabled: true, lint: true, severityFloor: "error", maxInline: 3 })
    expect(c.lint).toBe(true)
    expect(c.severityFloor).toBe("error")
    expect(c.maxInline).toBe(3)
  })

  it("ignores malformed values and falls back to defaults", () => {
    const c = resolveConfig({ type: "yes", maxInline: -4, severityFloor: "loud" })
    expect(c.type).toBe(DEFAULT_CONFIG.type)
    expect(c.maxInline).toBe(DEFAULT_CONFIG.maxInline)
    expect(c.severityFloor).toBe(DEFAULT_CONFIG.severityFloor)
  })

  it("respects enabled:false", () => {
    expect(resolveConfig({ enabled: false }).enabled).toBe(false)
  })
})

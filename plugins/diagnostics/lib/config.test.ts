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

  it("defaults: enabled, type+format on, lint off, apple on", () => {
    expect(DEFAULT_CONFIG.enabled).toBe(true)
    expect(DEFAULT_CONFIG.type).toBe(true)
    expect(DEFAULT_CONFIG.format).toBe(true)
    expect(DEFAULT_CONFIG.lint).toBe(false)
    expect(DEFAULT_CONFIG.apple).toBe(true)
  })

  it("honors explicit overrides", () => {
    const c = resolveConfig({
      enabled: true,
      lint: true,
      apple: false,
      severityFloor: "error",
      maxInline: 3,
    })
    expect(c.lint).toBe(true)
    expect(c.apple).toBe(false)
    expect(c.severityFloor).toBe("error")
    expect(c.maxInline).toBe(3)
  })

  it("turns apple off via config", () => {
    const c = resolveConfig({ apple: false })
    expect(c.apple).toBe(false)
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

  it("outOfScope defaults to enabled", () => {
    expect(DEFAULT_CONFIG.outOfScope.enabled).toBe(true)
    expect(resolveConfig({}).outOfScope.enabled).toBe(true)
  })

  it("outOfScope can be disabled", () => {
    const c = resolveConfig({ outOfScope: { enabled: false } })
    expect(c.outOfScope.enabled).toBe(false)
  })

  it("outOfScope tolerates malformed sub-object", () => {
    const c = resolveConfig({ outOfScope: "not an object" })
    expect(c.outOfScope.enabled).toBe(DEFAULT_CONFIG.outOfScope.enabled)
  })
})

import { describe, expect, it } from "bun:test"

import { resolveEffectivePlatform } from "./plugin-platform-resolution.ts"

describe("resolveEffectivePlatform", () => {
  it("falls back to detected when no override", () => {
    const r = resolveEffectivePlatform({ detected: "linux" })
    expect(r).toEqual({ platform: "linux", source: "detected" })
  })

  it("env overrides detected", () => {
    const r = resolveEffectivePlatform({ env: "windows", detected: "linux" })
    expect(r).toEqual({ platform: "windows", source: "env" })
  })

  it("cli overrides env and detected", () => {
    const r = resolveEffectivePlatform({ cli: "macos", env: "windows", detected: "linux" })
    expect(r).toEqual({ platform: "macos", source: "cli" })
  })

  it("normalizes aliases in overrides", () => {
    expect(resolveEffectivePlatform({ cli: "darwin", detected: "linux" }).platform).toBe("macos")
    expect(resolveEffectivePlatform({ env: "win32", detected: "linux" }).platform).toBe("windows")
  })

  it("supports the all bypass", () => {
    const r = resolveEffectivePlatform({ cli: "all", detected: "macos" })
    expect(r).toEqual({ platform: "all", source: "cli" })
  })

  it("treats empty strings as unset", () => {
    const r = resolveEffectivePlatform({ cli: "", env: "  ", detected: "linux" })
    expect(r).toEqual({ platform: "linux", source: "detected" })
  })

  it("skips an unrecognized override and reports it via invalid", () => {
    const r = resolveEffectivePlatform({ cli: "plan9", detected: "linux" })
    expect(r.platform).toBe("linux")
    expect(r.source).toBe("detected")
    expect(r.invalid).toBe("plan9")
  })

  it("falls through from a bad cli to a good env", () => {
    const r = resolveEffectivePlatform({ cli: "plan9", env: "macos", detected: "linux" })
    expect(r.platform).toBe("macos")
    expect(r.source).toBe("env")
    expect(r.invalid).toBe("plan9")
  })
})

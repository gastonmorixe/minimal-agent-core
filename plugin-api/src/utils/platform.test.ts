import { describe, expect, it } from "bun:test"

import {
  detectPlatform,
  KNOWN_PLATFORMS,
  normalizePlatform,
  PLATFORM_ALL,
  platformAllowed,
} from "./platform.ts"

describe("detectPlatform", () => {
  it("maps darwin to macos", () => {
    expect(detectPlatform("darwin")).toBe("macos")
  })
  it("maps win32 to windows", () => {
    expect(detectPlatform("win32")).toBe("windows")
  })
  it("maps linux to linux", () => {
    expect(detectPlatform("linux")).toBe("linux")
  })
  it("collapses UNIX-likes into linux", () => {
    for (const p of ["freebsd", "openbsd", "netbsd", "sunos", "aix"]) {
      expect(detectPlatform(p)).toBe("linux")
    }
  })
  it("defaults unknown to linux", () => {
    expect(detectPlatform("haiku-os")).toBe("linux")
  })
})

describe("normalizePlatform", () => {
  it("returns null for undefined / empty / whitespace", () => {
    expect(normalizePlatform(undefined)).toBeNull()
    expect(normalizePlatform("")).toBeNull()
    expect(normalizePlatform("   ")).toBeNull()
  })
  it("recognizes the bypass aliases", () => {
    for (const v of ["all", "any", "*", "ALL", " Any "]) {
      expect(normalizePlatform(v)).toBe(PLATFORM_ALL)
    }
  })
  it("recognizes macos aliases", () => {
    for (const v of ["macos", "mac", "osx", "darwin", "apple", "  Darwin "]) {
      expect(normalizePlatform(v)).toBe("macos")
    }
  })
  it("recognizes windows aliases", () => {
    for (const v of ["windows", "win", "win32", "win64", "WINDOWS"]) {
      expect(normalizePlatform(v)).toBe("windows")
    }
  })
  it("recognizes linux / unix-like aliases", () => {
    for (const v of ["linux", "unix", "posix", "bsd", "freebsd", "solaris", "illumos"]) {
      expect(normalizePlatform(v)).toBe("linux")
    }
  })
  it("returns null for unrecognized tokens", () => {
    expect(normalizePlatform("plan9")).toBeNull()
  })
})

describe("platformAllowed", () => {
  it("treats absent / empty whitelist as all platforms", () => {
    expect(platformAllowed(undefined, "macos")).toBe(true)
    expect(platformAllowed([], "windows")).toBe(true)
  })
  it("admits when the effective platform is listed", () => {
    expect(platformAllowed(["macos"], "macos")).toBe(true)
    expect(platformAllowed(["linux", "windows"], "windows")).toBe(true)
  })
  it("rejects when the effective platform is not listed", () => {
    expect(platformAllowed(["macos"], "linux")).toBe(false)
    expect(platformAllowed(["windows"], "macos")).toBe(false)
  })
  it("the bypass effective value matches any whitelist", () => {
    expect(platformAllowed(["macos"], PLATFORM_ALL)).toBe(true)
    expect(platformAllowed(["windows"], PLATFORM_ALL)).toBe(true)
  })
  it("normalizes whitelist entries defensively", () => {
    expect(platformAllowed(["darwin"], "macos")).toBe(true)
    expect(platformAllowed(["unix"], "linux")).toBe(true)
  })
})

describe("KNOWN_PLATFORMS", () => {
  it("contains exactly the three canonical buckets", () => {
    expect([...KNOWN_PLATFORMS].sort()).toEqual(["linux", "macos", "windows"])
  })
})

/**
 * Unit tests for {@link TscSpawnProvider}: extension matching, interface contract.
 * The real spawn path is covered by the integration test (tsc-provider.integration.test.ts).
 */
import { describe, expect, it } from "bun:test"

import { TscSpawnProvider } from "./tsc-provider.ts"

const provider = new TscSpawnProvider("/usr/bin/tsc", "/tmp/testroot")

describe("TscSpawnProvider", () => {
  describe("handles", () => {
    it("handles .ts files", () => {
      expect(provider.handles("src/file.ts")).toBe(true)
      expect(provider.handles("file.ts")).toBe(true)
    })

    it("handles .tsx files", () => {
      expect(provider.handles("Component.tsx")).toBe(true)
    })

    it("handles .mts and .cts files", () => {
      expect(provider.handles("config.mts")).toBe(true)
      expect(provider.handles("config.cts")).toBe(true)
    })

    it("handles .js, .jsx, .mjs, .cjs files", () => {
      expect(provider.handles("file.js")).toBe(true)
      expect(provider.handles("Comp.jsx")).toBe(true)
      expect(provider.handles("mod.mjs")).toBe(true)
      expect(provider.handles("mod.cjs")).toBe(true)
    })

    it("rejects non-TS/JS files", () => {
      expect(provider.handles("styles.css")).toBe(false)
      expect(provider.handles("file.swift")).toBe(false)
      expect(provider.handles("file.py")).toBe(false)
      expect(provider.handles("README.md")).toBe(false)
    })
  })

  describe("interface contract", () => {
    it("has correct id and kind", () => {
      expect(provider.id).toBe("tsc")
      expect(provider.kind).toBe("type")
    })

    it("dispose is a no-op that does not throw", () => {
      expect(() => provider.dispose()).not.toThrow()
    })

    it("isActive returns false (not persistent)", () => {
      expect(provider.isActive?.()).toBe(false)
    })
  })
})

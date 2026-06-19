import { describe, expect, it } from "bun:test"

import { TscDirectProvider } from "./tsc-direct-provider.ts"

const provider = new TscDirectProvider("/usr/bin/tsc", "/tmp/test")

describe("TscDirectProvider", () => {
  describe("handles", () => {
    it("handles .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs", () => {
      expect(provider.handles("f.ts")).toBe(true)
      expect(provider.handles("f.tsx")).toBe(true)
      expect(provider.handles("f.mts")).toBe(true)
      expect(provider.handles("f.cts")).toBe(true)
      expect(provider.handles("f.js")).toBe(true)
      expect(provider.handles("f.jsx")).toBe(true)
      expect(provider.handles("f.mjs")).toBe(true)
      expect(provider.handles("f.cjs")).toBe(true)
    })

    it("rejects non-TS/JS files", () => {
      expect(provider.handles("f.swift")).toBe(false)
      expect(provider.handles("f.css")).toBe(false)
      expect(provider.handles("f.py")).toBe(false)
    })
  })

  it("has correct id and kind", () => {
    expect(provider.id).toBe("tsc-direct")
    expect(provider.kind).toBe("type")
  })

  it("dispose is a no-op", () => {
    expect(() => provider.dispose()).not.toThrow()
  })

  it("isActive returns false", () => {
    expect(provider.isActive()).toBe(false)
  })
})

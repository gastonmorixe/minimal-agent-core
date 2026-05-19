import { describe, it, expect } from "bun:test"
import { formatArmedFooter, isArmedFooterActive } from "./armed-footer.ts"

const ANSI = /\x1b\[[\d;]*m/g
const strip = (s: string) => s.replace(ANSI, "")

describe("formatArmedFooter", () => {
  it("returns null when expired", () => {
    expect(formatArmedFooter({ source: "idle-confirm", expiresAt: 1000, now: 1000 })).toBeNull()
    expect(formatArmedFooter({ source: "idle-confirm", expiresAt: 1000, now: 9999 })).toBeNull()
  })

  it("countdown rounds UP so a fresh 10s window reads as 10s", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 10_000,
      now: 0,
    })!
    expect(strip(line)).toContain("within 10s to quit")
  })

  it("countdown at 9.5s remaining still reads as 10s (ceil)", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 9_500,
      now: 0,
    })!
    expect(strip(line)).toContain("within 10s to quit")
  })

  it("countdown at 8.1s remaining reads as 9s", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 8_100,
      now: 0,
    })!
    expect(strip(line)).toContain("within 9s to quit")
  })

  it("countdown floor of 1s — never shows 0s before expiry", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 1,
      now: 0,
    })!
    expect(strip(line)).toContain("within 1s to quit")
  })

  it("idle-confirm source uses 'ready to quit' heading", () => {
    const line = strip(formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!)
    expect(line).toContain("ready to quit")
    expect(line).not.toContain("aborted")
  })

  it("post-abort source uses 'aborted' badge", () => {
    const line = strip(formatArmedFooter({ source: "post-abort", expiresAt: 10_000, now: 0 })!)
    expect(line).toContain("aborted")
    expect(line).toContain("⊘")
    expect(line).not.toContain("ready to quit")
  })

  it("mentions Esc and 'type to cancel'", () => {
    const line = strip(formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!)
    expect(line).toContain("Esc")
    expect(line).toContain("cancel")
  })

  it("is styled with SGR escapes", () => {
    const line = formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!
    expect(line).toMatch(ANSI)
  })

  it("starts with two leading spaces (matches startup chrome indent)", () => {
    const line = formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!
    expect(line.startsWith("  ")).toBe(true)
  })
})

describe("isArmedFooterActive", () => {
  it("returns true while expiresAt is in the future", () => {
    expect(isArmedFooterActive(10_000, 0)).toBe(true)
    expect(isArmedFooterActive(10_000, 9_999)).toBe(true)
  })
  it("returns false at expiresAt and after", () => {
    expect(isArmedFooterActive(10_000, 10_000)).toBe(false)
    expect(isArmedFooterActive(10_000, 11_000)).toBe(false)
  })
})

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
    expect(strip(line)).toContain("· 10s ·")
  })

  it("countdown at 9.5s remaining still reads as 10s (ceil)", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 9_500,
      now: 0,
    })!
    expect(strip(line)).toContain("· 10s ·")
  })

  it("countdown at 8.1s remaining reads as 9s", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 8_100,
      now: 0,
    })!
    expect(strip(line)).toContain("· 9s ·")
  })

  it("countdown floor of 1s — never shows 0s before expiry", () => {
    const line = formatArmedFooter({
      source: "idle-confirm",
      expiresAt: 1,
      now: 0,
    })!
    expect(strip(line)).toContain("· 1s ·")
  })

  it("idle-confirm source uses 'Quit?' heading, 'confirm' verb, 'esc cancel' off-ramp", () => {
    const line = strip(formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!)
    expect(line).toContain("Quit?")
    expect(line).toContain("⌃C")
    expect(line).toContain("confirm")
    expect(line).toContain("esc cancel")
    // None of the post-abort markers leak into the idle case.
    expect(line).not.toContain("Aborted")
    expect(line).not.toContain("✘")
    expect(line).not.toContain("esc resume")
    // And no relic of the previous design.
    expect(line).not.toContain("ready to quit")
    expect(line).not.toContain("⌨")
    expect(line).not.toContain("⊘")
    expect(line).not.toContain("Esc or type to cancel")
  })

  it("post-abort source uses '✘ Aborted.' badge, 'to quit' verb, 'esc resume' off-ramp", () => {
    const line = strip(formatArmedFooter({ source: "post-abort", expiresAt: 10_000, now: 0 })!)
    expect(line).toContain("✘")
    expect(line).toContain("Aborted.")
    expect(line).toContain("⌃C")
    expect(line).toContain("to quit")
    expect(line).toContain("esc resume")
    // None of the idle-confirm markers leak into the post-abort case.
    expect(line).not.toContain("Quit?")
    expect(line).not.toContain("esc cancel")
    // And no relic of the previous design.
    expect(line).not.toContain("⊘")
    expect(line).not.toContain("ready to quit")
  })

  it("post-abort badge wears bold-red foreground (not dim-red)", () => {
    // The earlier `c.dimRed("⊘")` (`\x1b[2;31m`) was visually invisible
    // on antialiased fonts. The new `c.boldRed("✘")` is `\x1b[1;31m` and
    // pairs heavy strokes with high contrast.
    const line = formatArmedFooter({ source: "post-abort", expiresAt: 10_000, now: 0 })!
    expect(line).toContain("\x1b[1;31m✘")
    // The dim-red prefix MUST NOT appear immediately before the X.
    expect(line).not.toContain("\x1b[2;31m✘")
    expect(line).not.toContain("\x1b[2;31m⊘")
  })

  it("renders the macOS Control symbol ⌃ (U+2303) — BMP-narrow, no emoji risk", () => {
    // The Mac-native Control glyph is what users see in every menu item.
    // It's BMP and `Emoji_Presentation=No`, so it never auto-promotes to
    // a wide color emoji (unlike `⌨` U+2328 which did, per the design
    // notes).
    const idle = strip(formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!)
    const post = strip(formatArmedFooter({ source: "post-abort", expiresAt: 10_000, now: 0 })!)
    expect(idle).toContain("⌃C")
    expect(post).toContain("⌃C")
    expect(idle).not.toContain("Ctrl+C")
    expect(post).not.toContain("Ctrl+C")
  })

  it("is styled with SGR escapes", () => {
    const line = formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!
    expect(line).toMatch(ANSI)
  })

  it("starts with two leading spaces (matches startup chrome indent)", () => {
    const line = formatArmedFooter({ source: "idle-confirm", expiresAt: 10_000, now: 0 })!
    expect(line.startsWith("  ")).toBe(true)
  })

  it("idle layout reads `Quit?  ⌃C confirm · Ns · esc cancel` (order preserved)", () => {
    const line = strip(formatArmedFooter({ source: "idle-confirm", expiresAt: 7_000, now: 0 })!)
    // Hierarchy order is load-bearing: anchor → action → time → off-ramp.
    const iQuit = line.indexOf("Quit?")
    const iAction = line.indexOf("⌃C confirm")
    const iTime = line.indexOf("7s")
    const iOff = line.indexOf("esc cancel")
    expect(iQuit).toBeGreaterThanOrEqual(0)
    expect(iAction).toBeGreaterThan(iQuit)
    expect(iTime).toBeGreaterThan(iAction)
    expect(iOff).toBeGreaterThan(iTime)
  })

  it("post-abort layout reads `✘ Aborted.  ⌃C to quit · Ns · esc resume` (order preserved)", () => {
    const line = strip(formatArmedFooter({ source: "post-abort", expiresAt: 4_000, now: 0 })!)
    const iBadge = line.indexOf("✘")
    const iLabel = line.indexOf("Aborted.")
    const iAction = line.indexOf("⌃C to quit")
    const iTime = line.indexOf("4s")
    const iOff = line.indexOf("esc resume")
    expect(iBadge).toBeGreaterThanOrEqual(0)
    expect(iLabel).toBeGreaterThan(iBadge)
    expect(iAction).toBeGreaterThan(iLabel)
    expect(iTime).toBeGreaterThan(iAction)
    expect(iOff).toBeGreaterThan(iTime)
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

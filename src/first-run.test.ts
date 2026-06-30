/**
 * Tests for the first-run welcome card + cold-start detection.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { buildFirstRunCard, isColdStart, maybeShowFirstRunWelcome } from "./host/ui/chrome/first-run.ts"

/** Strip ANSI SGR sequences so assertions read against plain text. */
function plain(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI.
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

describe("buildFirstRunCard", () => {
  it("renders a rounded card with numbered steps + closer", () => {
    const card = plain(
      buildFirstRunCard({
        steps: [{ label: "sign in" }, { label: "fetch mdstream" }, { label: "fetch plugins" }],
      }),
    )
    expect(card).toContain("minimal-agent")
    expect(card).toContain("first run")
    // Opener + closer corners.
    expect(card).toContain("╭")
    expect(card).toContain("╰")
    // Numbered steps in order.
    expect(card).toContain("1  sign in")
    expect(card).toContain("2  fetch mdstream")
    expect(card).toContain("3  fetch plugins")
    // Closer mentions the storage location.
    expect(card).toContain("~/.minimal-agent")
  })

  it("honors a custom homeLabel", () => {
    const card = plain(buildFirstRunCard({ steps: [{ label: "x" }], homeLabel: "/tmp/ma" }))
    expect(card).toContain("/tmp/ma")
  })
})

describe("isColdStart", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-firstrun-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns false when the home dir exists", () => {
    expect(isColdStart(dir)).toBe(false)
  })

  it("returns true when the home dir is absent", () => {
    expect(isColdStart(join(dir, "does-not-exist"))).toBe(true)
  })
})

describe("maybeShowFirstRunWelcome", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-firstrun-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("writes the card on an interactive cold start", () => {
    let out = ""
    const shown = maybeShowFirstRunWelcome({
      isInteractive: true,
      homeDir: join(dir, "absent"),
      steps: [{ label: "sign in" }],
      write: (s) => {
        out += s
      },
    })
    expect(shown).toBe(true)
    expect(plain(out)).toContain("first run")
  })

  it("stays silent when non-interactive", () => {
    let out = ""
    const shown = maybeShowFirstRunWelcome({
      isInteractive: false,
      homeDir: join(dir, "absent"),
      steps: [{ label: "sign in" }],
      write: (s) => {
        out += s
      },
    })
    expect(shown).toBe(false)
    expect(out).toBe("")
  })

  it("stays silent when the home dir already exists (not cold)", () => {
    let out = ""
    const shown = maybeShowFirstRunWelcome({
      isInteractive: true,
      homeDir: dir, // exists
      steps: [{ label: "sign in" }],
      write: (s) => {
        out += s
      },
    })
    expect(shown).toBe(false)
    expect(out).toBe("")
  })
})

/**
 * Tests for {@link buildReadyBanner}.
 *
 * Pure string builder : these tests pin the user-visible invariants
 * that drove the May 2026 refactor (moving the banner from inside
 * `runRepl`/`runReplLiveArea` to a single direct-stdout write at the
 * top of the scrollback phase in `src/index.ts`):
 *
 *   - "status" + "ready" keywords appear together on the first row
 *   - hint row carries enter/shift+enter/ctrl+c, joined by `·`
 *   - `shift+tab cycle mode` tail appears IFF a ModeManager with modes
 *     is supplied
 *   - trailing `\n\n` is load-bearing (one blank row of breathing room
 *     above whatever follows)
 *   - leading `\n` separates the banner from the startup tree closer
 *     (which ends on a `╰` row with no trailing blank of its own)
 */
import { describe, expect, it } from "bun:test"

import type { ModeManager } from "../../../modes/modes.ts"

import { buildReadyBanner } from "./ready-banner.ts"

const ANSI = /\x1b\[[\d;]*m/g
const strip = (s: string) => s.replace(ANSI, "")

/** Minimal ModeManager stub : we only call `hasModes()`. */
function stubModes(has: boolean): ModeManager {
  return { hasModes: () => has } as unknown as ModeManager
}

describe("buildReadyBanner", () => {
  it("contains 'status' and 'ready' on the first content row", () => {
    const out = strip(buildReadyBanner(null))
    const lines = out.split("\n")
    // [0]='' (leading \n), [1]='  status ready', [2]='  enter send …'
    expect(lines[1]).toContain("status")
    expect(lines[1]).toContain("ready")
  })

  it("hint row carries enter/shift+enter/ctrl+c separated by ·", () => {
    const out = strip(buildReadyBanner(null))
    const hint = out.split("\n").find((l) => l.includes("enter send"))
    if (!hint) throw new Error("hint row missing")
    expect(hint).toContain("enter")
    expect(hint).toContain("send")
    expect(hint).toContain("shift+enter")
    expect(hint).toContain("new line")
    expect(hint).toContain("ctrl+c")
    expect(hint).toContain("quit")
    // Three `·` between the four chunks when modes are absent.
    expect((hint.match(/·/g) ?? []).length).toBe(2)
  })

  it("omits 'shift+tab cycle mode' when no mode manager", () => {
    const out = strip(buildReadyBanner(null))
    expect(out).not.toContain("shift+tab")
    expect(out).not.toContain("cycle mode")
  })

  it("omits 'shift+tab cycle mode' when mode manager has no modes", () => {
    const out = strip(buildReadyBanner(stubModes(false)))
    expect(out).not.toContain("shift+tab")
  })

  it("appends 'shift+tab cycle mode' when mode manager has modes", () => {
    const out = strip(buildReadyBanner(stubModes(true)))
    const hint = out.split("\n").find((l) => l.includes("ctrl+c"))
    if (!hint) throw new Error("hint row missing")
    expect(hint).toContain("shift+tab")
    expect(hint).toContain("cycle mode")
    // Four `·` between the five chunks when modes are present.
    expect((hint.match(/·/g) ?? []).length).toBe(3)
  })

  it("begins with a single leading newline (separates from startup tree closer)", () => {
    const out = buildReadyBanner(null)
    expect(out.startsWith("\n")).toBe(true)
    expect(out.startsWith("\n\n")).toBe(false)
  })

  it("ends with exactly two trailing newlines (one blank row of breathing room)", () => {
    const out = buildReadyBanner(null)
    expect(out.endsWith("\n\n")).toBe(true)
    expect(out.endsWith("\n\n\n")).toBe(false)
  })

  it("ANSI is non-empty (banner is colored)", () => {
    const raw = buildReadyBanner(null)
    expect(raw).toMatch(ANSI)
  })
})

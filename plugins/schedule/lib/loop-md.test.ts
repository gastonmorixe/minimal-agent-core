/**
 * Tests for loop.md resolution.
 *
 * @module schedule/lib/loop-md.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { BUILTIN_MAINTENANCE, resolveLoopPrompt } from "./loop-md.ts"

let cwd: string
let home: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ma-loopmd-cwd-"))
  home = mkdtempSync(join(tmpdir(), "ma-loopmd-home-"))
})
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function writeLoop(base: string, content: string): void {
  mkdirSync(join(base, ".claude"), { recursive: true })
  writeFileSync(join(base, ".claude", "loop.md"), content)
}

describe("resolveLoopPrompt", () => {
  it("falls back to the built-in maintenance prompt", () => {
    expect(resolveLoopPrompt(cwd, home)).toBe(BUILTIN_MAINTENANCE)
  })

  it("prefers the project .claude/loop.md", () => {
    writeLoop(cwd, "PROJECT loop")
    writeLoop(home, "HOME loop")
    expect(resolveLoopPrompt(cwd, home)).toBe("PROJECT loop")
  })

  it("uses the home ~/.claude/loop.md when the project has none", () => {
    writeLoop(home, "HOME loop")
    expect(resolveLoopPrompt(cwd, home)).toBe("HOME loop")
  })

  it("ignores an empty loop.md (falls through)", () => {
    writeLoop(cwd, "   \n  ")
    expect(resolveLoopPrompt(cwd, home)).toBe(BUILTIN_MAINTENANCE)
  })

  it("caps content at 25,000 bytes", () => {
    writeLoop(cwd, "x".repeat(30_000))
    expect(resolveLoopPrompt(cwd, home).length).toBe(25_000)
  })
})

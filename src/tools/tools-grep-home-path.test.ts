/**
 * Grep on one file under the home dir, outside the cwd.
 *
 * `relativizePath` gives `~/...` for that file. rg runs with no shell, so a
 * `~/...` argument fails with "No such file or directory" (research
 * 2026-11-17-session-1df63fe1-tool-input-loss, cause 2). Grep must give rg
 * the absolute path and keep `~/...` only for display.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { executeTool as rawExecuteTool } from "./tools.ts"

// Text from the real text plugins, so the error text is not empty.
const TEXT = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
const executeTool = (name: string, input: Record<string, unknown>) =>
  rawExecuteTool(name, input, { text: TEXT })

let dir: string
let file: string
let tilde: string

beforeAll(() => {
  dir = mkdtempSync(join(homedir(), ".ma-grep-home-test-"))
  file = join(dir, "sample.txt")
  writeFileSync(file, "alpha\nneedle here\nomega\n")
  tilde = `~/${relative(homedir(), file)}`
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

// The cwd must not contain the home dir file, or the path is cwd-relative.
const outsideCwd = !join(homedir(), ".x").startsWith(`${process.cwd()}/`)

describe.skipIf(!Bun.which("rg") || !outsideCwd)("Grep on a file under home, outside cwd", () => {
  it("content mode finds the match (no ~ given to rg)", async () => {
    const r = await executeTool("Grep", { pattern: "needle", path: file, output_mode: "content" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("2:needle here")
  })

  it("files_with_matches shows the ~/ display path", async () => {
    const r = await executeTool("Grep", { pattern: "needle", path: file })
    expect(r.is_error).toBeFalsy()
    expect(r.content.trim()).toBe(tilde)
  })

  it("count mode works", async () => {
    const r = await executeTool("Grep", { pattern: "needle", path: file, output_mode: "count" })
    expect(r.is_error).toBeFalsy()
    expect(r.content.trim()).toBe("1")
  })

  it.skipIf(!TEXT)("a missing file reports the ~/ display path", async () => {
    const missing = join(dir, "missing.txt")
    const r = await executeTool("Grep", { pattern: "needle", path: missing, output_mode: "content" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain(`~/${relative(homedir(), missing)}`)
    expect(r.content).not.toContain(missing)
  })
})

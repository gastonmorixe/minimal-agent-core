/**
 * Regression tests for the `cd` interceptor inside the Bash tool.
 *
 * Background
 * ----------
 * `executeTool("Bash", { command })` short-circuits *bare* `cd <path>` calls
 * in-process so the tool's persistent `bashCwd` is updated (shell state would
 * otherwise be lost between calls because each `bash -c` runs in a fresh
 * subshell). The original implementation used `^cd\s+(.+)$`, which is greedy
 * and unaware of shell operators — so `cd /tmp && ls` was parsed as
 * `cd "/tmp && ls"`, the path didn't exist, and the call failed *without ever
 * invoking bash*. The error message even echoed the entire pipeline as the
 * "directory", which is the diagnostic tell.
 *
 * These tests pin the contract:
 *   1. Bare `cd <path>` still updates `bashCwd` and returns empty content.
 *   2. Bare `cd <bogus>` still returns the synthetic "no such directory".
 *   3. Anything containing shell operators (`&&`, `||`, `;`, `|`, `&`,
 *      redirections, command substitution) is delegated to `bash -c` so the
 *      operators actually take effect — even if the command starts with `cd`.
 *   4. Quoted paths and trailing whitespace are tolerated.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeTool } from "./tools.ts"

let dir: string
let sub: string

beforeAll(() => {
  // realpathSync to dodge macOS /var -> /private/var symlink (pwd in the
  // subshell resolves the symlink, mkdtemp returns the unresolved path).
  dir = realpathSync(mkdtempSync(join(tmpdir(), "bash-cd-")))
  sub = join(dir, "child")
  mkdirSync(sub)
  writeFileSync(join(sub, "marker.txt"), "hello\n")
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("Bash tool — cd interceptor", () => {
  it("bare `cd <path>` updates persistent cwd (next call sees new dir)", async () => {
    const r1 = await executeTool("Bash", { command: `cd ${dir}` })
    expect(r1.is_error).toBeFalsy()
    expect(r1.content).toBe("")

    const r2 = await executeTool("Bash", { command: "pwd" })
    expect(r2.is_error).toBeFalsy()
    expect(r2.content?.trim()).toBe(dir)
  })

  it("bare `cd <bogus>` returns synthetic no-such-directory error", async () => {
    const bogus = join(dir, "definitely-not-here-xyz")
    const r = await executeTool("Bash", { command: `cd ${bogus}` })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("no such directory")
  })

  it("`cd <path> && <cmd>` runs the command in <path> via bash -c (regression)", async () => {
    // Reset cwd to dir first so we can prove the chained cd actually moved.
    await executeTool("Bash", { command: `cd ${dir}` })

    const r = await executeTool("Bash", {
      command: `cd ${sub} && cat marker.txt`,
    })
    expect(r.is_error).toBeFalsy()
    // The synthetic interceptor would have echoed the whole tail as a path.
    expect(r.content).not.toContain("no such directory")
    expect(r.content?.trim()).toBe("hello")
  })

  it("`cd <path>; <cmd>` is delegated to bash -c", async () => {
    await executeTool("Bash", { command: `cd ${dir}` })
    const r = await executeTool("Bash", {
      command: `cd ${sub}; cat marker.txt`,
    })
    expect(r.is_error).toBeFalsy()
    expect(r.content?.trim()).toBe("hello")
  })

  it("`cd <path> | <cmd>` is delegated to bash -c (no false intercept)", async () => {
    const r = await executeTool("Bash", {
      command: `cd ${sub} | true`,
    })
    // The point is that we did NOT synthesize an error from the interceptor.
    expect(r.content ?? "").not.toContain("no such directory")
  })

  it("quoted bare `cd '<path with space>'` still updates cwd", async () => {
    const spaced = join(dir, "with space")
    require("node:fs").mkdirSync(spaced)
    const r1 = await executeTool("Bash", { command: `cd '${spaced}'` })
    expect(r1.is_error).toBeFalsy()
    const r2 = await executeTool("Bash", { command: "pwd" })
    expect(r2.content?.trim()).toBe(spaced)
  })

  it("trailing whitespace on bare `cd` is tolerated", async () => {
    const r1 = await executeTool("Bash", { command: `cd ${dir}   ` })
    expect(r1.is_error).toBeFalsy()
    const r2 = await executeTool("Bash", { command: "pwd" })
    expect(r2.content?.trim()).toBe(dir)
  })

  it("chained command does NOT mutate persistent cwd (bash -c subshell)", async () => {
    await executeTool("Bash", { command: `cd ${dir}` })
    await executeTool("Bash", { command: `cd ${sub} && true` })
    const r = await executeTool("Bash", { command: "pwd" })
    // Persistent cwd unchanged — the cd happened inside the bash -c subshell.
    expect(r.content?.trim()).toBe(dir)
  })
})

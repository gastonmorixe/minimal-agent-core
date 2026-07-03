/**
 * Integration test: `executeTool` with file-lock wiring.
 *
 * Asserts the Edit/Write paths actually:
 *   1. acquire a lock around the read-modify-write,
 *   2. release the lock so the post-state directory is clean,
 *   3. surface a useful error when the lock is held by someone else,
 *   4. obey the env opt-out (`MINIMAL_AGENT_FILE_LOCK_DISABLED=1`),
 *   5. obey the config opt-out (`plugins["file-lock"].enabled = false`).
 *
 * The lock-library tests in `src/file-lock.test.ts` cover the protocol in
 * isolation; this file covers only the integration seam in `tools.ts`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  buildHolder,
  lockPathFor,
  _resetForTests as resetLockLib,
  serializeHolder,
} from "../infra/file-lock.ts"

import { _resetFileLockConfigForTests, executeTool } from "./tools.ts"

let dir: string
let savedConfigEnv: string | undefined
let savedDisabledEnv: string | undefined
let configPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tools-flock-"))
  configPath = join(dir, "config.jsonc")
  savedConfigEnv = process.env.MINIMAL_AGENT_CONFIG
  savedDisabledEnv = process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  // Use MINIMAL_AGENT_CONFIG (not HOME) : `os.homedir()` reads from getpwuid
  // on macOS, not $HOME, so HOME-override would leak to the real
  // ~/.minimal-agent/config.jsonc.
  process.env.MINIMAL_AGENT_CONFIG = configPath
  delete process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  _resetFileLockConfigForTests()
  resetLockLib()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (savedConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = savedConfigEnv
  if (savedDisabledEnv === undefined) delete process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED
  else process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED = savedDisabledEnv
  _resetFileLockConfigForTests()
  resetLockLib()
})

describe("Edit + file-lock wiring", () => {
  it("Edit succeeds and leaves no .locked sibling behind", async () => {
    const file = join(dir, "edit-ok.txt")
    writeFileSync(file, "alpha\n")
    const r = await executeTool("Edit", {
      file_path: file,
      old_string: "alpha",
      new_string: "ALPHA",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(file, "utf-8")).toBe("ALPHA\n")
    expect(existsSync(lockPathFor(file))).toBe(false)
  })

  it("Edit returns is_error with holder details when another process holds the lock", async () => {
    const file = join(dir, "edit-locked.txt")
    writeFileSync(file, "alpha\n")
    // Pre-write a lock file claiming a live PID on our host. Edit should
    // time out fast (we set a tiny timeout via a fake config).
    writeConfig({
      plugins: {
        "file-lock": {
          enabled: true,
          timeoutMs: 80,
          staleAfterMs: 60_000_000, // never break by time
        },
      },
    })
    const otherHolder = buildHolder({
      sessionId: "peer-session",
      tool: "Edit",
      filePath: file,
    })
    writeFileSync(lockPathFor(file), serializeHolder(otherHolder))

    const r = await executeTool("Edit", {
      file_path: file,
      old_string: "alpha",
      new_string: "ALPHA",
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Edit error:")
    expect(r.content).toContain("locked")
    expect(r.content).toContain("peer-session")
    // File untouched (the other peer's lock prevented us).
    expect(readFileSync(file, "utf-8")).toBe("alpha\n")
    // Other peer's lock still there : we must NOT have smashed it.
    expect(existsSync(lockPathFor(file))).toBe(true)
  })

  it("Edit breaks a stale lock (corrupt content) and proceeds", async () => {
    const file = join(dir, "edit-corrupt.txt")
    writeFileSync(file, "alpha\n")
    writeFileSync(lockPathFor(file), "garbage-not-json")
    const r = await executeTool("Edit", {
      file_path: file,
      old_string: "alpha",
      new_string: "ALPHA",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(file, "utf-8")).toBe("ALPHA\n")
    expect(existsSync(lockPathFor(file))).toBe(false)
  })
})

describe("Write + file-lock wiring", () => {
  it("Write succeeds and leaves no .locked sibling behind", async () => {
    const file = join(dir, "write-ok.txt")
    const r = await executeTool("Write", { file_path: file, content: "hello\n" })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(file, "utf-8")).toBe("hello\n")
    expect(existsSync(lockPathFor(file))).toBe(false)
  })

  it("Write under a not-yet-created subdirectory still locks safely", async () => {
    const file = join(dir, "freshdir", "deep", "w.txt")
    const r = await executeTool("Write", { file_path: file, content: "x\n" })
    expect(r.is_error).toBeFalsy()
    expect(existsSync(file)).toBe(true)
    expect(existsSync(lockPathFor(file))).toBe(false)
  })
})

describe("opt-out paths", () => {
  it("env MINIMAL_AGENT_FILE_LOCK_DISABLED=1 skips locking entirely", async () => {
    const file = join(dir, "disabled-env.txt")
    writeFileSync(file, "x\n")
    // Pre-write a fresh, live-pid-on-our-host lock that would normally
    // make us wait + time out. With locking disabled, Edit must succeed
    // without touching the lock at all.
    writeConfig({
      plugins: { "file-lock": { enabled: true, timeoutMs: 5 } },
    })
    const otherHolder = buildHolder({
      sessionId: "peer",
      tool: "Edit",
      filePath: file,
    })
    writeFileSync(lockPathFor(file), serializeHolder(otherHolder))
    process.env.MINIMAL_AGENT_FILE_LOCK_DISABLED = "1"
    _resetFileLockConfigForTests()

    const r = await executeTool("Edit", {
      file_path: file,
      old_string: "x",
      new_string: "X",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(file, "utf-8")).toBe("X\n")
    // The peer's lock is left untouched : we didn't acquire/release it.
    expect(existsSync(lockPathFor(file))).toBe(true)
  })

  it("config plugins['file-lock'].enabled=false skips locking", async () => {
    const file = join(dir, "disabled-cfg.txt")
    writeFileSync(file, "x\n")
    writeConfig({
      plugins: { "file-lock": { enabled: false } },
    })
    const otherHolder = buildHolder({
      sessionId: "peer",
      tool: "Edit",
      filePath: file,
    })
    writeFileSync(lockPathFor(file), serializeHolder(otherHolder))
    _resetFileLockConfigForTests()

    const r = await executeTool("Edit", {
      file_path: file,
      old_string: "x",
      new_string: "X",
    })
    expect(r.is_error).toBeFalsy()
    expect(readFileSync(file, "utf-8")).toBe("X\n")
  })
})

describe("error path: missing file_path", () => {
  it("falls through to executor's own validation when input lacks file_path", async () => {
    const r = await executeTool("Edit", {
      old_string: "x",
      new_string: "y",
    } as unknown as Record<string, unknown>)
    expect(r.is_error).toBe(true)
    // Whatever the executor's own error text is : important: NOT a lock error.
    expect(r.content).not.toContain("locked")
    expect(r.content).not.toContain("lock acquire")
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write the config file at the path pointed to by `MINIMAL_AGENT_CONFIG`. */
function writeConfig(body: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(body, null, 2))
}

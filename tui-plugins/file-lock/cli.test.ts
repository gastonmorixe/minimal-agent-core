/**
 * Tests for the file-lock CLI.
 *
 * `runCli(argv)` is exercised directly — it returns `{exitCode, stdout, stderr}`
 * without touching the real process, so we can assert each subcommand's
 * shape without spawning subprocesses. Argument-parsing is also unit-tested
 * via `parseArgs(argv)`.
 *
 * Each test creates a tmp `MINIMAL_AGENT_CONFIG` pointing into a tmpdir
 * so the stale-threshold lookup doesn't accidentally hit the user's real
 * config. CWD is set to the tmp dir for the duration of the test so
 * `list` / `clear-stale` without `PATH` argument behave deterministically.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { buildHolder, lockPathFor, serializeHolder } from "../../src/file-lock.ts"

import { parseArgs, runCli } from "./cli.ts"

let dir: string
let savedCwd: string
let savedConfigEnv: string | undefined
let configFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-cli-"))
  savedCwd = process.cwd()
  process.chdir(dir)
  configFile = join(dir, "config.jsonc")
  savedConfigEnv = process.env.MINIMAL_AGENT_CONFIG
  process.env.MINIMAL_AGENT_CONFIG = configFile
})

afterEach(() => {
  process.chdir(savedCwd)
  if (savedConfigEnv === undefined) delete process.env.MINIMAL_AGENT_CONFIG
  else process.env.MINIMAL_AGENT_CONFIG = savedConfigEnv
  rmSync(dir, { recursive: true, force: true })
})

function plantHolder(filePath: string, over: Partial<Parameters<typeof buildHolder>[0]> = {}) {
  const holder = buildHolder({
    sessionId: "owner",
    tool: "Edit",
    filePath,
    ...over,
  })
  writeFileSync(lockPathFor(filePath), serializeHolder(holder))
  return holder
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("treats no args as no command + no help", () => {
    const a = parseArgs([])
    expect(a.cmd).toBe("")
    expect(a.positional).toEqual([])
    expect(a.json).toBe(false)
    expect(a.help).toBe(false)
  })

  it("captures --json flag anywhere in argv", () => {
    expect(parseArgs(["list", "--json"]).json).toBe(true)
    expect(parseArgs(["--json", "list"]).json).toBe(true)
    expect(parseArgs(["list", "--json", "/some/path"]).json).toBe(true)
  })

  it("captures -h / --help", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--help"]).help).toBe(true)
  })

  it("separates positional args from flags", () => {
    const a = parseArgs(["inspect", "/abs/path.ts", "--json"])
    expect(a.cmd).toBe("inspect")
    expect(a.positional).toEqual(["/abs/path.ts"])
    expect(a.json).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runCli
// ---------------------------------------------------------------------------

describe("runCli — usage / help", () => {
  it("no args returns exit 2 + usage", () => {
    const r = runCli([])
    expect(r.exitCode).toBe(2)
    expect(r.stdout).toMatch(/Usage:/)
  })

  it("--help returns exit 0 + usage on stdout", () => {
    const r = runCli(["--help"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:/)
  })

  it("unknown command returns exit 2 with usage", () => {
    const r = runCli(["frobnicate"])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/unknown command/)
  })
})

describe("runCli — list", () => {
  it("empty cwd: no locks", () => {
    const r = runCli(["list"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/No locks/)
  })

  it("with lock: includes filePath in stdout", () => {
    const f = join(dir, "a.txt")
    plantHolder(f)
    const r = runCli(["list"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(f)
  })

  it("--json returns parseable JSON", () => {
    const f = join(dir, "b.txt")
    plantHolder(f)
    const r = runCli(["list", "--json"])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { count: number; locks: unknown[] }
    expect(parsed.count).toBe(1)
  })

  it("list <PATH> walks the given directory", () => {
    const sub = join(dir, "sub")
    require("node:fs").mkdirSync(sub, { recursive: true })
    const f = join(sub, "c.txt")
    plantHolder(f)
    const r = runCli(["list", sub])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain(f)
  })
})

describe("runCli — inspect", () => {
  it("requires a positional FILE", () => {
    const r = runCli(["inspect"])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/FILE.*required/)
  })

  it("rejects relative FILE", () => {
    const r = runCli(["inspect", "rel.txt"])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/absolute/)
  })

  it("absent lock: benign message, exit 0", () => {
    const f = join(dir, "absent.txt")
    const r = runCli(["inspect", f])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/No lock at/)
  })

  it("present lock: includes holder fields", () => {
    const f = join(dir, "present.txt")
    plantHolder(f, { sessionId: "deadbeef-cafe" })
    const r = runCli(["inspect", f])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("deadbeef-cafe")
  })

  it("--json on present lock returns the annotated holder", () => {
    const f = join(dir, "present-j.txt")
    plantHolder(f, { sessionId: "alpha" })
    const r = runCli(["inspect", f, "--json"])
    expect(r.exitCode).toBe(0)
    const parsed = JSON.parse(r.stdout.trim()) as { holder: { sessionId: string } }
    expect(parsed.holder.sessionId).toBe("alpha")
  })
})

describe("runCli — clear-stale", () => {
  it("removes stale lock; keeps a held one", () => {
    const f1 = join(dir, "stale.txt") // dead pid
    const f2 = join(dir, "held.txt") // ours, very fresh
    plantHolder(f1, { sessionId: "old", filePath: f1 })
    plantHolder(f2)
    // Backstab the first lock with a known-dead pid in-place:
    const stalePid = 99999
    const fs = require("node:fs") as typeof import("node:fs")
    const h1raw = fs.readFileSync(lockPathFor(f1), "utf-8")
    const h1 = JSON.parse(h1raw.trim()) as Record<string, unknown>
    h1.pid = stalePid
    h1.acquiredAtMs = 1 // also ancient — both stale signals
    h1.acquiredAt = new Date(1).toISOString()
    fs.writeFileSync(lockPathFor(f1), JSON.stringify(h1) + "\n")

    const r = runCli(["clear-stale"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/removed:\s*1/)
    expect(existsSync(lockPathFor(f1))).toBe(false)
    expect(existsSync(lockPathFor(f2))).toBe(true)
  })
})

describe("runCli — clear", () => {
  it("requires absolute FILE", () => {
    expect(runCli(["clear"]).exitCode).toBe(2)
    expect(runCli(["clear", "rel.txt"]).exitCode).toBe(2)
  })

  it("removes the lock and exits 0", () => {
    const f = join(dir, "killme.txt")
    plantHolder(f)
    expect(existsSync(lockPathFor(f))).toBe(true)
    const r = runCli(["clear", f])
    expect(r.exitCode).toBe(0)
    expect(existsSync(lockPathFor(f))).toBe(false)
  })
})

describe("runCli — path", () => {
  it("prints the config path (matches MINIMAL_AGENT_CONFIG when set)", () => {
    const r = runCli(["path"])
    expect(r.exitCode).toBe(0)
    expect(r.stdout.trim()).toBe(configFile)
  })
})

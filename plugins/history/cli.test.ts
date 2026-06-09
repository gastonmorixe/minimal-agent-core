/**
 * Tests for the history CLI.
 *
 * Black-box: drive `run()` with argv arrays and assert exit codes +
 * stdout/stderr output. Reuses the namespace env to sandbox files.
 */

import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { parseArgs, run, UsageError } from "./cli.ts"
import {
  _clearAll,
  appendBoth,
  buildEntry,
  HISTORY_DISABLE_ENV,
  HISTORY_NAMESPACE_ENV,
  projectHistoryPath,
} from "./lib/store.ts"

const NS = `history-cli-${process.pid}`
const TEST_HOME = join(tmpdir(), `minimal-agent-history-cli-${process.pid}`)
const TEST_CWD = process.cwd()
const ORIGINAL_HOME = process.env.HOME

beforeAll(() => {
  process.env.HOME = TEST_HOME
  process.env[HISTORY_NAMESPACE_ENV] = NS
})
afterAll(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
  delete process.env[HISTORY_NAMESPACE_ENV]
  delete process.env[HISTORY_DISABLE_ENV]
  try {
    rmSync(TEST_HOME, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})
beforeEach(() => {
  _clearAll(process.env, TEST_CWD)
})

function makeIO() {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout: { write: (c: string) => stdout.push(c) },
    stderr: { write: (c: string) => stderr.push(c) },
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
  }
}

function seed(...texts: string[]) {
  for (const text of texts) {
    appendBoth(buildEntry({ text, cwd: TEST_CWD, sid: null }), { projectCwd: TEST_CWD })
  }
}

describe("cli / parseArgs", () => {
  it("defaults: list / project / process.cwd() / no limit / text", () => {
    const a = parseArgs([])
    expect(a.command).toBe("list")
    expect(a.scope).toBe("project")
    expect(a.cwd).toBe(process.cwd())
    expect(a.limit).toBeNull()
    expect(a.format).toBe("text")
  })

  it("--scope global / -s global", () => {
    expect(parseArgs(["--scope", "global"]).scope).toBe("global")
    expect(parseArgs(["-s", "global"]).scope).toBe("global")
    expect(parseArgs(["--scope=global"]).scope).toBe("global")
  })

  it("rejects unknown flags and bad scope values", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(UsageError)
    expect(() => parseArgs(["--scope", "weird"])).toThrow(UsageError)
    expect(() => parseArgs(["--limit", "-5"])).toThrow(UsageError)
    expect(() => parseArgs(["--format", "yaml"])).toThrow(UsageError)
  })

  it("--limit / -L parses positive integers", () => {
    expect(parseArgs(["-L", "5"]).limit).toBe(5)
    expect(parseArgs(["--limit=10"]).limit).toBe(10)
    expect(parseArgs(["--limit", "3"]).limit).toBe(3)
  })

  it("positionals come through in order", () => {
    const a = parseArgs(["search", "auth", "refresh"])
    expect(a.command).toBe("search")
    expect(a.positionals).toEqual(["auth", "refresh"])
  })
})

describe("cli / list", () => {
  it("(no history) for an empty file", async () => {
    const io = makeIO()
    const code = await run(["list"], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toBe("(no history)\n")
  })

  it("prints entries newest-first in text format", async () => {
    seed("alpha", "beta", "gamma")
    const io = makeIO()
    const code = await run(["list"], io)
    expect(code).toBe(0)
    const lines = io.stdoutText().trim().split("\n")
    expect(lines.length).toBe(3)
    // Newest is "gamma" — must be the first row of the text output.
    expect(lines[0]).toContain("gamma")
    expect(lines[1]).toContain("beta")
    expect(lines[2]).toContain("alpha")
  })

  it("honors --limit", async () => {
    seed("a", "b", "c", "d", "e")
    const io = makeIO()
    await run(["list", "-L", "2"], io)
    const lines = io.stdoutText().trim().split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain("e")
    expect(lines[1]).toContain("d")
  })

  it("--format json emits a parseable array", async () => {
    seed("only")
    const io = makeIO()
    await run(["list", "--format=json"], io)
    const parsed = JSON.parse(io.stdoutText())
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed.length).toBe(1)
    expect(parsed[0].text).toBe("only")
  })

  it("flattens embedded newlines to ↵ in text format", async () => {
    seed("line1\nline2\nline3")
    const io = makeIO()
    await run(["list"], io)
    expect(io.stdoutText()).toContain("line1 ↵ line2 ↵ line3")
  })
})

describe("cli / search", () => {
  beforeEach(() => {
    seed("fix auth refresh storm", "add memory plugin", "update auth tests")
  })

  it("returns matching entries (case-insensitive, newest-first)", async () => {
    const io = makeIO()
    await run(["search", "auth"], io)
    const lines = io.stdoutText().trim().split("\n")
    expect(lines.length).toBe(2)
    expect(lines[0]).toContain("update auth tests")
    expect(lines[1]).toContain("fix auth refresh storm")
  })

  it("(no matches) when query doesn't match", async () => {
    const io = makeIO()
    await run(["search", "nonexistent"], io)
    expect(io.stdoutText()).toContain("(no matches")
  })

  it("rejects an empty query", async () => {
    const io = makeIO()
    const code = await run(["search"], io)
    expect(code).toBe(1)
    expect(io.stderrText()).toContain("search requires a query")
  })

  it("--format json filters before printing", async () => {
    const io = makeIO()
    await run(["search", "auth", "--format=json"], io)
    const parsed = JSON.parse(io.stdoutText())
    expect(parsed.length).toBe(2)
    expect(parsed.every((e: { text: string }) => e.text.toLowerCase().includes("auth"))).toBe(true)
  })
})

describe("cli / clear", () => {
  it("aborts when confirm returns false", async () => {
    seed("a")
    const io = { ...makeIO(), confirm: () => false }
    const code = await run(["clear"], io)
    expect(code).toBe(2)
    expect(existsSync(projectHistoryPath(TEST_CWD))).toBe(true)
  })

  it("deletes the file when confirm returns true", async () => {
    seed("a")
    const io = { ...makeIO(), confirm: () => true }
    const code = await run(["clear"], io)
    expect(code).toBe(0)
    expect(existsSync(projectHistoryPath(TEST_CWD))).toBe(false)
  })

  it("(already empty) when no file exists", async () => {
    const io = { ...makeIO(), confirm: () => true }
    const code = await run(["clear"], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain("already empty")
  })
})

describe("cli / path", () => {
  it("prints the resolved file path (project default)", async () => {
    const io = makeIO()
    await run(["path"], io)
    expect(io.stdoutText().trim()).toBe(projectHistoryPath(TEST_CWD))
  })

  it("--scope global swaps the path", async () => {
    const io = makeIO()
    await run(["path", "-s", "global"], io)
    expect(io.stdoutText().trim()).toContain("namespaces/")
    expect(io.stdoutText().trim()).toContain("history.jsonl")
    expect(io.stdoutText().trim()).not.toContain("projects/")
  })
})

describe("cli / export", () => {
  it("emits raw JSONL one entry per line (oldest-first)", async () => {
    seed("first", "second")
    const io = makeIO()
    await run(["export"], io)
    const lines = io.stdoutText().trim().split("\n")
    expect(lines.length).toBe(2)
    const e0 = JSON.parse(lines[0])
    const e1 = JSON.parse(lines[1])
    expect(e0.text).toBe("first")
    expect(e1.text).toBe("second")
  })
})

describe("cli / unknown command", () => {
  it("exits 1 with usage", async () => {
    const io = makeIO()
    const code = await run(["bogus"], io)
    expect(code).toBe(1)
    expect(io.stderrText()).toContain("unknown command")
  })
})

describe("cli / -h / --help", () => {
  it("prints USAGE to stdout and exits 0", async () => {
    const io = makeIO()
    const code = await run(["-h"], io)
    expect(code).toBe(0)
    expect(io.stdoutText()).toContain("Usage:")
    expect(io.stdoutText()).toContain("list")
    expect(io.stdoutText()).toContain("search")
  })
})

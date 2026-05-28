import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseArgv, run } from "./cli.ts"
import { TaskStore } from "./lib/store.ts"

// ---------------------------------------------------------------------------
// Scaffolding — point HOME at a tmp dir so the CLI writes there
// ---------------------------------------------------------------------------

let tmpHome: string
const sid = "cli-test-sid"

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tasks-cli-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

/**
 * Always inject `--home tmpHome` and `--no-color` so tests are independent
 * of the real $HOME and not flaky on TTY detection. We rely on the explicit
 * `--home` flag rather than `process.env.HOME` because Bun's `os.homedir()`
 * caches at startup on some platforms and ignores env mutations.
 */
function exec(args: string[]) {
  return run(parseArgv([...args, "--sid", sid, "--home", tmpHome, "--no-color"]))
}

// ---------------------------------------------------------------------------
// Argv parsing
// ---------------------------------------------------------------------------

describe("parseArgv", () => {
  test("--help short-circuits", () => {
    expect(parseArgv(["--help"]).help).toBe(true)
    expect(parseArgv(["-h"]).help).toBe(true)
  })
  test("captures command and positionals", () => {
    const f = parseArgv(["add", "hello", "world"])
    expect(f.command).toBe("add")
    expect(f.positional).toEqual(["hello", "world"])
  })
  test("parses --sid, --parent, --format", () => {
    const f = parseArgv(["list", "--sid", "abc", "--parent", "#xyz", "-f", "json"])
    expect(f.sid).toBe("abc")
    expect(f.parent).toBe("#xyz")
    expect(f.format).toBe("json")
  })
  test("flags --parallel, --force, --no-color", () => {
    const f = parseArgv(["start", "1", "--parallel", "--force", "--no-color"])
    expect(f.parallel).toBe(true)
    expect(f.force).toBe(true)
    expect(f.noColor).toBe(true)
  })
  test("flags errors for unknown options", () => {
    const f = parseArgv(["list", "--bogus"])
    expect(f.errors).toEqual(["unknown flag: --bogus"])
  })
  test("rejects invalid format value", () => {
    const f = parseArgv(["list", "-f", "yaml"])
    expect(f.errors.length).toBe(1)
    expect(f.errors[0]).toMatch(/format must be/)
  })
})

// ---------------------------------------------------------------------------
// list (empty + populated)
// ---------------------------------------------------------------------------

describe("list", () => {
  test("empty session shows 'no tasks'", () => {
    const r = exec(["list"])
    expect(r.code).toBe(0)
    expect(r.output).toContain("no tasks")
  })
  test("after add, list renders the task", () => {
    exec(["add", "hello", "world"])
    const r = exec(["list"])
    expect(r.code).toBe(0)
    expect(r.output).toContain("hello world")
  })
  test("--format json returns parseable JSON", () => {
    exec(["add", "x"])
    const r = run(parseArgv(["list", "--sid", sid, "--home", tmpHome, "-f", "json"]))
    expect(r.code).toBe(0)
    const parsed = JSON.parse(r.output)
    expect(parsed.stats.total).toBe(1)
    expect(parsed.tasks[0].title).toBe("x")
  })
})

// ---------------------------------------------------------------------------
// add / start / done / status / update / remove
// ---------------------------------------------------------------------------

describe("add", () => {
  test("appends a task", () => {
    const r = exec(["add", "the", "title"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list().map((t) => t.title)).toEqual(["the title"])
  })
  test("requires a title", () => {
    const r = exec(["add"])
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/requires a title/)
  })
  test("supports --parent for subtasks", () => {
    exec(["add", "parent"])
    const r = exec(["add", "child", "--parent", "1"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toHaveLength(2)
    expect(store.list()[1].parent).toBe(store.list()[0].id)
  })
  test("returns 2 when --parent doesn't resolve", () => {
    const r = exec(["add", "child", "--parent", "#deadbe"])
    expect(r.code).toBe(2)
    expect(r.output).toMatch(/parent.*not found/)
  })
})

describe("start / done / status", () => {
  test("start flips to doing", () => {
    exec(["add", "x"])
    const r = exec(["start", "1"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].status).toBe("doing")
  })
  test("done flips to done", () => {
    exec(["add", "x"])
    exec(["add", "y"]) // second task so 'ALL DONE' doesn't trigger
    const r = exec(["done", "1"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].status).toBe("done")
  })
  test("done on last task triggers 'ALL DONE' verb", () => {
    exec(["add", "x"])
    const r = exec(["done", "1"])
    expect(r.code).toBe(0)
    expect(r.output).toContain("ALL DONE")
  })
  test("status accepts a reason", () => {
    exec(["add", "x"])
    const r = exec(["status", "1", "canceled", "user", "redirected"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].status).toBe("canceled")
    expect(store.list()[0].reason).toBe("user redirected")
  })
  test("status rejects invalid value", () => {
    exec(["add", "x"])
    const r = exec(["status", "1", "pending"])
    expect(r.code).toBe(1)
    expect(r.output).toMatch(/invalid status/)
  })
  test("commands return 2 for unknown id", () => {
    const r1 = exec(["start", "#deadbe"])
    expect(r1.code).toBe(2)
    const r2 = exec(["done", "99"])
    expect(r2.code).toBe(2)
  })
})

describe("update / remove / clear / path", () => {
  test("update changes the title", () => {
    exec(["add", "before"])
    const r = exec(["update", "1", "after"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()[0].title).toBe("after")
  })
  test("remove drops the task", () => {
    exec(["add", "x"])
    const r = exec(["remove", "1"])
    expect(r.code).toBe(0)
    const store = new TaskStore(sid, { home: tmpHome })
    expect(store.list()).toEqual([])
  })
  test("clear refuses with doing task", () => {
    exec(["add", "x"])
    exec(["start", "1"])
    const r = exec(["clear"])
    expect(r.code).toBe(2)
    expect(r.output).toMatch(/refusing to clear/)
  })
  test("clear --force overrides", () => {
    exec(["add", "x"])
    exec(["start", "1"])
    const r = exec(["clear", "--force"])
    expect(r.code).toBe(0)
  })
  test("path prints the resolved file path", () => {
    const r = exec(["path"])
    expect(r.code).toBe(0)
    expect(r.output).toContain(".minimal-agent/sessions")
    expect(r.output).toContain(`${sid}.tasks.jsonl`)
  })
})

// ---------------------------------------------------------------------------
// Help and missing sid
// ---------------------------------------------------------------------------

describe("help and missing sid", () => {
  test("--help prints usage", () => {
    const r = run(parseArgv(["--help"]))
    expect(r.code).toBe(0)
    expect(r.output).toContain("Usage:")
    expect(r.output).toContain("Commands:")
  })
  test("missing command shows help", () => {
    const r = run(parseArgv([]))
    expect(r.code).toBe(0)
    expect(r.output).toContain("Usage:")
  })
  test("missing sid returns 1 with hint", () => {
    const prevSid = process.env.MINIMAL_AGENT_SESSION_ID
    delete process.env.MINIMAL_AGENT_SESSION_ID
    try {
      const r = run(parseArgv(["list"]))
      expect(r.code).toBe(1)
      expect(r.output).toMatch(/--sid or MINIMAL_AGENT_SESSION_ID/)
    } finally {
      if (prevSid !== undefined) process.env.MINIMAL_AGENT_SESSION_ID = prevSid
    }
  })
})

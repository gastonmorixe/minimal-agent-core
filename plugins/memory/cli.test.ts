/**
 * Tests for the memory CLI.
 *
 * Drives the CLI via the exported `main(argv, io)` rather than spawning
 * a subprocess — much faster and lets us inspect stdout/stderr directly.
 *
 * Each test gets a temp `$HOME` so we never touch the real
 * `~/.minimal-agent/`. We still need to override `process.env.HOME`
 * because the store's path helpers read it directly.
 *
 * Coverage:
 *   - parseArgs: every flag, error paths, scope/format enum.
 *   - main commands: list, read, add, edit, remove, clear, path,
 *     rewrite-ids, --help, missing-command.
 *   - JSON shape on every command.
 *   - Exit codes: 0 success, 1 usage, 2 domain.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { main, parseArgs } from "./cli.ts"
import {
  globalMemoryPath,
  MemoryStore,
  projectMemoryPath,
  shortTermMemoryPath,
} from "./lib/store.ts"

let tmpHome: string
let savedHome: string | undefined
let savedMaHome: string | undefined
let savedSid: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-cli-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
  // Clear an inherited MINIMAL_AGENT_HOME so the store's home resolver
  // falls back to the sandbox `$HOME` we just set instead of the
  // harness-exported override (which would route at the real home).
  savedMaHome = process.env.MINIMAL_AGENT_HOME
  delete process.env.MINIMAL_AGENT_HOME
  // The CLI defaults `--sid` to `$MINIMAL_AGENT_SESSION_ID`. Clear it
  // so the "short-term requires --sid" tests are deterministic when
  // the test runner inherits a parent agent's session id.
  savedSid = process.env.MINIMAL_AGENT_SESSION_ID
  delete process.env.MINIMAL_AGENT_SESSION_ID
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  if (savedMaHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedMaHome
  if (savedSid === undefined) delete process.env.MINIMAL_AGENT_SESSION_ID
  else process.env.MINIMAL_AGENT_SESSION_ID = savedSid
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Capturing IO helper
// ---------------------------------------------------------------------------

function makeIO(): {
  stdout: { write: (s: string) => void }
  stderr: { write: (s: string) => void }
  out: string[]
  err: string[]
} {
  const out: string[] = []
  const err: string[] = []
  return {
    stdout: { write: (s: string) => out.push(s) },
    stderr: { write: (s: string) => err.push(s) },
    out,
    err,
  }
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  it("defaults: scope=project, format=text, cwd=process.cwd()", () => {
    const f = parseArgs(["list"])
    expect(f.command).toBe("list")
    expect(f.scope).toBe("project")
    expect(f.format).toBe("text")
    expect(f.cwd).toBe(process.cwd())
  })

  it("parses -s / --scope", () => {
    expect(parseArgs(["list", "-s", "global"]).scope).toBe("global")
    expect(parseArgs(["list", "--scope", "short-term"]).scope).toBe("short-term")
  })

  it("rejects unknown scope", () => {
    expect(() => parseArgs(["list", "-s", "user"])).toThrow()
  })

  it("parses --sid / --cwd", () => {
    const f = parseArgs(["list", "--sid", "abc-123", "--cwd", "/x"])
    expect(f.sid).toBe("abc-123")
    expect(f.cwd).toBe("/x")
  })

  it("parses -n / --namespace", () => {
    expect(parseArgs(["list", "-n", "scratch"]).namespace).toBe("scratch")
    expect(parseArgs(["list", "--namespace", "scratch"]).namespace).toBe("scratch")
  })

  it('--namespace "" maps to null (force-reset to default paths)', () => {
    const f = parseArgs(["list", "--namespace", ""])
    expect(f.namespace).toBeNull()
  })

  it("namespace flag is absent (not undefined-keyed) when not passed", () => {
    const f = parseArgs(["list"])
    expect("namespace" in f).toBe(false)
  })

  it("rejects --namespace with missing value", () => {
    expect(() => parseArgs(["list", "--namespace"])).toThrow()
  })

  it("parses -f / --format", () => {
    expect(parseArgs(["list", "-f", "json"]).format).toBe("json")
    expect(parseArgs(["list", "--format", "text"]).format).toBe("text")
  })

  it("rejects unknown format", () => {
    expect(() => parseArgs(["list", "-f", "xml"])).toThrow()
  })

  it("parses -q / --query and -L / --limit", () => {
    const f = parseArgs(["list", "-q", "needle", "-L", "5"])
    expect(f.query).toBe("needle")
    expect(f.limit).toBe(5)
  })

  it("rejects bad --limit (not integer / negative / zero)", () => {
    expect(() => parseArgs(["list", "-L", "0"])).toThrow()
    expect(() => parseArgs(["list", "-L", "-1"])).toThrow()
    expect(() => parseArgs(["list", "-L", "1.5"])).toThrow()
    expect(() => parseArgs(["list", "-L", "abc"])).toThrow()
  })

  it("collects positional args for command", () => {
    const f = parseArgs(["edit", "abc-1234", "new", "body", "with", "spaces"])
    expect(f.command).toBe("edit")
    expect(f.positional).toEqual(["abc-1234", "new", "body", "with", "spaces"])
  })

  it("rejects unknown command", () => {
    expect(() => parseArgs(["destroy"])).toThrow()
  })

  it("rejects unknown flags", () => {
    expect(() => parseArgs(["list", "--turbo"])).toThrow()
  })

  it("--no-color disables color", () => {
    expect(parseArgs(["list", "--no-color"]).color).toBe(false)
  })

  it("-h / --help sets help flag", () => {
    expect(parseArgs(["-h"]).help).toBe(true)
    expect(parseArgs(["--help"]).help).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// main: list
// ---------------------------------------------------------------------------

describe("main — list", () => {
  it("empty store renders header only, exit 0", async () => {
    const io = makeIO()
    const code = await main(["list", "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("project (no entries)")
  })

  it("populated store: shows all bullets", async () => {
    MemoryStore.project(process.cwd(), { home: tmpHome }).add("alpha")
    MemoryStore.project(process.cwd(), { home: tmpHome }).add("beta")

    const io = makeIO()
    await main(["list", "--no-color"], io)
    const text = io.out.join("")
    expect(text).toContain("project (2 entries)")
    expect(text).toContain("alpha")
    expect(text).toContain("beta")
  })

  it("filters by --query (case-insensitive)", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    s.add("Active hypothesis")
    s.add("noise")

    const io = makeIO()
    await main(["list", "--no-color", "-q", "ACTIVE"], io)
    const text = io.out.join("")
    expect(text).toContain("(1 entry)")
    expect(text).toContain("Active hypothesis")
    expect(text).not.toContain("noise")
  })

  it("limits with --limit", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    for (let i = 1; i <= 4; i++) s.add(`e${i}`)

    const io = makeIO()
    await main(["list", "--no-color", "-L", "2"], io)
    const text = io.out.join("")
    expect(text).toContain("(showing 2 of 4 entries, offset 0)")
    // Bullet rows render as `  #<id>  <ts>  <body>`. Assert on the body
    // column (the last whitespace-delimited field) rather than the raw
    // blob: ids are base36+hex, so a substring like "e1" can land inside
    // a randomly-generated id and make a naive `toContain` check flaky.
    const bodies = text
      .split("\n")
      .filter((l) => l.trimStart().startsWith("#"))
      .map((l) => l.trim().split(/\s+/).at(-1))
    expect(bodies).toContain("e3")
    expect(bodies).toContain("e4")
    expect(bodies).not.toContain("e1")
    expect(bodies).not.toContain("e2")
  })

  it("format=json returns parseable output", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    s.add("hi")

    const io = makeIO()
    await main(["list", "-f", "json"], io)
    const parsed = JSON.parse(io.out.join(""))
    expect(parsed.scope).toBe("project")
    expect(parsed.bullets[0].body).toBe("hi")
  })
})

// ---------------------------------------------------------------------------
// main: read
// ---------------------------------------------------------------------------

describe("main — read", () => {
  it("reads by stamped id", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    const { bullet } = s.add("readable")

    const io = makeIO()
    const code = await main(["read", bullet.id, "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("readable")
  })

  it("missing id → exit 1", async () => {
    const io = makeIO()
    const code = await main(["read"], io)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("read requires <id>")
  })

  it("unknown id → exit 2", async () => {
    const io = makeIO()
    const code = await main(["read", "nope"], io)
    expect(code).toBe(2)
    expect(io.err.join("")).toContain("no bullet with id")
  })

  it("format=json shape", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    const { bullet } = s.add("json-read")

    const io = makeIO()
    await main(["read", bullet.id, "-f", "json"], io)
    const parsed = JSON.parse(io.out.join(""))
    expect(parsed.bullet.id).toBe(bullet.id)
    expect(parsed.bullet.body).toBe("json-read")
  })
})

// ---------------------------------------------------------------------------
// main: add
// ---------------------------------------------------------------------------

describe("main — add", () => {
  it("appends and prints saved confirmation", async () => {
    const io = makeIO()
    const code = await main(["add", "added", "via", "cli", "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("saved [project#")
    expect(io.out.join("")).toContain("added via cli")

    // Verified on disk.
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    expect(s.list()[0]?.body).toBe("added via cli")
  })

  it("missing body → exit 1", async () => {
    const io = makeIO()
    const code = await main(["add"], io)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("add requires <body>")
  })

  it("short-term: requires --sid (or env var)", async () => {
    const io = makeIO()
    const code = await main(["add", "scratch", "-s", "short-term"], io)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("short-term requires --sid")
  })

  it("short-term: with --sid, persists and reports id=1", async () => {
    const io = makeIO()
    const sid = "11111111-2222-3333-4444-555555555555"
    const code = await main(["add", "scratch", "-s", "short-term", "--sid", sid, "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("saved [short-term#1]")
  })

  it("format=json: returns id", async () => {
    const io = makeIO()
    await main(["add", "x", "-f", "json"], io)
    const parsed = JSON.parse(io.out.join(""))
    expect(parsed.id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
  })
})

// ---------------------------------------------------------------------------
// main: edit
// ---------------------------------------------------------------------------

describe("main — edit", () => {
  it("replaces body, exit 0", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    const { bullet } = s.add("orig")

    const io = makeIO()
    const code = await main(["edit", bullet.id, "new", "body", "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("edited [project#")
    expect(s.read(bullet.id)?.body).toBe("new body")
  })

  it("missing id or body → exit 1", async () => {
    const r1 = await main(["edit"], makeIO())
    expect(r1).toBe(1)
    const r2 = await main(["edit", "abc"], makeIO())
    expect(r2).toBe(1)
  })

  it("unknown id → exit 2", async () => {
    const io = makeIO()
    const code = await main(["edit", "nope", "x"], io)
    expect(code).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// main: remove
// ---------------------------------------------------------------------------

describe("main — remove", () => {
  it("drops the line", async () => {
    const s = MemoryStore.project(process.cwd(), { home: tmpHome })
    s.add("keep")
    const { bullet } = s.add("drop")

    const io = makeIO()
    const code = await main(["remove", bullet.id, "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("removed [project#")
    expect(s.list().map((b) => b.body)).toEqual(["keep"])
  })

  it("unknown id → exit 2", async () => {
    const io = makeIO()
    const code = await main(["remove", "nope"], io)
    expect(code).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// main: clear
// ---------------------------------------------------------------------------

describe("main — clear", () => {
  it("short-term: wipes the file, exit 0", async () => {
    const sid = "sid-clear"
    MemoryStore.shortTerm(sid, { home: tmpHome }).add("e1")
    MemoryStore.shortTerm(sid, { home: tmpHome }).add("e2")

    const io = makeIO()
    const code = await main(["clear", "-s", "short-term", "--sid", sid, "--no-color"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("cleared 2 short-term entries")
  })

  it("project: refused, exit 2", async () => {
    const io = makeIO()
    const code = await main(["clear", "-s", "project"], io)
    expect(code).toBe(2)
    expect(io.err.join("")).toContain('only allowed for scope="short-term"')
  })

  it("global: refused, exit 2", async () => {
    const io = makeIO()
    const code = await main(["clear", "-s", "global"], io)
    expect(code).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// main: path
// ---------------------------------------------------------------------------

describe("main — path", () => {
  it("project: prints projectMemoryPath", async () => {
    const io = makeIO()
    const code = await main(["path"], io)
    expect(code).toBe(0)
    expect(io.out.join("").trimEnd()).toBe(projectMemoryPath(process.cwd(), { home: tmpHome }))
  })

  it("global: prints globalMemoryPath", async () => {
    const io = makeIO()
    await main(["path", "-s", "global"], io)
    expect(io.out.join("").trimEnd()).toBe(globalMemoryPath({ home: tmpHome }))
  })

  it("short-term: requires --sid", async () => {
    const io = makeIO()
    const code = await main(["path", "-s", "short-term"], io)
    expect(code).toBe(1)
  })

  it("short-term: with --sid prints scratch path", async () => {
    const io = makeIO()
    const sid = "abc"
    await main(["path", "-s", "short-term", "--sid", sid], io)
    expect(io.out.join("").trimEnd()).toBe(shortTermMemoryPath(sid, { home: tmpHome }))
  })

  it("--namespace routes path under namespaces/<ns>/", async () => {
    const io = makeIO()
    const code = await main(["path", "-s", "global", "-n", "scratch"], io)
    expect(code).toBe(0)
    expect(io.out.join("").trimEnd()).toBe(
      join(tmpHome, ".minimal-agent", "namespaces", "scratch", "memory.md"),
    )
  })

  it("--namespace also isolates add/list end-to-end", async () => {
    // Default namespace: add one entry.
    await main(["add", "default-only", "-s", "global"], makeIO())
    // Namespaced: should see ZERO entries.
    const nsIO = makeIO()
    const code = await main(["list", "-s", "global", "-n", "scratch", "-f", "json"], nsIO)
    expect(code).toBe(0)
    const parsed = JSON.parse(nsIO.out.join("")) as { total: number; bullets: unknown[] }
    expect(parsed.total).toBe(0)
    expect(parsed.bullets).toEqual([])
    // Add into the namespace and confirm it lands in the namespaced file
    // and is invisible to the default scope.
    await main(["add", "ns-only", "-s", "global", "-n", "scratch"], makeIO())
    const defIO = makeIO()
    await main(["list", "-s", "global", "-f", "json"], defIO)
    const defParsed = JSON.parse(defIO.out.join("")) as { total: number }
    expect(defParsed.total).toBe(1) // still only `default-only`
  })

  it("--namespace with invalid value (slash) fails loudly", async () => {
    const io = makeIO()
    const code = await main(["path", "-s", "global", "-n", "bad/ns"], io)
    expect(code).toBe(2)
    expect(io.err.join("")).toMatch(/invalid namespace/)
  })
})

// ---------------------------------------------------------------------------
// main: rewrite-ids
// ---------------------------------------------------------------------------

describe("main — rewrite-ids", () => {
  it("stamps persistent ids onto legacy bullets", async () => {
    const path = projectMemoryPath(process.cwd(), { home: tmpHome })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      "- legacy one\n" +
        "- [#abc-1234] [2026-05-08T16:57:30-04:00] new bullet\n" +
        "- legacy two\n",
    )

    const io = makeIO()
    const code = await main(["rewrite-ids"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("stamped 2 legacy bullet(s)")

    const after = readFileSync(path, "utf-8")
    // No more legacy bullets — every line has [#<id>].
    const lines = after.trimEnd().split("\n")
    expect(lines.length).toBe(3)
    for (const l of lines) {
      expect(l).toMatch(/^- \[#[\w-]+\]/)
    }
    // The previously-stamped bullet is preserved verbatim.
    expect(after).toContain("[#abc-1234]")
  })

  it("idempotent: running twice does nothing the second time", async () => {
    const path = projectMemoryPath(process.cwd(), { home: tmpHome })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "- legacy\n")

    await main(["rewrite-ids"], makeIO())
    const afterFirst = readFileSync(path, "utf-8")

    const io = makeIO()
    await main(["rewrite-ids"], io)
    const afterSecond = readFileSync(path, "utf-8")
    expect(afterSecond).toBe(afterFirst)
    expect(io.out.join("")).toContain("no legacy bullets found")
  })

  it("missing file → friendly noop, exit 0", async () => {
    const io = makeIO()
    const code = await main(["rewrite-ids"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("nothing to rewrite")
  })

  it("refuses for short-term (ints aren't synthetic)", async () => {
    const io = makeIO()
    const code = await main(["rewrite-ids", "-s", "short-term", "--sid", "x"], io)
    expect(code).toBe(2)
    expect(io.err.join("")).toContain("only meaningful for global/project")
  })
})

// ---------------------------------------------------------------------------
// main: --help / no command
// ---------------------------------------------------------------------------

describe("main — help / no command", () => {
  it("--help prints HELP, exit 0", async () => {
    const io = makeIO()
    const code = await main(["--help"], io)
    expect(code).toBe(0)
    expect(io.out.join("")).toContain("memory — manage saved memories")
  })

  it("no command prints HELP and exits 1 (usage error)", async () => {
    const io = makeIO()
    const code = await main([], io)
    expect(code).toBe(1)
    expect(io.out.join("")).toContain("memory — manage saved memories")
  })

  it("bad flag prints HELP, exit 1", async () => {
    const io = makeIO()
    const code = await main(["list", "--turbo"], io)
    expect(code).toBe(1)
    expect(io.err.join("")).toContain("unknown flag")
  })
})

// ---------------------------------------------------------------------------
// Smoke: end-to-end CLI workflow (add → list → edit → read → remove → list)
// ---------------------------------------------------------------------------

describe("main — end-to-end workflow", () => {
  it("add → list → edit → read → remove → list produces the expected sequence", async () => {
    // Add
    const io1 = makeIO()
    await main(["add", "first", "-f", "json"], io1)
    const { id } = JSON.parse(io1.out.join(""))

    // List → 1 entry
    const io2 = makeIO()
    await main(["list", "-f", "json"], io2)
    expect(JSON.parse(io2.out.join("")).total).toBe(1)

    // Edit
    const io3 = makeIO()
    await main(["edit", id, "first", "edited", "-f", "json"], io3)
    expect(JSON.parse(io3.out.join("")).bullet.body).toBe("first edited")

    // Read
    const io4 = makeIO()
    await main(["read", id, "-f", "json"], io4)
    expect(JSON.parse(io4.out.join("")).bullet.body).toBe("first edited")

    // Remove
    const io5 = makeIO()
    await main(["remove", id, "-f", "json"], io5)
    expect(JSON.parse(io5.out.join("")).removed.body).toBe("first edited")

    // List → 0 entries
    const io6 = makeIO()
    await main(["list", "-f", "json"], io6)
    expect(JSON.parse(io6.out.join("")).total).toBe(0)
  })
})

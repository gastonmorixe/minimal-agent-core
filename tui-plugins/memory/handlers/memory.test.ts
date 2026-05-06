/**
 * Tests for the `memory` plugin's save handler (memory.ts) and load
 * fragment (load.ts), plus an end-to-end integration test that loads the
 * plugin through `PluginLoader` and checks the assembled prompt block.
 *
 * Each test uses a dedicated temp dir as `$HOME` so we never read or
 * write the user's actual `~/.minimal-agent/`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { PluginLoader } from "../../../src/plugins/loader.ts"
import type {
  PromptFragmentContext,
  TUIContext,
} from "../../../src/plugins/types.ts"

import loadMemories, { globalMemoryPath, projectMemoryPath } from "./load.ts"
import memoryHandler, { localIsoSeconds } from "./memory.ts"

// Matches a single bullet line of the form `- [<iso>] <body>\n`, where
// <iso> is `YYYY-MM-DDTHH:MM:SS±HH:MM` (local-time ISO 8601 with seconds).
const TS_RE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}"

const PROJECT_ROOT = resolve(__dirname, "../../..")
const PLUGIN_DIR = resolve(__dirname, "..")

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("memory: localIsoSeconds", () => {
  it("formats a fixed date as local ISO 8601 with seconds and offset", () => {
    // Use a wall-clock date and assert shape only — the offset depends on
    // the test runner's timezone, which we don't control.
    const out = localIsoSeconds(new Date(2026, 4, 5, 21, 6, 20))
    expect(out).toMatch(
      new RegExp("^2026-05-05T21:06:20[+-]\\d{2}:\\d{2}$"),
    )
  })

  it("zero-pads single-digit fields", () => {
    const out = localIsoSeconds(new Date(2026, 0, 2, 3, 4, 5))
    expect(out).toMatch(
      new RegExp("^2026-01-02T03:04:05[+-]\\d{2}:\\d{2}$"),
    )
  })
})

describe("memory: path helpers", () => {
  it("globalMemoryPath = <home>/.minimal-agent/memory.md", () => {
    expect(globalMemoryPath("/h")).toBe("/h/.minimal-agent/memory.md")
  })

  it("projectMemoryPath strips leading slashes from cwd and nests under projects/", () => {
    expect(projectMemoryPath("/Users/a/proj", "/h")).toBe(
      "/h/.minimal-agent/projects/Users/a/proj/memory.md",
    )
  })

  it("projectMemoryPath handles already-relative-looking cwd defensively", () => {
    expect(projectMemoryPath("///abc", "/h")).toBe(
      "/h/.minimal-agent/projects/abc/memory.md",
    )
  })
})

// ---------------------------------------------------------------------------
// Save handler
// ---------------------------------------------------------------------------

function makeSaveCtx(opts: {
  body: string
  attrs?: Record<string, string>
  cwd?: string
}): TUIContext {
  return {
    trigger: {
      type: "inline_tag",
      name: "memory",
      attrs: opts.attrs ?? {},
      body: opts.body,
      self_closing: false,
    },
    packageDir: PLUGIN_DIR,
    cwd: opts.cwd ?? "/some/where",
    env: {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr as NodeJS.WriteStream,
  }
}

describe("memory: save handler", () => {
  it("default scope is project; appends bullet to project file", async () => {
    const cwd = "/Users/x/code"
    const res = await memoryHandler(makeSaveCtx({ body: "hello", cwd }))
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[project]")

    const path = projectMemoryPath(cwd, tmpHome)
    expect(readFileSync(path, "utf-8")).toMatch(
      new RegExp("^- \\[" + TS_RE + "\\] hello\\n$"),
    )
  })

  it("scope='global' writes to ~/.minimal-agent/memory.md", async () => {
    const res = await memoryHandler(
      makeSaveCtx({ body: "global thing", attrs: { scope: "global" } }),
    )
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[global]")

    expect(readFileSync(globalMemoryPath(tmpHome), "utf-8")).toMatch(
      new RegExp("^- \\[" + TS_RE + "\\] global thing\\n$"),
    )
  })

  it("appends to a file with pre-existing untimestamped (legacy) bullets without rewriting them", async () => {
    // Simulate a memory file written by an older version of the plugin or
    // hand-edited by the user — bullets have no `[<ts>] ` prefix.
    const cwd = "/legacy"
    const path = projectMemoryPath(cwd, tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    })
    writeFileSync(path, "- legacy one\n- legacy two\n")

    await memoryHandler(makeSaveCtx({ body: "fresh", cwd }))

    const out = readFileSync(path, "utf-8")
    // Legacy bullets are preserved verbatim (no timestamp injected).
    expect(out.startsWith("- legacy one\n- legacy two\n")).toBe(true)
    // New bullet is appended with a timestamp.
    expect(out).toMatch(
      new RegExp(
        "^- legacy one\\n" +
          "- legacy two\\n" +
          "- \\[" + TS_RE + "\\] fresh\\n$",
      ),
    )
  })

  it("appends across multiple calls (does not overwrite)", async () => {
    const cwd = "/p"
    await memoryHandler(makeSaveCtx({ body: "one", cwd }))
    await memoryHandler(makeSaveCtx({ body: "two", cwd }))
    await memoryHandler(makeSaveCtx({ body: "three", cwd }))
    expect(readFileSync(projectMemoryPath(cwd, tmpHome), "utf-8")).toMatch(
      new RegExp(
        "^- \\[" + TS_RE + "\\] one\\n" +
          "- \\[" + TS_RE + "\\] two\\n" +
          "- \\[" + TS_RE + "\\] three\\n$",
      ),
    )
  })

  it("collapses multi-line bodies to a single line", async () => {
    const body = "first line\n  second line\n\nthird"
    await memoryHandler(makeSaveCtx({ body, cwd: "/p" }))
    expect(readFileSync(projectMemoryPath("/p", tmpHome), "utf-8")).toMatch(
      new RegExp("^- \\[" + TS_RE + "\\] first line second line third\\n$"),
    )
  })

  it("ignores empty bodies (no file created)", async () => {
    const res = await memoryHandler(makeSaveCtx({ body: "   \n  ", cwd: "/p" }))
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toBe("")
    expect(existsSync(projectMemoryPath("/p", tmpHome))).toBe(false)
    expect(existsSync(globalMemoryPath(tmpHome))).toBe(false)
  })

  it("unknown scope value falls back to project (does not throw)", async () => {
    await memoryHandler(
      makeSaveCtx({ body: "x", attrs: { scope: "weird" }, cwd: "/p" }),
    )
    expect(existsSync(projectMemoryPath("/p", tmpHome))).toBe(true)
    expect(existsSync(globalMemoryPath(tmpHome))).toBe(false)
  })

  it("creates the project subdirectory tree on first save", async () => {
    const cwd = "/deeply/nested/never/seen/before"
    await memoryHandler(makeSaveCtx({ body: "x", cwd }))
    expect(existsSync(projectMemoryPath(cwd, tmpHome))).toBe(true)
  })

  it("refuses to write when the resolved target is inside packageDir", async () => {
    // Force this by pointing $HOME at the plugin dir itself, so the
    // global path lands under packageDir.
    process.env.HOME = PLUGIN_DIR
    const ctx = makeSaveCtx({ body: "x", attrs: { scope: "global" } })
    const res = await memoryHandler(ctx)
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("refused")
    // Restore for afterEach cleanup.
    process.env.HOME = tmpHome
  })

  it("non-inline-tag triggers return empty (defensive)", async () => {
    const ctx: TUIContext = {
      ...makeSaveCtx({ body: "x" }),
      trigger: {
        type: "tool",
        name: "memory",
        input: {},
        tool_use_id: "x",
      },
    }
    const res = await memoryHandler(ctx)
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toBe("")
  })
})

// ---------------------------------------------------------------------------
// Load fragment
// ---------------------------------------------------------------------------

function makeLoadCtx(cwd: string): PromptFragmentContext {
  return {
    packageDir: PLUGIN_DIR,
    cwd,
    env: {},
    sessionId: undefined,
    abort: new AbortController().signal,
    stderr: process.stderr as NodeJS.WriteStream,
  }
}

describe("memory: load fragment", () => {
  it("returns empty string when neither file exists", async () => {
    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).toBe("")
  })

  it("includes only Global section when only global file exists", async () => {
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(gp, "- alpha\n- beta\n")

    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).toContain("## Saved memories")
    expect(out).toContain("### Global")
    expect(out).toContain("- alpha")
    expect(out).toContain("- beta")
    expect(out).not.toContain("### Project")
  })

  it("includes only Project section when only project file exists", async () => {
    const pp = projectMemoryPath("/work/p", tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(pp), {
      recursive: true,
    })
    writeFileSync(pp, "- gamma\n")

    const out = await loadMemories(makeLoadCtx("/work/p"))
    expect(out).toContain("### Project")
    expect(out).toContain("- gamma")
    expect(out).not.toContain("### Global")
  })

  it("includes both sections, Global first then Project, when both exist", async () => {
    const gp = globalMemoryPath(tmpHome)
    const pp = projectMemoryPath("/work/p", tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    require("node:fs").mkdirSync(require("node:path").dirname(pp), {
      recursive: true,
    })
    writeFileSync(gp, "- global-one\n")
    writeFileSync(pp, "- project-one\n")

    const out = await loadMemories(makeLoadCtx("/work/p"))
    const gIdx = out.indexOf("### Global")
    const pIdx = out.indexOf("### Project")
    expect(gIdx).toBeGreaterThan(-1)
    expect(pIdx).toBeGreaterThan(-1)
    expect(gIdx).toBeLessThan(pIdx)
    expect(out).toContain("- global-one")
    expect(out).toContain("- project-one")
  })

  it("loads legacy (untimestamped) and new (timestamped) bullets together verbatim", async () => {
    // Memory files can contain a mix of formats — older bullets without a
    // `[<ts>] ` prefix and newer ones with it. The loader should pass them
    // through unchanged, never rewriting or filtering.
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(
      gp,
      "- legacy bullet, no timestamp\n" +
        "- [2026-05-05T21:06:20-04:00] new bullet, with timestamp\n",
    )

    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).toContain("- legacy bullet, no timestamp")
    expect(out).toContain(
      "- [2026-05-05T21:06:20-04:00] new bullet, with timestamp",
    )
  })

  it("trims surrounding whitespace from file contents", async () => {
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(gp, "\n\n\n- only\n\n\n\n")
    const out = await loadMemories(makeLoadCtx("/p"))
    // No triple-blank-line runs from leading/trailing whitespace.
    expect(out).not.toMatch(/\n\n\n\n/)
    expect(out).toContain("- only")
  })
})

// ---------------------------------------------------------------------------
// End-to-end via PluginLoader
// ---------------------------------------------------------------------------

describe("memory: integration with PluginLoader", () => {
  it("loads the memory plugin and embeds saved memories into the prompt block", async () => {
    // Pre-seed a global and a project memory.
    const gp = globalMemoryPath(tmpHome)
    const pp = projectMemoryPath(process.cwd(), tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    require("node:fs").mkdirSync(require("node:path").dirname(pp), {
      recursive: true,
    })
    writeFileSync(gp, "- E2E global memory line\n")
    writeFileSync(pp, "- E2E project memory line\n")

    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    })

    const block = await loader.getPromptBlockAsync()
    expect(block).not.toBeNull()
    if (block === null) throw new Error("unreachable")
    expect(block).toContain("## Saved memories")
    expect(block).toContain("- E2E global memory line")
    expect(block).toContain("- E2E project memory line")
  })

  it("save handler dispatched through scanner writes to the right file", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    })

    // Drive the inline-tag handler directly. (The scanner path is already
    // covered by the diff-view integration test; here we only need to
    // confirm the loader wires up our handler.)
    const cwd = process.cwd()
    const result = await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "project" },
        body: "integration save test",
        self_closing: false,
      },
      cwd,
    )
    expect(result).not.toBeNull()
    if (result === null) throw new Error("unreachable")
    expect(result.kind).toBe("rendered")

    const path = projectMemoryPath(cwd, tmpHome)
    expect(readFileSync(path, "utf-8")).toMatch(
      new RegExp("^- \\[" + TS_RE + "\\] integration save test\\n$"),
    )
  })
})

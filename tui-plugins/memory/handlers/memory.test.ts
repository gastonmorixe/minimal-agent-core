/**
 * Tests for the `memory` plugin's save handler (memory.ts) and load
 * fragment (load.ts), plus an end-to-end integration test that loads the
 * plugin through `PluginLoader` and checks the assembled prompt block.
 *
 * Each test uses a dedicated temp dir as `$HOME` so we never read or
 * write the user's actual `~/.minimal-agent/`.
 *
 * v0.3 changes captured by this file:
 *   - Bullets now start with a stable `[#<id>] ` prefix (persistent ids
 *     for global/project, integer ids for short-term).
 *   - `scope="short-term"` is accepted and writes to
 *     `~/.minimal-agent/sessions/<sid>.scratch.md`.
 *   - On save, the handler emits `memory.saved` on the global event bus
 *     (so the agent's SaveEchoCollector can echo the id to the model).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { setGlobalEventBus } from "../../../src/global-bus.ts"
import { EventBus } from "../../../src/plugins/event-bus.ts"
import { PluginLoader } from "../../../src/plugins/loader.ts"
import type {
  PromptFragmentContext,
  TUIContext,
} from "../../../src/plugins/types.ts"

import {
  MEMORY_SAVED,
  type MemorySavedPayload,
} from "../lib/save-echo.ts"
import { shortTermMemoryPath } from "../lib/store.ts"
import loadMemories, { globalMemoryPath, projectMemoryPath } from "./load.ts"
import memoryHandler, { localIsoSeconds } from "./memory.ts"

// Regex fragments. New v0.3 bullet shape: `- [#<id>] [<ts>][ [session:<sid>]] body\n`.
// `ID_RE` matches both flavors: persistent (`<base36>-<hex>`) and short-term int.
const ID_RE = "(?:[0-9a-z]+-[0-9a-f]{4}|\\d+|legacy:[0-9a-f]{12})"
const TS_RE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2}"
/** Convenient prefix `- [#<id>] [<ts>] ` (no trailing space sentinel). */
const PREFIX = "- \\[#" + ID_RE + "\\] \\[" + TS_RE + "\\] "

const PROJECT_ROOT = resolve(__dirname, "../../..")
const PLUGIN_DIR = resolve(__dirname, "..")

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
  setGlobalEventBus(null)
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
  setGlobalEventBus(null)
})

// ---------------------------------------------------------------------------
// Path helpers (re-exported via load.ts; kept here for stable import surface)
// ---------------------------------------------------------------------------

describe("memory: localIsoSeconds (re-exported from lib/parse.ts)", () => {
  it("formats a fixed date as local ISO 8601 with seconds and offset", () => {
    const out = localIsoSeconds(new Date(2026, 4, 5, 21, 6, 20))
    expect(out).toMatch(
      new RegExp("^2026-05-05T21:06:20[+-]\\d{2}:\\d{2}$"),
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
  env?: Record<string, string>
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
    env: opts.env ?? {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr as NodeJS.WriteStream,
    log: makeNoopLogger(),
  }
}

/**
 * Stub `PluginLogger` for tests. The diagnostic-bus routes the real
 * logger through the singleton bus + file sink, which we don't want
 * touching disk in unit tests. This shape mirrors `PluginLogger`
 * exactly.
 */
function makeNoopLogger() {
  const noop = (_s: string, _m: string, _sd?: Readonly<Record<string, string | number | boolean>>) => {}
  return {
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: noop,
    notice: noop,
    info: noop,
    debug: noop,
  }
}

describe("memory: save handler — project / global / short-term", () => {
  it("default scope is project; appends bullet to project file with id+ts prefix", async () => {
    const cwd = "/Users/x/code"
    const res = await memoryHandler(makeSaveCtx({ body: "hello", cwd }))
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[project#")

    const path = projectMemoryPath(cwd, tmpHome)
    expect(readFileSync(path, "utf-8")).toMatch(
      new RegExp("^" + PREFIX + "hello\\n$"),
    )
  })

  it("scope='global' writes to ~/.minimal-agent/memory.md", async () => {
    const res = await memoryHandler(
      makeSaveCtx({ body: "global thing", attrs: { scope: "global" } }),
    )
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[global#")

    expect(readFileSync(globalMemoryPath(tmpHome), "utf-8")).toMatch(
      new RegExp("^" + PREFIX + "global thing\\n$"),
    )
  })

  it("scope='short-term' writes to ~/.minimal-agent/sessions/<sid>.scratch.md with integer id", async () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const res = await memoryHandler(
      makeSaveCtx({
        body: "short scratch",
        attrs: { scope: "short-term" },
        env: { MINIMAL_AGENT_SESSION_ID: sid },
      }),
    )
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[short-term#1]")

    const path = shortTermMemoryPath(sid, { home: tmpHome })
    const content = readFileSync(path, "utf-8")
    // Short-term doesn't carry a [session:…] field on the line (the FILE
    // is per-session, redundant on every line).
    expect(content).not.toContain("[session:")
    expect(content).toMatch(
      new RegExp("^- \\[#1\\] \\[" + TS_RE + "\\] short scratch\\n$"),
    )
  })

  it("scope='short' is treated as 'short-term'", async () => {
    const sid = "abc-1234"
    const res = await memoryHandler(
      makeSaveCtx({
        body: "shorthand",
        attrs: { scope: "short" },
        env: { MINIMAL_AGENT_SESSION_ID: sid },
      }),
    )
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[short-term#")
  })

  it("scope='short-term' refuses when no session id is plumbed through", async () => {
    const res = await memoryHandler(
      makeSaveCtx({ body: "x", attrs: { scope: "short-term" } /* env omitted */ }),
    )
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("refused")
    expect(res.ansi).toContain("session id")
    // Nothing written.
    expect(existsSync(shortTermMemoryPath("any", { home: tmpHome }))).toBe(false)
  })

  it("scope='short-term' refuses when sid is whitespace-only", async () => {
    const res = await memoryHandler(
      makeSaveCtx({
        body: "x",
        attrs: { scope: "short-term" },
        env: { MINIMAL_AGENT_SESSION_ID: "   " },
      }),
    )
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("refused")
  })
})

describe("memory: save handler — file IO and back-compat", () => {
  it("appends to a file with pre-existing untimestamped (legacy) bullets without rewriting them", async () => {
    const cwd = "/legacy"
    const path = projectMemoryPath(cwd, tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(path), {
      recursive: true,
    })
    writeFileSync(path, "- legacy one\n- legacy two\n")

    await memoryHandler(makeSaveCtx({ body: "fresh", cwd }))

    const out = readFileSync(path, "utf-8")
    expect(out.startsWith("- legacy one\n- legacy two\n")).toBe(true)
    // New bullet has the v0.3 format (id-prefixed).
    expect(out).toMatch(
      new RegExp(
        "^- legacy one\\n" +
          "- legacy two\\n" +
          PREFIX + "fresh\\n$",
      ),
    )
  })

  it("appends across multiple calls (does not overwrite); ids differ", async () => {
    const cwd = "/p"
    await memoryHandler(makeSaveCtx({ body: "one", cwd }))
    await memoryHandler(makeSaveCtx({ body: "two", cwd }))
    await memoryHandler(makeSaveCtx({ body: "three", cwd }))
    const out = readFileSync(projectMemoryPath(cwd, tmpHome), "utf-8")
    const lines = out.trimEnd().split("\n")
    expect(lines.length).toBe(3)
    expect(lines[0]).toMatch(new RegExp("^" + PREFIX + "one$"))
    expect(lines[1]).toMatch(new RegExp("^" + PREFIX + "two$"))
    expect(lines[2]).toMatch(new RegExp("^" + PREFIX + "three$"))
  })

  it("collapses multi-line bodies to a single line", async () => {
    const body = "first line\n  second line\n\nthird"
    await memoryHandler(makeSaveCtx({ body, cwd: "/p" }))
    expect(readFileSync(projectMemoryPath("/p", tmpHome), "utf-8")).toMatch(
      new RegExp("^" + PREFIX + "first line second line third\\n$"),
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
    process.env.HOME = PLUGIN_DIR
    const ctx = makeSaveCtx({ body: "x", attrs: { scope: "global" } })
    const res = await memoryHandler(ctx)
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("refused")
    process.env.HOME = tmpHome
  })

  it("includes [session:<sid>] field on persistent bullets when MINIMAL_AGENT_SESSION_ID is in ctx.env", async () => {
    const sid = "a4da0710-fc5a-4959-bc71-c965a46d1231"
    const cwd = "/p"
    const res = await memoryHandler(
      makeSaveCtx({ body: "with sid", cwd, env: { MINIMAL_AGENT_SESSION_ID: sid } }),
    )
    if (res.kind !== "rendered") throw new Error("unreachable")
    const out = readFileSync(projectMemoryPath(cwd, tmpHome), "utf-8")
    // Persistent format with session: `- [#<id>] [<ts>] [session:<sid>] body\n`
    expect(out).toMatch(
      new RegExp(
        "^- \\[#" + ID_RE + "\\] \\[" + TS_RE + "\\] \\[session:" + sid +
          "\\] with sid\\n$",
      ),
    )
  })

  it("omits the [session:...] field when no session id is plumbed through (back-compat)", async () => {
    const cwd = "/p"
    await memoryHandler(makeSaveCtx({ body: "no sid", cwd }))
    const out = readFileSync(projectMemoryPath(cwd, tmpHome), "utf-8")
    expect(out).toMatch(new RegExp("^" + PREFIX + "no sid\\n$"))
    expect(out).not.toContain("[session:")
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
// Bus emit (memory.saved)
// ---------------------------------------------------------------------------

describe("memory: save handler — emits memory.saved on global bus", () => {
  it("emits payload {scope,id,body} after a successful save", async () => {
    const bus = new EventBus()
    setGlobalEventBus(bus)

    const events: MemorySavedPayload[] = []
    bus.on(MEMORY_SAVED, (ctx) => {
      events.push(ctx.payload as MemorySavedPayload)
    })

    await memoryHandler(makeSaveCtx({ body: "with bus", cwd: "/p" }))
    // Bus dispatches via queueMicrotask — wait one tick.
    await Promise.resolve()

    expect(events.length).toBe(1)
    expect(events[0]?.scope).toBe("project")
    expect(events[0]?.id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
    expect(events[0]?.body).toBe("with bus")
    expect(events[0]?.evicted).toBeUndefined()

    bus.dispose()
  })

  it("emits scope='short-term' and integer id for short-term saves", async () => {
    const bus = new EventBus()
    setGlobalEventBus(bus)

    const events: MemorySavedPayload[] = []
    bus.on(MEMORY_SAVED, (ctx) => {
      events.push(ctx.payload as MemorySavedPayload)
    })

    const sid = "sid-bus-st"
    await memoryHandler(
      makeSaveCtx({
        body: "scratch one",
        attrs: { scope: "short-term" },
        env: { MINIMAL_AGENT_SESSION_ID: sid },
      }),
    )
    await Promise.resolve()

    expect(events[0]?.scope).toBe("short-term")
    expect(events[0]?.id).toBe("1")

    bus.dispose()
  })

  it("includes evicted count when short-term overflows the cap", async () => {
    const bus = new EventBus()
    setGlobalEventBus(bus)
    const events: MemorySavedPayload[] = []
    bus.on(MEMORY_SAVED, (ctx) => events.push(ctx.payload as MemorySavedPayload))

    const sid = "sid-evict"
    const env = { MINIMAL_AGENT_SESSION_ID: sid }
    const { SHORT_TERM_CAP } = await import("../lib/store.ts")

    for (let i = 1; i <= SHORT_TERM_CAP; i++) {
      await memoryHandler(
        makeSaveCtx({ body: `e${i}`, attrs: { scope: "short-term" }, env }),
      )
    }
    await Promise.resolve()
    // Up to the cap, no eviction.
    expect(events.every((e) => !e.evicted)).toBe(true)

    // One more — triggers eviction.
    await memoryHandler(
      makeSaveCtx({ body: "overflow", attrs: { scope: "short-term" }, env }),
    )
    await Promise.resolve()
    const last = events[events.length - 1]
    expect(last?.evicted).toBe(1)

    bus.dispose()
  })

  it("does NOT emit when the save was refused (no sid, packageDir, etc.)", async () => {
    const bus = new EventBus()
    setGlobalEventBus(bus)
    const events: MemorySavedPayload[] = []
    bus.on(MEMORY_SAVED, (ctx) => events.push(ctx.payload as MemorySavedPayload))

    // Refused: short-term without sid.
    await memoryHandler(makeSaveCtx({ body: "x", attrs: { scope: "short-term" } }))
    await Promise.resolve()
    expect(events.length).toBe(0)

    bus.dispose()
  })

  it("absent global bus is fine (save still happens, no throw)", async () => {
    setGlobalEventBus(null)
    const res = await memoryHandler(makeSaveCtx({ body: "no bus", cwd: "/p" }))
    expect(res.kind).toBe("rendered")
    if (res.kind !== "rendered") throw new Error("unreachable")
    expect(res.ansi).toContain("[project#")
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
    log: makeNoopLogger(),
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

  it("loads legacy and v0.3 (id+timestamped) bullets together verbatim", async () => {
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(
      gp,
      "- legacy bullet, no timestamp\n" +
        "- [#abc-1234] [2026-05-05T21:06:20-04:00] new bullet\n",
    )

    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).toContain("- legacy bullet, no timestamp")
    expect(out).toContain("- [#abc-1234] [2026-05-05T21:06:20-04:00] new bullet")
  })

  it("trims surrounding whitespace from file contents", async () => {
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(gp, "\n\n\n- only\n\n\n\n")
    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).not.toMatch(/\n\n\n\n/)
    expect(out).toContain("- only")
  })

  it("includes a freshness disclaimer pointing at MemoryTool list", async () => {
    // Regression guard: the snapshot is captured at session start and
    // doesn't live-refresh, so the section must tell the model how to
    // get the current state mid-session. Without this disclaimer the
    // model will recite the (possibly stale) snapshot when asked
    // "what do you remember?" — a real failure mode observed in dev.
    const gp = globalMemoryPath(tmpHome)
    require("node:fs").mkdirSync(require("node:path").dirname(gp), {
      recursive: true,
    })
    writeFileSync(gp, "- a\n")
    const out = await loadMemories(makeLoadCtx("/p"))
    expect(out).toContain("Snapshot taken at session start")
    expect(out).toContain("MemoryTool")
    expect(out).toContain("\"list\"")
  })
})

// ---------------------------------------------------------------------------
// End-to-end via PluginLoader
// ---------------------------------------------------------------------------

describe("memory: integration with PluginLoader", () => {
  it("loads the memory plugin and embeds saved memories into the prompt block", async () => {
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

  it("loader threads its sessionId into the saved bullet", async () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })

    const cwd = process.cwd()
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "project" },
        body: "stamped from loader",
        self_closing: false,
      },
      cwd,
    )

    const path = projectMemoryPath(cwd, tmpHome)
    expect(readFileSync(path, "utf-8")).toMatch(
      new RegExp(
        "^- \\[#" + ID_RE + "\\] \\[" + TS_RE + "\\] \\[session:" + sid +
          "\\] stamped from loader\\n$",
      ),
    )
  })

  it("save handler dispatched through scanner writes to the right file", async () => {
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    })

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
      new RegExp("^" + PREFIX + "integration save test\\n$"),
    )
  })

  it("end-to-end: SaveEchoCollector attached to loader.bus() picks up dispatched save and renders <memory-saved>", async () => {
    // The full closing-the-loop flow as wired in `src/index.ts`:
    //
    //   1. Loader is constructed.
    //   2. setGlobalEventBus(loader.bus()) — so `getGlobalEventBus()` from
    //      inside the handler resolves to the same bus.
    //   3. SaveEchoCollector.attach(loader.bus()) — subscribes to MEMORY_SAVED.
    //   4. A `<tui::memory>` tag is dispatched through the loader.
    //   5. The collector should now have a queued ContentBlock the agent
    //      would prepend to the next user turn.
    const sid = "11111111-2222-3333-4444-555555555555"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    setGlobalEventBus(loader.bus())
    const { SaveEchoCollector } = await import("../lib/save-echo.ts")
    const collector = SaveEchoCollector.attach(loader.bus())

    // Dispatch a short-term save. The handler emits memory.saved on the
    // global bus (= loader.bus()), which the collector buffers.
    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "short-term" },
        body: "active hypothesis: width 80",
        self_closing: false,
      },
      process.cwd(),
    )
    // Bus dispatches via queueMicrotask — wait one tick.
    await Promise.resolve()

    // Drain — exactly one block, with the expected <memory-saved> shape.
    const blocks = collector.consumeAll()
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.type).toBe("text")
    if (blocks[0]?.type === "text") {
      expect(blocks[0].text).toContain('scope="short-term"')
      expect(blocks[0].text).toContain('id="1"')
      expect(blocks[0].text).toContain("active hypothesis: width 80")
    }

    // Idempotent: second drain returns nothing.
    expect(collector.consumeAll().length).toBe(0)

    collector.detach()
  })

  it("end-to-end: dispatched short-term save emits memory.saved on the loader's bus", async () => {
    const sid = "55555555-6666-7777-8888-999999999999"
    const loader = await PluginLoader.load({
      embeddedDir: PROJECT_ROOT,
      coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
      sessionId: sid,
    })
    setGlobalEventBus(loader.bus())

    const events: MemorySavedPayload[] = []
    loader.bus().on(MEMORY_SAVED, (ctx) =>
      events.push(ctx.payload as MemorySavedPayload),
    )

    await loader.dispatch(
      {
        type: "inline_tag",
        name: "memory",
        attrs: { scope: "short-term" },
        body: "scratch via loader",
        self_closing: false,
      },
      process.cwd(),
    )
    await Promise.resolve()

    expect(events.length).toBe(1)
    expect(events[0]?.scope).toBe("short-term")
    expect(events[0]?.id).toBe("1")
    expect(events[0]?.body).toBe("scratch via loader")
  })
})

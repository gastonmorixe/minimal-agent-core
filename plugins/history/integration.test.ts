/**
 * End-to-end integration: PluginLoader + history plugin + bus.
 *
 * Validates:
 *  - The manifest parses and the plugin is discovered.
 *  - `prompt.submitted` lands an entry on disk + in the recall.
 *  - `editor.key {ArrowUp}` returns the most recent entry via
 *    `payload.result.buffer`.
 *  - Edits → next ↑ is a pass-through (`result.halt` left false).
 *  - cwd-row-aware "steal only at top" gate (cursor in the middle of a
 *    multi-line buffer does NOT steal).
 *  - Disable env var fully short-circuits writes AND recall.
 *
 * Tests are isolated via `MINIMAL_AGENT_HISTORY_NAMESPACE`. Recall
 * cache is reset between tests so each starts fresh.
 */

import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { PluginLoader } from "../../src/plugins/loader.ts"

import { _resetSessionCache } from "./lib/session.ts"
import {
  _clearAll,
  HISTORY_DISABLE_ENV,
  HISTORY_NAMESPACE_ENV,
  loadEntries,
  projectHistoryPath,
} from "./lib/store.ts"

const NS = `history-integration-${process.pid}`
const TEST_HOME = join(tmpdir(), `minimal-agent-history-integ-${process.pid}`)
const ORIGINAL_HOME = process.env.HOME

// The handlers index by `process.cwd()` (the agent's working directory).
// We use the SAME real cwd for both writes and reads so the test
// matches production. The namespace env var rebases the data files
// under TEST_HOME, so the project tree is never touched.
const TEST_CWD = process.cwd()

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
  _resetSessionCache()
  delete process.env[HISTORY_DISABLE_ENV]
})

const CORE = new Set(["Bash", "Read", "Write", "Edit", "Grep", "Glob"])
const EMBEDDED = import.meta.dir + "/../.."

async function load() {
  return PluginLoader.load({
    embeddedDir: EMBEDDED,
    // Make sure the loader doesn't ALSO discover this same plugin via
    // homeDir or projectDir (precedence-collision logs muddy the test
    // output). Point at tmp dirs that don't exist.
    homeDir: join(tmpdir(), `__history-noexist-home-${process.pid}`),
    projectDir: join(tmpdir(), `__history-noexist-proj-${process.pid}`),
    coreToolNames: CORE,
    logger: () => {},
  })
}

/**
 * Build the broadcast-sync payload shape that the editor emits.
 * Mirrors `EditorKeyPayload` from `src/editor-controller.ts`.
 */
function keyPayload(opts: {
  key: string
  buffer?: string
  row?: number
  col?: number
  visualRow?: number
  rowsInLogicalLine?: number
  totalLines?: number
}) {
  return {
    key: opts.key,
    buffer: opts.buffer ?? "",
    cursor: {
      row: opts.row ?? 0,
      col: opts.col ?? 0,
      visualRow: opts.visualRow ?? 0,
      rowsInLogicalLine: opts.rowsInLogicalLine ?? 1,
      totalLines: opts.totalLines ?? 1,
    },
    result: {} as { halt?: boolean; buffer?: string; cursor?: { row: number; col: number } },
  }
}

describe("history plugin / discovery", () => {
  it("loads via PluginLoader and registers prompt.submitted + editor.key", async () => {
    const loader = await load()
    const events = loader.getEventSubs().filter((s) => s.pluginId === "history")
    const hooks = loader.getHookSubs().filter((s) => s.pluginId === "history")
    expect(events.length).toBe(1)
    expect(events[0].sub.definition.on).toBe("prompt.submitted")
    expect(hooks.length).toBe(1)
    expect(hooks[0].sub.definition.channel).toBe("editor.key")
  })
})

describe("history plugin / end-to-end", () => {
  it("emit prompt.submitted → entry lands on disk", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    loader.bus().emit("prompt.submitted", {
      text: "first prompt",
      cwd,
      sid: "sid-X",
      exit: "submitted",
    })
    // The bus is microtask-deferred — let it flush.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const p = projectHistoryPath(cwd)
    expect(existsSync(p)).toBe(true)
    const loaded = loadEntries(p)
    expect(loaded.length).toBe(1)
    expect(loaded[0].text).toBe("first prompt")
    expect(loaded[0].sid).toBe("sid-X")
  })

  it("↑ from empty buffer recalls most recent entry from disk", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    // Seed with two submits.
    for (const text of ["alpha", "beta"]) {
      loader.bus().emit("prompt.submitted", { text, cwd, sid: null, exit: "submitted" })
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const p = keyPayload({ key: "ArrowUp" })
    loader.hooks().emitSync("editor.key", p)
    expect(p.result.halt).toBe(true)
    expect(p.result.buffer).toBe("beta")
    // ↑ again walks older.
    const p2 = keyPayload({ key: "ArrowUp", buffer: "beta" })
    loader.hooks().emitSync("editor.key", p2)
    expect(p2.result.halt).toBe(true)
    expect(p2.result.buffer).toBe("alpha")
  })

  it("↑ in the MIDDLE of a multi-line buffer does NOT steal (pass-through)", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    loader.bus().emit("prompt.submitted", { text: "older", cwd, sid: null, exit: "submitted" })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // Cursor on line 1 of a 3-line buffer.
    const p = keyPayload({
      key: "ArrowUp",
      buffer: "line0\nline1\nline2",
      row: 1,
      col: 3,
      totalLines: 3,
    })
    loader.hooks().emitSync("editor.key", p)
    expect(p.result.halt).toBeUndefined() // not set = pass-through
    expect(p.result.buffer).toBeUndefined()
  })

  it("↓ overshoot past newest restores empty draft and resets", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    loader.bus().emit("prompt.submitted", { text: "only", cwd, sid: null, exit: "submitted" })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // ↑ to load "only"
    const up = keyPayload({ key: "ArrowUp" })
    loader.hooks().emitSync("editor.key", up)
    expect(up.result.buffer).toBe("only")
    // ↓ on the bottom row of "only" (single-line buffer)
    const down = keyPayload({
      key: "ArrowDown",
      buffer: "only",
      row: 0,
      col: 4,
      totalLines: 1,
    })
    loader.hooks().emitSync("editor.key", down)
    expect(down.result.halt).toBe(true)
    expect(down.result.buffer).toBe("") // overshoot restores empty draft
  })

  it("editing a recalled entry then pressing ↑ → pass-through (EDITED state)", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    for (const text of ["a", "b"]) {
      loader.bus().emit("prompt.submitted", { text, cwd, sid: null, exit: "submitted" })
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // ↑ → "b"
    const up = keyPayload({ key: "ArrowUp" })
    loader.hooks().emitSync("editor.key", up)
    expect(up.result.buffer).toBe("b")
    // User edits the recalled buffer to "b — edited" and presses ↑ again.
    const up2 = keyPayload({ key: "ArrowUp", buffer: "b — edited", col: 10 })
    loader.hooks().emitSync("editor.key", up2)
    expect(up2.result.halt).toBeUndefined() // pass-through
  })

  it("polite-listener: ArrowUp with result.halt already set bails before recall (no buffer overwrite)", async () => {
    // Regression for the slash-menu vs history clash discovered May 2026:
    // ma-slash-menu sets `result.halt = true` on ArrowUp to navigate its
    // own menu. Before the polite-listener fix, history STILL recalled
    // and overwrote `result.buffer`, closing the menu and disrupting
    // user intent. The fix: history checks `result.halt` and bails if
    // an upstream listener already claimed the key.
    const loader = await load()
    const cwd = TEST_CWD
    // Seed an entry so a recall would succeed if it got past the gate.
    loader
      .bus()
      .emit("prompt.submitted", { text: "would-be-recalled", cwd, sid: null, exit: "submitted" })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    // Simulate the upstream listener having already halted.
    const p = keyPayload({ key: "ArrowUp" })
    p.result.halt = true
    loader.hooks().emitSync("editor.key", p)
    // Halt stays true (history didn't touch it) AND buffer untouched.
    expect(p.result.halt).toBe(true)
    expect(p.result.buffer).toBeUndefined()
    expect(p.result.cursor).toBeUndefined()
  })

  it("polite-listener: ArrowDown with result.halt already set also bails", async () => {
    const loader = await load()
    const cwd = TEST_CWD
    loader
      .bus()
      .emit("prompt.submitted", { text: "would-be-recalled", cwd, sid: null, exit: "submitted" })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const p = keyPayload({
      key: "ArrowDown",
      buffer: "would-be-recalled",
      row: 0,
      col: 17,
      totalLines: 1,
    })
    p.result.halt = true
    loader.hooks().emitSync("editor.key", p)
    expect(p.result.halt).toBe(true)
    expect(p.result.buffer).toBeUndefined()
  })

  it("Ctrl+R is silently consumed (no-op halt) in v0.1", async () => {
    const loader = await load()
    const p = keyPayload({ key: "Ctrl+R" })
    loader.hooks().emitSync("editor.key", p)
    expect(p.result.halt).toBe(true)
    expect(p.result.buffer).toBeUndefined()
  })

  it("MINIMAL_AGENT_NO_HISTORY=1 disables writes AND ↑/↓ steal", async () => {
    process.env[HISTORY_DISABLE_ENV] = "1"
    const loader = await load()
    const cwd = TEST_CWD
    loader.bus().emit("prompt.submitted", { text: "blocked", cwd, sid: null, exit: "submitted" })
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    const p = projectHistoryPath(cwd)
    expect(existsSync(p)).toBe(false) // nothing written
    const up = keyPayload({ key: "ArrowUp" })
    loader.hooks().emitSync("editor.key", up)
    expect(up.result.halt).toBeUndefined() // pass-through
  })

  it("Ctrl+R is also gated on the disable flag", async () => {
    process.env[HISTORY_DISABLE_ENV] = "1"
    const loader = await load()
    const p = keyPayload({ key: "Ctrl+R" })
    loader.hooks().emitSync("editor.key", p)
    expect(p.result.halt).toBeUndefined()
  })
})

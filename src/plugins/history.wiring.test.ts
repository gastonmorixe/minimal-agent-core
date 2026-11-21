/**
 * Core-side wiring test for the (migrated) history plugin.
 *
 * The history plugin now lives in the sibling `../minimal-agent-plugins/`
 * repo. This test asserts the CORE loader's legitimate concern: that it
 * DISCOVERS the plugin from the sibling root and DISPATCHES bus/hook events
 * to its handlers. It does NOT reach into the plugin's own store internals —
 * the persistence + recall-state-machine round-trips are the PLUGIN's concern
 * and are covered by its own `lib/store.test.ts` + `lib/recall.test.ts` (which
 * moved with it). See the Wave-G test-topology decision: split by who owns
 * the invariant (core = dispatch, plugin = persistence), so no test spans the
 * repo boundary the migration is severing.
 *
 * Dispatch is asserted via an OBSERVABLE EFFECT (the recall handler sets
 * `result.halt` on an `editor.key` payload after a submit), never by reading
 * the plugin's disk artifact.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  SIBLING_REPO_ROOT as SIBLING_ROOT,
  siblingPluginPresent,
} from "../test-utils/sibling-repo.ts"

import { PluginLoader } from "./loader.ts"

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..")
const CORE = new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"])

// Rebase history's data files under a throwaway home so the real project
// tree is never touched, and reads/writes stay hermetic.
const TEST_HOME = mkdtempSync(join(tmpdir(), "history-wiring-"))
const NS = `history-wiring-${process.pid}`
const TEST_CWD = process.cwd()

const savedEnv: Record<string, string | undefined> = {}
function setEnv(k: string, v: string | undefined): void {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(() => {
  setEnv("MINIMAL_AGENT_HOME", TEST_HOME)
  setEnv("MINIMAL_AGENT_HISTORY_NAMESPACE", NS)
  setEnv("MINIMAL_AGENT_NO_HISTORY", undefined)
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) setEnv(k, v)
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
})
afterAll(() => rmSync(TEST_HOME, { recursive: true, force: true }))

async function load(): Promise<PluginLoader> {
  return PluginLoader.load({
    embeddedDir: PROJECT_ROOT,
    // Point user/project discovery at non-existent tmp dirs so the loader
    // doesn't ALSO find history via those roots (precedence-collision noise).
    userDir: join(tmpdir(), `__history-noexist-user-${process.pid}`),
    roots: {
      embedded: [SIBLING_ROOT],
      project: [join(tmpdir(), `__history-noexist-proj-${process.pid}`, ".agents", "plugins")],
    },
    coreToolNames: CORE,
    logger: () => {},
  })
}

function keyPayload(
  key: string,
  buffer = "",
): {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow: number
    rowsInLogicalLine: number
    totalLines: number
  }
  result: { halt?: boolean; buffer?: string; cursor?: { row: number; col: number } }
} {
  return {
    key,
    buffer,
    cursor: { row: 0, col: 0, visualRow: 0, rowsInLogicalLine: 1, totalLines: 1 },
    result: {},
  }
}

// The history plugin lives in the sibling plugins repo. On a bare core
// checkout (core CI) it is absent, so the suite skips (see sibling-repo.ts).
describe.skipIf(!siblingPluginPresent("ma-history-plugin"))(
  "history plugin / core loader wiring (Wave G)",
  () => {
    it("the loader discovers history from the sibling and registers its subs", async () => {
      const loader = await load()
      const events = loader.getEventSubs().filter((s) => s.pluginId === "history")
      const hooks = loader.getHookSubs().filter((s) => s.pluginId === "history")
      expect(events.length).toBe(1)
      expect(events[0].sub.definition.on).toBe("editor.submitted")
      expect(hooks.length).toBe(1)
      expect(hooks[0].sub.definition.channel).toBe("editor.key")
    })

    it("dispatches editor.submitted → editor.key recall (observable: result.halt set)", async () => {
      const loader = await load()
      loader.bus().emit("editor.submitted", {
        text: "wired-entry",
        cwd: TEST_CWD,
        sid: null,
        submittedAt: new Date().toISOString(),
      })
      await new Promise<void>((r) => setTimeout(r, 10))
      const up = keyPayload("ArrowUp")
      loader.hooks().emitSync("editor.key", up)
      // Observable effect of the handler running: the recall stole the key and
      // filled the buffer with the just-submitted entry. No plugin internals read.
      expect(up.result.halt).toBe(true)
      expect(up.result.buffer).toBe("wired-entry")
    })

    it("a queued prompt.submitted (inject) never lands in history", async () => {
      // Hermetic namespace for this case: no entry from a previous test.
      const ns = `${NS}-inject`
      setEnv("MINIMAL_AGENT_HISTORY_NAMESPACE", ns)
      // The plugin caches one recall per cwd for the process: drop it so an
      // entry from a previous test cannot leak into this one. The loader
      // imports the plugin from the same disk path, so this is one module.
      const session = (await import(
        join(SIBLING_ROOT, "ma-history-plugin", "lib", "session.ts")
      )) as { _resetSessionCache?: (cwd?: string) => void }
      session._resetSessionCache?.()
      const loader = await load()
      loader.bus().emit("editor.submitted", {
        text: "typed-x",
        cwd: TEST_CWD,
        sid: null,
        submittedAt: new Date().toISOString(),
      })
      loader.bus().emit("prompt.submitted", {
        text: "injected-y",
        cwd: TEST_CWD,
        sid: null,
        exit: "submitted",
        queuePos: 0,
        source: "inject",
      })
      await new Promise<void>((r) => setTimeout(r, 10))
      const up = keyPayload("ArrowUp")
      loader.hooks().emitSync("editor.key", up)
      expect(up.result.halt).toBe(true)
      expect(up.result.buffer).toBe("typed-x")
      // The on-disk history (global + per-project files) has the typed entry
      // and no injected text.
      const nsDir = join(TEST_HOME, "namespaces", ns)
      const files = readdirSync(nsDir, { recursive: true, encoding: "utf-8" })
        .filter((f) => f.endsWith("history.jsonl"))
        .map((f) => readFileSync(join(nsDir, f), "utf-8"))
      expect(files.length).toBeGreaterThan(0)
      expect(files.some((t) => t.includes("typed-x"))).toBe(true)
      for (const t of files) expect(t).not.toContain("injected-y")
    })

    it("MINIMAL_AGENT_NO_HISTORY=1 gates dispatch (recall is a pass-through)", async () => {
      setEnv("MINIMAL_AGENT_NO_HISTORY", "1")
      const loader = await load()
      loader.bus().emit("editor.submitted", {
        text: "blocked",
        cwd: TEST_CWD,
        sid: null,
        submittedAt: new Date().toISOString(),
      })
      await new Promise<void>((r) => setTimeout(r, 10))
      const up = keyPayload("ArrowUp")
      loader.hooks().emitSync("editor.key", up)
      expect(up.result.halt).toBeUndefined()
    })
  },
)

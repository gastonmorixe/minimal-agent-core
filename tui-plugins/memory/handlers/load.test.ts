/**
 * Tests for the summary-aware injection path in {@link loadMemories}.
 *
 * Legacy verbatim-injection tests already live in `memory.test.ts`
 * (which covers default behavior — config disabled, no summary
 * artifacts). This file covers the new opt-in summary path.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PromptFragmentContext } from "../../../src/plugins/types.ts"
import {
  DEFAULT_MEMORY_SUMMARY_CONFIG,
  type MemorySummaryConfig,
} from "../lib/memory-config.ts"
import type { refreshAndRender } from "../lib/summary-refresh.ts"

import loadMemories from "./load.ts"

const tempDirs: string[] = []
function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "load-handler-test-"))
  tempDirs.push(d)
  return d
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const d = tempDirs.pop()
    if (d) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {}
    }
  }
})

function makeCtx(home: string, cwd: string): PromptFragmentContext {
  const noop = () => {}
  return {
    packageDir: "/fake/plugin",
    cwd,
    env: { HOME: home, MINIMAL_AGENT_MEMORY_NAMESPACE: "loadtest" },
    sessionId: "test-session",
    abort: new AbortController().signal,
    stderr: process.stderr as NodeJS.WriteStream,
    log: {
      emergency: noop,
      alert: noop,
      critical: noop,
      error: noop,
      warn: noop,
      notice: noop,
      info: noop,
      debug: noop,
    },
  }
}

/**
 * Prime the file layout under `<home>/.minimal-agent/namespaces/loadtest/...`
 * — matches what `globalMemoryPath` / `projectMemoryPath` resolve to when
 * `MINIMAL_AGENT_MEMORY_NAMESPACE=loadtest` is set in the env.
 *
 * We use a namespace so the helper paths don't accidentally touch the
 * user's real memory files. The namespace env var is read at every path
 * resolution (per `store.ts`), so setting it via `process.env` before
 * each test is sufficient.
 */
function primeNamespaced(home: string, cwd: string, opts: { global?: string; project?: string }) {
  process.env.HOME = home
  const ns = "loadtest"
  if (opts.global !== undefined) {
    const dir = join(home, ".minimal-agent", "namespaces", ns)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "memory.md"), opts.global)
  }
  if (opts.project !== undefined) {
    const rel = cwd.replace(/^\/+/, "")
    const dir = join(home, ".minimal-agent", "namespaces", ns, "projects", rel)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "memory.md"), opts.project)
  }
}

const ORIGINAL_NAMESPACE = process.env.MINIMAL_AGENT_MEMORY_NAMESPACE
const ORIGINAL_HOME = process.env.HOME

afterEach(() => {
  if (ORIGINAL_NAMESPACE === undefined) {
    delete process.env.MINIMAL_AGENT_MEMORY_NAMESPACE
  } else {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = ORIGINAL_NAMESPACE
  }
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
})

const enabledCfg: MemorySummaryConfig = {
  ...DEFAULT_MEMORY_SUMMARY_CONFIG,
  enabled: true,
  minBullets: 5,
  minBytes: 100,
  dirtyBullets: 2,
}

const disabledCfg: MemorySummaryConfig = { ...DEFAULT_MEMORY_SUMMARY_CONFIG, enabled: false }

describe("loadMemories — summary disabled (legacy path)", () => {
  it("does NOT invoke refreshAndRender when config is disabled", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- legacy global bullet" })
    let called = false
    const fakeRefresh: typeof refreshAndRender = async () => {
      called = true
      return { text: "should not be used", regenerated: false, reason: "n/a" }
    }
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => disabledCfg,
      refresh: fakeRefresh,
    })
    expect(called).toBe(false)
    expect(out).toContain("- legacy global bullet")
    // No summary-mode explanatory header.
    expect(out).not.toContain("CONDENSED summary")
  })

  it("emits empty string when no memory files exist (regardless of config)", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => enabledCfg,
      refresh: async () => ({ text: "", regenerated: false, reason: "no-memory-file" }),
    })
    expect(out).toBe("")
  })
})

describe("loadMemories — summary enabled", () => {
  it("invokes refreshAndRender with the right per-scope args", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- global bullet", project: "- project bullet" })
    const calls: Array<{ scope: string; memoryPath: string; summaryPath: string }> = []
    const fakeRefresh: typeof refreshAndRender = async (opts) => {
      calls.push({
        scope: opts.scope,
        memoryPath: opts.memoryPath,
        summaryPath: opts.summaryPath,
      })
      return {
        text: `summary for ${opts.scope}`,
        regenerated: false,
        reason: "fresh",
      }
    }
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => enabledCfg,
      refresh: fakeRefresh,
    })
    expect(calls.length).toBe(2)
    expect(calls[0].scope).toBe("global")
    expect(calls[0].memoryPath).toMatch(/memory\.md$/)
    expect(calls[0].summaryPath).toMatch(/memory\.summary\.md$/)
    expect(calls[1].scope).toBe("project")
    expect(out).toContain("### Global")
    expect(out).toContain("summary for global")
    expect(out).toContain("### Project")
    expect(out).toContain("summary for project")
  })

  it("includes the summary-mode explanatory header when enabled", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- bullet" })
    const fakeRefresh: typeof refreshAndRender = async () => ({
      text: "## Cluster\n- t. Sources: #a",
      regenerated: false,
      reason: "fresh",
    })
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => enabledCfg,
      refresh: fakeRefresh,
    })
    expect(out).toContain("CONDENSED summary")
    expect(out).toContain('MemoryTool({action: "read"')
  })

  it("omits scopes whose refreshAndRender returns empty text", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { project: "- only project" })
    const fakeRefresh: typeof refreshAndRender = async (opts) => {
      if (opts.scope === "global") {
        return { text: "", regenerated: false, reason: "no-memory-file" }
      }
      return {
        text: "summary for project",
        regenerated: false,
        reason: "fresh",
      }
    }
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => enabledCfg,
      refresh: fakeRefresh,
    })
    expect(out).not.toContain("### Global")
    expect(out).toContain("### Project")
    expect(out).toContain("summary for project")
  })

  it("returns empty string when both scopes are absent", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    // No primeNamespaced — both files absent.
    const fakeRefresh: typeof refreshAndRender = async () => ({
      text: "",
      regenerated: false,
      reason: "no-memory-file",
    })
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => enabledCfg,
      refresh: fakeRefresh,
    })
    expect(out).toBe("")
  })
})

/**
 * Tests for the inject-mode strategy switch in {@link loadMemories}.
 *
 * Coverage:
 *   - inject="none" (default) → empty string, no file reads, no refresh
 *   - inject="verbatim"       → full memory.md formatted under section header
 *   - inject="summary"        → calls refreshAndRender, surfaces its result
 *
 * Legacy verbatim-mode tests with file-on-disk fixtures live in
 * `memory.test.ts` ("memory: load fragment" describe block). This file
 * focuses on the strategy dispatch + summary branch.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { PromptFragmentContext } from "@minimal-agent/plugin-api/types/plugin"

import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../lib/memory-config.ts"
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
 *: matches what `globalMemoryPath` / `projectMemoryPath` resolve to when
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
const ORIGINAL_MA_HOME = process.env.MINIMAL_AGENT_HOME

beforeEach(() => {
  // These tests redirect the data tree via `process.env.HOME`. An
  // inherited MINIMAL_AGENT_HOME (the harness exports one) would win
  // over HOME in the store's home resolver and route reads at the
  // user's real ~/.minimal-agent, so clear it for the duration.
  delete process.env.MINIMAL_AGENT_HOME
})

afterEach(() => {
  if (ORIGINAL_NAMESPACE === undefined) {
    delete process.env.MINIMAL_AGENT_MEMORY_NAMESPACE
  } else {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = ORIGINAL_NAMESPACE
  }
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_MA_HOME === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = ORIGINAL_MA_HOME
})

/** Build a config with the given inject mode + summary defaults. */
function cfgWith(inject: MemoryConfig["inject"]): MemoryConfig {
  return {
    ...DEFAULT_MEMORY_CONFIG,
    inject,
    summary: { ...DEFAULT_MEMORY_CONFIG.summary, minBullets: 5, minBytes: 100, dirtyBullets: 2 },
  }
}

// ---------------------------------------------------------------------------
// inject="none": default
// ---------------------------------------------------------------------------

describe("loadMemories: inject='none' (default)", () => {
  it("returns empty string even when memory files have content", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- global bullet", project: "- project bullet" })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("none"),
    })
    expect(out).toBe("")
  })

  it("does NOT invoke refreshAndRender in 'none' mode", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- bullet" })

    let called = false
    const fakeRefresh: typeof refreshAndRender = async () => {
      called = true
      return { text: "should not run", regenerated: false, reason: "n/a" }
    }
    await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("none"),
      refresh: fakeRefresh,
    })
    expect(called).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// inject="verbatim": legacy opt-in
// ---------------------------------------------------------------------------

describe("loadMemories: inject='verbatim'", () => {
  it("emits both scope sections when both files exist", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, {
      global: "- global bullet",
      project: "- project bullet",
    })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("verbatim"),
    })
    expect(out).toContain("## Saved memories")
    expect(out).toContain("### Global")
    expect(out).toContain("- global bullet")
    expect(out).toContain("### Project")
    expect(out).toContain("- project bullet")
  })

  it("includes the legacy freshness disclaimer", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- bullet" })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("verbatim"),
    })
    expect(out).toContain("Snapshot taken at session start")
    expect(out).toContain("MemoryTool")
  })

  it("does NOT include the summary-mode explanatory header", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- bullet" })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("verbatim"),
    })
    expect(out).not.toContain("CONDENSED summary")
  })

  it("returns empty string when both files are absent", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("verbatim"),
    })
    expect(out).toBe("")
  })
})

// ---------------------------------------------------------------------------
// inject="summary": opt-in (LLM-driven)
// ---------------------------------------------------------------------------

describe("loadMemories: inject='summary'", () => {
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
      loadConfig: () => cfgWith("summary"),
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

  it("includes the summary-mode explanatory header", async () => {
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
      loadConfig: () => cfgWith("summary"),
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
      loadConfig: () => cfgWith("summary"),
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
    // No primeNamespaced: both files absent.
    const fakeRefresh: typeof refreshAndRender = async () => ({
      text: "",
      regenerated: false,
      reason: "no-memory-file",
    })
    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("summary"),
      refresh: fakeRefresh,
    })
    expect(out).toBe("")
  })

  it("forwards the summary params slice to refreshAndRender", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "- bullet" })

    let seenCfg: unknown = null
    const fakeRefresh: typeof refreshAndRender = async (opts) => {
      seenCfg = opts.cfg
      return { text: "x", regenerated: false, reason: "fresh" }
    }
    const cfg = cfgWith("summary")
    await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfg,
      refresh: fakeRefresh,
    })
    // refreshAndRender should receive ONLY the summary sub-slice, not
    // the top-level config. Lets us refactor inject-mode independently.
    expect(seenCfg).toEqual(cfg.summary)
  })
})

// ---------------------------------------------------------------------------
// inject="latest": default (top-N injection, formatted as MemoryTool.list)
// ---------------------------------------------------------------------------

/** Helper: build properly-formatted bullet lines for memory file fixtures. */
function bulletLine(id: string, ts: string, body: string): string {
  return `- [#${id}] [${ts}] ${body}`
}

describe("loadMemories: inject='latest'", () => {
  it("injects both scopes formatted as MemoryTool.list output", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, {
      global: [
        bulletLine("g-001", "2026-06-20T10:00:00-04:00", "global bullet one"),
        bulletLine("g-002", "2026-06-20T11:00:00-04:00", "global bullet two"),
        bulletLine("g-003", "2026-06-20T12:00:00-04:00", "global bullet three"),
      ].join("\n"),
      project: [
        bulletLine("p-001", "2026-06-20T09:00:00-04:00", "project bullet one"),
        bulletLine("p-002", "2026-06-20T10:30:00-04:00", "project bullet two"),
      ].join("\n"),
    })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
    })

    expect(out).toContain("## Saved memories")
    expect(out).toContain("formatted as `MemoryTool.list` output")
    // Global scope: should show the header from formatList
    expect(out).toContain("### Global")
    expect(out).toContain("global (3 entries)")
    expect(out).toContain("#g-001")
    expect(out).toContain("global bullet one")
    expect(out).toContain("#g-003")
    expect(out).toContain("global bullet three")
    // Project scope
    expect(out).toContain("### Project")
    expect(out).toContain("project (2 entries)")
    expect(out).toContain("#p-001")
    expect(out).toContain("project bullet one")
  })

  it("omits empty scopes silently", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    // Only project has bullets; global file is absent.
    primeNamespaced(home, cwd, {
      project: bulletLine("p-001", "2026-06-20T10:00:00-04:00", "only project"),
    })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
    })

    expect(out).toContain("## Saved memories")
    expect(out).not.toContain("### Global")
    expect(out).toContain("### Project")
    expect(out).toContain("project (1 entry)")
    expect(out).toContain("#p-001")
  })

  it("returns empty string when both scopes are absent", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    // No primeNamespaced call — both files absent.

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
    })

    expect(out).toBe("")
  })

  it("returns empty string when both files exist but are empty", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: "", project: "" })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
    })

    expect(out).toBe("")
  })

  it("respects cfg.latest.top — shows only the N most-recent bullets", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    // 7 bullets, top=3 → only the 3 latest should appear.
    const bullets: string[] = []
    for (let i = 1; i <= 7; i++) {
      bullets.push(
        bulletLine(
          `g-${String(i).padStart(2, "0")}`,
          `2026-06-20T0${i}:00:00-04:00`,
          `bullet ${i}`,
        ),
      )
    }
    primeNamespaced(home, cwd, { global: bullets.join("\n") })

    const cfg = cfgWith("latest")
    cfg.latest.top = 3

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfg,
    })

    expect(out).toContain("global (showing 3 of 7 entries")
    // Should contain bullets 5, 6, 7 (the latest 3) but not 1-4.
    expect(out).toContain("bullet 5")
    expect(out).toContain("bullet 6")
    expect(out).toContain("bullet 7")
    expect(out).not.toContain("bullet 1")
    expect(out).not.toContain("bullet 2")
    expect(out).not.toContain("bullet 4")

    // Should NOT have a next-page hint when top >= total bullets.
    // (Here top=3 < total=7, so we do get the hint from formatList
    // because it only shows a subset. Actually formatList shows a hint when
    // nextOffset is set — which happens when there are more bullets beyond
    // the shown page. In this case we're not paginating through formatList,
    // we're just taking the last N and formatting them. So we need to check
    // what happens.)
    // When we pass total: 7 but only 3 bullets in the array, formatList
    // sees shown=3, total=7 and renders "showing 3 of 7 entries, offset 0"
    // and a next-page hint. This is correct — the model sees that there
    // are more entries it can query.
  })

  it("when top >= total bullets, shows all without pagination hint", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, {
      global: [
        bulletLine("g-001", "2026-06-20T10:00:00-04:00", "one"),
        bulletLine("g-002", "2026-06-20T11:00:00-04:00", "two"),
      ].join("\n"),
    })

    const cfg = cfgWith("latest")
    cfg.latest.top = 10 // way more than the 2 bullets that exist

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfg,
    })

    expect(out).toContain("global (2 entries)") // no "showing X of Y" — fits in one page
    expect(out).not.toContain("next: MemoryTool")
  })

  it("does NOT invoke refreshAndRender (summary is a separate mode)", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: bulletLine("g-001", "2026-06-20T10:00:00-04:00", "test") })

    let called = false
    const fakeRefresh: typeof refreshAndRender = async () => {
      called = true
      return { text: "should not run", regenerated: false, reason: "n/a" }
    }
    await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
      refresh: fakeRefresh,
    })
    expect(called).toBe(false)
  })

  it("includes the latest-mode framing (not summary or verbatim)", async () => {
    process.env.MINIMAL_AGENT_MEMORY_NAMESPACE = "loadtest"
    const home = makeTempDir()
    const cwd = "/Users/x/proj"
    primeNamespaced(home, cwd, { global: bulletLine("g-001", "2026-06-20T10:00:00-04:00", "test") })

    const out = await loadMemories(makeCtx(home, cwd), {
      loadConfig: () => cfgWith("latest"),
    })

    expect(out).toContain("formatted as `MemoryTool.list` output")
    expect(out).not.toContain("CONDENSED summary") // not summary mode
    expect(out).not.toContain("Snapshot taken at session start") // not verbatim mode
  })
})

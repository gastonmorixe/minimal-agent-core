/**
 * Load-integration: the real sub-agents manifest resolves through the host
 * PluginLoader — its 5 tools and the supervisor live-area slot are wired, and
 * the PROMPT.md contributes a system-prompt block. The plugin is symlinked
 * into a temp root so ONLY `sub-agents` loads.
 *
 * @module sub-agents/load.test
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { PluginLoader } from "../../src/plugins/loader.ts"

const roots: string[] = []
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
  roots.length = 0
})

async function loadSubAgents(): Promise<{ loader: PluginLoader; warnings: string[] }> {
  const root = mkdtempSync(join(tmpdir(), "ma-subagents-load-"))
  roots.push(root)
  mkdirSync(join(root, "plugins"), { recursive: true })
  symlinkSync(import.meta.dir, join(root, "plugins", "sub-agents"))
  const warnings: string[] = []
  const loader = await PluginLoader.load({
    embeddedDir: root,
    homeDir: root,
    projectDir: root,
    sessionId: "load-test",
    coreToolNames: new Set(["Bash", "Read", "Write", "Edit", "Glob", "Grep"]),
    logger: (m) => warnings.push(m),
  })
  return { loader, warnings }
}

describe("sub-agents manifest loads", () => {
  it("registers all five tools", async () => {
    const { loader } = await loadSubAgents()
    const names = loader.getExtraTools().map((t) => t.name)
    expect(names).toContain("SpawnAgent")
    expect(names).toContain("ListAgents")
    expect(names).toContain("AgentStatus")
    expect(names).toContain("AgentResult")
    expect(names).toContain("AgentOutput")
    expect(names).toContain("Mailbox")
    expect(names).toContain("StopAgent")
  })

  it("registers the supervisor live-area slot at 1s", async () => {
    const { loader } = await loadSubAgents()
    const slot = loader.getLiveAreaSlots().find((s) => s.definition.id === "fleet_supervisor")
    expect(slot).toBeDefined()
    expect(slot?.definition.refreshMs).toBe(1000)
  })

  it("contributes a system-prompt tool block and loads without warnings", async () => {
    const { loader, warnings } = await loadSubAgents()
    expect(warnings).toEqual([])
    const block = loader.getPromptBlock()
    expect(block).toContain("SpawnAgent")
  })

  it("dispatches SpawnAgent and surfaces a validation error for a missing task", async () => {
    const { loader } = await loadSubAgents()
    const res = await loader.dispatch(
      { type: "tool", name: "SpawnAgent", input: {}, tool_use_id: "t1" },
      process.cwd(),
    )
    expect(res.kind).toBe("tool_result")
    if (res.kind === "tool_result") {
      expect(res.is_error).toBe(true)
      expect(res.content).toMatch(/task/i)
    }
  })
})

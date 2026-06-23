/**
 * Load-integration: the real schedule manifest resolves through the host
 * PluginLoader — its 3 tools and the heartbeat slot are wired, the command
 * registry is empty until P5 adds /loop + /schedule.
 *
 * The plugin is symlinked into a temp root so ONLY `schedule` loads (and
 * its relative `import type ../../../src/plugins/types.ts` still resolves
 * via the symlink's real path).
 *
 * @module schedule/load.test
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

async function loadSchedule(): Promise<PluginLoader> {
  const root = mkdtempSync(join(tmpdir(), "ma-sched-load-"))
  roots.push(root)
  mkdirSync(join(root, "plugins"), { recursive: true })
  // import.meta.dir is the real plugins/schedule dir (where this test lives).
  symlinkSync(import.meta.dir, join(root, "plugins", "schedule"))
  return PluginLoader.load({
    embeddedDir: root,
    homeDir: root,
    projectDir: root,
    sessionId: "load-test",
    logger: () => {},
  })
}

describe("schedule manifest loads", () => {
  it("registers the three cron tools", async () => {
    const loader = await loadSchedule()
    const names = loader.getExtraTools().map((t) => t.name)
    expect(names).toContain("ScheduleCronCreate")
    expect(names).toContain("ScheduleCronList")
    expect(names).toContain("ScheduleCronDelete")
  })

  it("registers the heartbeat live-area slot", async () => {
    const loader = await loadSchedule()
    const slotIds = loader.getLiveAreaSlots().map((s) => s.definition.id)
    expect(slotIds).toContain("cron_heartbeat")
    const slot = loader.getLiveAreaSlots().find((s) => s.definition.id === "cron_heartbeat")
    expect(slot?.definition.refreshMs).toBe(1000)
  })

  it("contributes a PROMPT.md block", async () => {
    const loader = await loadSchedule()
    const block = loader.getPromptBlock()
    expect(block).not.toBeNull()
    expect(block).toContain("ScheduleCronCreate")
  })

  it("registers the /loop and /schedule commands", async () => {
    const loader = await loadSchedule()
    expect(loader.hasCommand("loop")).toBe(true)
    expect(loader.hasCommand("schedule")).toBe(true)
    const info = loader.listCommandInfo().map((c) => c.name)
    expect(info).toContain("loop")
    expect(info).toContain("schedule")
  })
})

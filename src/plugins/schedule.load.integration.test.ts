/**
 * Load-integration: the real schedule manifest resolves through the host
 * PluginLoader from its migrated home. Its 3 cron tools, the heartbeat
 * live-area slot, the PROMPT.md block, and the /loop + /schedule commands all
 * wire up through the loader's manifest path.
 *
 * Wave G: the schedule plugin moved to the sibling ../minimal-agent-plugins/
 * repo (ma-schedule-plugin), discovered via the loader's `siblingDirs` seam.
 * On a bare host checkout without the sibling, this suite skips cleanly.
 *
 * @module plugins/schedule.load.integration.test
 */

import { describe, expect, it } from "bun:test"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import { PluginLoader } from "./loader.ts"

const HAVE_SCHEDULE = siblingPluginPresent("ma-schedule-plugin")

async function loadSchedule(): Promise<PluginLoader> {
  return PluginLoader.load({
    embeddedDir: SIBLING_REPO_ROOT,
    siblingDirs: [SIBLING_REPO_ROOT],
    sessionId: "load-test",
    logger: () => {},
  })
}

describe.skipIf(!HAVE_SCHEDULE)("schedule manifest loads", () => {
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

/**
 * Load-integration: the real schedule manifest resolves through the host
 * PluginLoader from its migrated home. Its 3 cron tools, the heartbeat
 * live-area slot, the PROMPT.md block, and the /loop + /schedule commands all
 * wire up through the loader's manifest path.
 *
 * Wave G: the schedule plugin moved to the sibling ../minimal-agent-plugins/
 * repo (ma-schedule-plugin), passed to the loader as an embedded root.
 * On a bare host checkout without the sibling, this suite skips cleanly.
 *
 * @module plugins/schedule.load.integration.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import { PluginLoader } from "./loader.ts"

const HAVE_SCHEDULE = siblingPluginPresent("ma-schedule-plugin")

async function loadSchedule(): Promise<PluginLoader> {
  return PluginLoader.load({
    embeddedDir: SIBLING_REPO_ROOT,
    roots: { embedded: [SIBLING_REPO_ROOT] },
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

  it("keeps the heartbeat live-area slot in the ui part, which core does not load (S31)", async () => {
    const loader = await loadSchedule()
    const pkg = loader.loadedPackages().find((p) => p.id === "schedule")
    expect(pkg).toBeDefined()
    const raw = JSON.parse(readFileSync(join(pkg?.packageDir ?? "", "manifest.json"), "utf8"))
    const ui = raw.ui as { liveAreaSlots?: { id: string; refreshMs?: number }[] }
    const slot = ui.liveAreaSlots?.find((s) => s.id === "cron_heartbeat")
    expect(slot?.refreshMs).toBe(1000)
  })

  it("contributes a PROMPT.md block", async () => {
    const loader = await loadSchedule()
    const block = loader.getPromptBlock()
    expect(block).not.toBeNull()
    // The retained block names the companion tools and the disable switch.
    // The full tool names now live in the tool descriptions. The first test
    // in this file pins them.
    expect(block).toContain('<ma::sys::tool name="schedule">')
    expect(block).toContain("CronList")
    expect(block).toContain("CronDelete")
    expect(block).toContain("/loop")
    expect(block).toContain("MINIMAL_AGENT_DISABLE_CRON")
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

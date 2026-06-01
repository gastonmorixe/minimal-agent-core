/**
 * End-to-end integration: spawn a REAL child process (a fake worker that just
 * writes a result sentinel and exits — no network, no auth), then drive the
 * supervisor and prove the full loop: spawn → running handle → child exits →
 * supervisor reaps → `done` with the result + a between-turns digest.
 *
 * This covers the imperative shell (real Bun.spawn, real pid liveness, real
 * sentinel read) that the unit tests stub out.
 *
 * @module sub-agents/integration.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { ENV_RESULT_PATH, realProbeDeps, realSpawnDeps } from "./lib/spawn.ts"
import { type ServiceDeps, spawnAgent } from "./lib/service.ts"
import { SubagentStore } from "./lib/store.ts"
import { runSupervisor, type SupervisorDeps } from "./lib/supervisor-shell.ts"
import { sessionId } from "./lib/types.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"

let dir: string
let childScript: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagents-e2e-"))
  // A fake "worker": read the sentinel path from env, write a ResultDigest, exit 0.
  childScript = join(dir, "fake-worker.ts")
  writeFileSync(
    childScript,
    [
      "import { writeFileSync } from 'node:fs'",
      "const p = process.env." + ENV_RESULT_PATH,
      "if (p) writeFileSync(p, JSON.stringify({ short: 'fake worker did the thing', tokens: 1234, tools: 5, artifacts: ['out.txt'] }))",
      "process.exit(0)",
    ].join("\n"),
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function svcDeps(store: SubagentStore): ServiceDeps {
  return {
    store,
    spawnDeps: realSpawnDeps(),
    agentBin: [process.execPath, childScript], // run the fake worker, not real minimal-agent
    leadSid: sessionId(LEAD),
    depth: 0,
    cwd: dir,
    sessionsDir: dir,
    defaultModel: "claude-haiku-4-5",
    newSid: () => "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978",
    now: () => new Date(),
  }
}

function supDeps(
  store: SubagentStore,
  emitted: { channel: string; payload: unknown }[],
): SupervisorDeps {
  return {
    store,
    probeDeps: realProbeDeps(),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    kill: () => {},
    sessionsDir: dir,
    leadSid: LEAD,
    now: () => new Date(),
    tick: 0,
    ansi: false,
  }
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<void> {
  const probe = realProbeDeps()
  const start = Date.now()
  while (probe.pidAlive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`child ${pid} did not exit in ${timeoutMs}ms`)
    await Bun.sleep(15)
  }
}

describe("sub-agents end-to-end (real process, no network)", () => {
  it("spawns a real child, reaps it to done, reads the sentinel, injects a digest", async () => {
    const store = new SubagentStore(LEAD, { dir })

    // 1. Spawn — returns immediately with a running handle.
    const sp = spawnAgent({ task: "do the thing", label: "faker" }, svcDeps(store))
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    expect(sp.value.status.kind).toBe("running")
    const pid = sp.value.status.kind === "running" ? sp.value.status.pid : 0
    expect(pid).toBeGreaterThan(0)

    // 2. Wait for the real child process to finish writing its sentinel + exit.
    await waitForExit(pid)

    // 3. One supervisor pass reaps it.
    const emitted: { channel: string; payload: unknown }[] = []
    const widget = runSupervisor(supDeps(store, emitted))

    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("done")
    if (rec?.status.kind === "done") {
      expect(rec.status.result.short).toBe("fake worker did the thing")
      expect(rec.status.result.tokens).toBe(1234)
      expect(rec.status.result.tools).toBe(5)
      expect(rec.status.result.artifacts).toEqual(["out.txt"])
    }

    // 4. The lead gets a between-turns digest + lifecycle signals.
    const channels = emitted.map((e) => e.channel)
    expect(channels).toContain("subagent.didReport")
    expect(channels).toContain("prompt.inject")

    // 5. Fleet is now idle → the widget collapses.
    expect(widget).toBeNull()
  })

  it("reaps a child that exits WITHOUT a sentinel as done-with-placeholder", async () => {
    // Point the worker at a script that exits 0 but writes nothing.
    const noResultScript = join(dir, "no-result.ts")
    writeFileSync(noResultScript, "process.exit(0)")
    const store = new SubagentStore(LEAD, { dir })
    const deps = { ...svcDeps(store), agentBin: [process.execPath, noResultScript] }

    const sp = spawnAgent({ task: "do nothing" }, deps)
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    await waitForExit(sp.value.status.kind === "running" ? sp.value.status.pid : 0)

    runSupervisor(supDeps(store, []))
    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("done")
    if (rec?.status.kind === "done") expect(rec.status.result.short).toMatch(/no summary captured/i)
  })
})

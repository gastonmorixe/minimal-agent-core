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

import { type ServiceDeps, spawnAgent } from "./lib/service.ts"
import { ENV_RESULT_PATH, realProbeDeps, realSpawnDeps } from "./lib/spawn.ts"
import { SubagentStore } from "./lib/store.ts"
import { runSupervisor, type SupervisorDeps } from "./lib/supervisor-shell.ts"
import { sessionId } from "./lib/types.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"

let dir: string
let childScript: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "subagents-e2e-"))
  // A fake "worker": write its declared artifact, THEN write a ResultDigest
  // sentinel pointing at it (an honest worker — the artifact really exists), exit 0.
  childScript = join(dir, "fake-worker.ts")
  const artifactPath = join(dir, "out.txt")
  writeFileSync(
    childScript,
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(artifactPath)}, 'the deliverable')`,
      "const p = process.env." + ENV_RESULT_PATH,
      `if (p) writeFileSync(p, JSON.stringify({ short: 'fake worker did the thing', tokens: 1234, tools: 5, artifacts: [${JSON.stringify(artifactPath)}] }))`,
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
    if (Date.now() - start > timeoutMs)
      throw new Error(`child ${pid} did not exit in ${timeoutMs}ms`)
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
      // the declared artifact really exists, so NO ⚠ warning is prepended
      expect(rec.status.result.short).toBe("fake worker did the thing")
      expect(rec.status.result.tokens).toBe(1234)
      expect(rec.status.result.tools).toBe(5)
      expect(rec.status.result.artifacts).toEqual([join(dir, "out.txt")])
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
    // A clean exit with NO sentinel and NO distillable final text is INCOMPLETE,
    // never laundered into done. (A worker that writes a final message instead
    // is covered by the distillation test below.)
    expect(rec?.status.kind).toBe("incomplete")
    if (rec?.status.kind === "incomplete") expect(rec.status.reason).toMatch(/sentinel/i)
  })

  it("distills the final assistant message when a worker exits with NO sentinel but real output", async () => {
    // This worker writes NO result sentinel. Instead it appends an assistant
    // message to its own session transcript (like a real agent does) and exits.
    // The supervisor must distill that final text into a `done` result, NOT
    // mark it incomplete — this is the core Phase B behavior (the A3 case).
    const childSid = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"
    const transcriptPath = join(dir, `${childSid}.jsonl`)
    const distillScript = join(dir, "distill-worker.ts")
    writeFileSync(
      distillScript,
      [
        "import { writeFileSync } from 'node:fs'",
        // a minimal transcript with a final assistant text block, no sentinel
        `const line = ${JSON.stringify(
          JSON.stringify({
            kind: "assistant",
            content: [
              {
                type: "text",
                text: "SUMMARY: scanned the logs, found the smoking gun in session X.",
              },
            ],
            usage: { input_tokens: 800, output_tokens: 60 },
          }),
        )}`,
        `writeFileSync(${JSON.stringify(transcriptPath)}, line + "\\n")`,
        "process.exit(0)",
      ].join("\n"),
    )
    const store = new SubagentStore(LEAD, { dir })
    const deps = { ...svcDeps(store), agentBin: [process.execPath, distillScript] }

    const sp = spawnAgent({ task: "mine the logs" }, deps)
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    await waitForExit(sp.value.status.kind === "running" ? sp.value.status.pid : 0)

    runSupervisor(supDeps(store, []))
    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("done")
    if (rec?.status.kind === "done") {
      expect(rec.status.result.short).toMatch(/smoking gun/i)
      // flagged as distilled (no structured sentinel was written)
      expect(rec.status.result.distilled).toBe(true)
    }
  })

  it("enforces expectArtifacts: a worker that writes a sentinel but NOT the file is INCOMPLETE", async () => {
    // This worker writes a perfectly good result sentinel but never produces the
    // file the lead contracted for. The supervisor must override the sentinel and
    // mark it incomplete — the A3 case where a worker CLAIMS success with no file.
    const liarScript = join(dir, "liar-worker.ts")
    writeFileSync(
      liarScript,
      [
        "import { writeFileSync } from 'node:fs'",
        "const p = process.env." + ENV_RESULT_PATH,
        "if (p) writeFileSync(p, JSON.stringify({ short: 'all done!', tokens: 10, tools: 1 }))",
        "process.exit(0)",
      ].join("\n"),
    )
    const store = new SubagentStore(LEAD, { dir })
    const deps = { ...svcDeps(store), agentBin: [process.execPath, liarScript] }

    const missingPath = join(dir, "promised-findings.md")
    const sp = spawnAgent({ task: "produce findings", expectArtifacts: [missingPath] }, deps)
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    // the contract is persisted on the handle for the async probe
    expect(sp.value.expectArtifacts).toEqual([missingPath])
    await waitForExit(sp.value.status.kind === "running" ? sp.value.status.pid : 0)

    runSupervisor(supDeps(store, []))
    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("incomplete")
    if (rec?.status.kind === "incomplete") {
      expect(rec.status.reason).toMatch(/required artifact/i)
      expect(rec.status.reason).toContain("promised-findings.md")
    }
  })

  it("a worker that finishes via the ReportResult handler is reaped to done", async () => {
    // Instead of hand-writing the sentinel JSON, this fake worker calls the REAL
    // ReportResult handler (the completion tool), proving the tool-based path
    // writes a sentinel the supervisor reads. This is the real-enforcement fix:
    // the model only supplies findings; our handler writes the bytes.
    const handlerPath = join(import.meta.dir, "handlers", "report_result.ts")
    const toolWorker = join(dir, "tool-worker.ts")
    writeFileSync(
      toolWorker,
      [
        `import reportResult from ${JSON.stringify(handlerPath)}`,
        "const res = await reportResult({",
        "  trigger: { type: 'tool', name: 'ReportResult', input: { summary: 'handler-written result', artifacts: [] }, tool_use_id: 't' },",
        "  packageDir: '.', cwd: '.', env: process.env,",
        "  abort: new AbortController().signal,",
        "  stdout: process.stdout, stdin: process.stdin, stderr: process.stderr,",
        "} as never)",
        "process.exit(res && res.is_error ? 1 : 0)",
      ].join("\n"),
    )
    const store = new SubagentStore(LEAD, { dir })
    const deps = { ...svcDeps(store), agentBin: [process.execPath, toolWorker] }

    const sp = spawnAgent({ task: "use the tool" }, deps)
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    await waitForExit(sp.value.status.kind === "running" ? sp.value.status.pid : 0)

    runSupervisor(supDeps(store, []))
    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("done")
    if (rec?.status.kind === "done") {
      expect(rec.status.result.short).toBe("handler-written result")
      // a real structured sentinel, NOT a distilled fallback
      expect(rec.status.result.distilled).toBeUndefined()
    }
  })

  it("salvages a ReportResult summary onto incomplete when a required file is missing", async () => {
    // The worker reports real findings via ReportResult but never writes the
    // contracted file. The supervisor marks it incomplete (the file gate), yet
    // the findings survive as `salvage` so the lead need not mine the transcript.
    const handlerPath = join(import.meta.dir, "handlers", "report_result.ts")
    const partialWorker = join(dir, "partial-worker.ts")
    writeFileSync(
      partialWorker,
      [
        `import reportResult from ${JSON.stringify(handlerPath)}`,
        "await reportResult({",
        "  trigger: { type: 'tool', name: 'ReportResult', input: { summary: 'the codec ceiling is 4K60 on this chip' }, tool_use_id: 't' },",
        "  packageDir: '.', cwd: '.', env: process.env,",
        "  abort: new AbortController().signal,",
        "  stdout: process.stdout, stdin: process.stdin, stderr: process.stderr,",
        "} as never)",
        "process.exit(0)",
      ].join("\n"),
    )
    const store = new SubagentStore(LEAD, { dir })
    const deps = { ...svcDeps(store), agentBin: [process.execPath, partialWorker] }

    const missingPath = join(dir, "RESEARCH.md")
    const sp = spawnAgent({ task: "research the ceiling", expectArtifacts: [missingPath] }, deps)
    expect(sp.ok).toBe(true)
    if (!sp.ok) return
    await waitForExit(sp.value.status.kind === "running" ? sp.value.status.pid : 0)

    runSupervisor(supDeps(store, []))
    const rec = store.get(sp.value.id)
    expect(rec?.status.kind).toBe("incomplete")
    if (rec?.status.kind === "incomplete") {
      expect(rec.status.reason).toContain("RESEARCH.md")
      // the findings the worker reported survive the contract miss
      expect(rec.status.salvage).toMatch(/codec ceiling/i)
    }
  })
})

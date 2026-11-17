/**
 * The tool round runs the tool-result chain at five phase boundaries (spec
 * R-API-3). With no chain it is a no-op: the result bytes do not change.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { SidebandKind } from "../sideband/types.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { STAGE_FAILED, STAGE_TIMEOUT_MS, type ToolResultChainEntry } from "./tool-result-chain.ts"
import { applyChainPhase, type ChainVars } from "./tool-result-chain-glue.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

function readTool(): ToolUseBlock {
  const dir = mkdtempSync(join(tmpdir(), "ma-chain-wiring-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return { type: "tool_use", id: "tu_chain", name: "Read", input: { file_path: path } }
}

function entry(
  phase: ToolResultPhase,
  transform: (s: ToolResultStage) => ToolResultStage,
  pluginId = "p",
): ToolResultChainEntry {
  return { pluginId, decl: { phase, order: 0, transform } }
}

const registry = {
  kind: (name: string): SidebandKind | undefined =>
    name === "known" ? ({ name } as unknown as SidebandKind) : undefined,
}

describe("tool-result chain wiring", () => {
  test("no chain and empty chain give the same bytes", async () => {
    const tool = readTool()
    const a = await executeToolRound(tool, baseCtx())
    const b = await executeToolRound(tool, baseCtx({ toolResultChain: [] }))
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
    expect("sideband" in a).toBe(false)
  })

  test("a final stage changes the content", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: [entry("final", (s) => ({ ...s, content: `${s.content}X` }))],
      }),
    )
    expect(String(out.content).endsWith("X")).toBe(true)
    expect(String(out.content).length).toBe(String(base.content).length + 1)
  })

  test("a stage with a registered kind sets block.sideband", async () => {
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        toolResultChain: [entry("stamp", (s) => ({ ...s, kind: "known" }))],
      }),
    )
    expect(out.sideband).toEqual({ kind: "known" })
  })

  test("a stage with no kind leaves the block without a sideband key", async () => {
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        toolResultChain: [entry("stamp", (s) => ({ ...s, content: `${s.content}.` }))],
      }),
    )
    expect("sideband" in out).toBe(false)
  })

  test("an unregistered kind drops the field and emits a diagnostic", async () => {
    const seen: string[] = []
    const diagnostics = createDiagnostics({ emit: (e) => void seen.push(e.source) })
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        sidebandRegistry: registry,
        diagnostics,
        toolResultChain: [entry("stamp", (s) => ({ ...s, kind: "nope" }))],
      }),
    )
    expect("sideband" in out).toBe(false)
    expect(seen.some((s) => s.includes("tool-result-chain"))).toBe(true)
  })

  test("phases run in the fixed order", async () => {
    const order: string[] = []
    const phases: ToolResultPhase[] = ["stamp", "final", "post-blob", "pre-outcome", "clamp"]
    await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: phases.map((p) =>
          entry(p, (s) => {
            order.push(p)
            return s
          }),
        ),
      }),
    )
    expect(order).toEqual(["clamp", "pre-outcome", "post-blob", "final", "stamp"])
  })
})

type Warn = { source: string; data: unknown }

function warnSink(): { warns: Warn[]; diagnostics: ReturnType<typeof createDiagnostics> } {
  const warns: Warn[] = []
  const diagnostics = createDiagnostics({
    emit: (e) => void warns.push({ source: e.source, data: e.structuredData }),
  })
  return { warns, diagnostics }
}

describe("tool-round call site passes signal and diagnostics", () => {
  test("a turn abort stops a waiting stage, the input is kept, reason aborted", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const turn = new AbortController()
    const sink = warnSink()
    let seen: AbortSignal | undefined
    const hang: ToolResultChainEntry = {
      pluginId: "hang",
      decl: {
        phase: "stamp",
        order: 0,
        transform: (s, c) => {
          seen = c.signal
          setTimeout(() => turn.abort(), 5)
          return new Promise<ToolResultStage>((resolve) => {
            c.signal.addEventListener("abort", () => resolve({ ...s, content: "LATE" }))
          })
        },
      },
    }
    const t0 = Date.now()
    const out = await executeToolRound(
      readTool(),
      baseCtx({ signal: turn.signal, diagnostics: sink.diagnostics, toolResultChain: [hang] }),
    )
    expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
    expect(seen?.aborted).toBe(true)
    expect(out.content).toBe(base.content)
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "hang", phase: "stamp", reason: "aborted" }),
      },
    ])
  })

  test("a stage throw emits stage-failed when ctx has diagnostics", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const sink = warnSink()
    const boom = entry(
      "final",
      () => {
        throw new Error("boom")
      },
      "bad",
    )
    const out = await executeToolRound(
      readTool(),
      baseCtx({ diagnostics: sink.diagnostics, toolResultChain: [boom] }),
    )
    expect(out.content).toBe(base.content)
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "bad", phase: "final", reason: "throw" }),
      },
    ])
  })

  test("a stage throw with no ctx diagnostics does not throw", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const boom = entry("final", () => {
      throw new Error("boom")
    })
    const out = await executeToolRound(readTool(), baseCtx({ toolResultChain: [boom] }))
    expect(out.content).toBe(base.content)
  })
})

const vars0: ChainVars = {
  content: "body",
  isError: false,
  aborted: false,
  truncInfo: undefined,
  rawForBlob: undefined,
  display: undefined,
}
const meta0 = { tool: "Read", toolUseId: "tu", input: {} }

describe("applyChainPhase", () => {
  test("forwards opts.signal and opts.diagnostics to runPhase (m-2)", async () => {
    const turn = new AbortController()
    const sink = warnSink()
    let seen: AbortSignal | undefined
    const hang: ToolResultChainEntry = {
      pluginId: "hang",
      decl: {
        phase: "final",
        order: 0,
        transform: (_s, c) => {
          seen = c.signal
          setTimeout(() => turn.abort(), 5)
          return new Promise<ToolResultStage>(() => {})
        },
      },
    }
    const t0 = Date.now()
    const r = await applyChainPhase("final", [hang], vars0, meta0, {
      signal: turn.signal,
      diagnostics: sink.diagnostics,
    })
    expect(Date.now() - t0).toBeLessThan(STAGE_TIMEOUT_MS)
    expect(seen?.aborted).toBe(true)
    expect(r.vars).toStrictEqual(vars0)
    expect(sink.warns).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "hang", phase: "final", reason: "aborted" }),
      },
    ])
  })

  test("a timeoutMs below 2000 stops a slow stage at that limit at runtime (m-2)", async () => {
    const sink = warnSink()
    const slow: ToolResultChainEntry = {
      pluginId: "slow",
      decl: {
        phase: "final",
        order: 0,
        timeoutMs: 20,
        // The stage never settles, so only the 20 ms limit can stop it.
        // The `< 1000` check has a large margin for a loaded CI host.
        transform: () => new Promise<ToolResultStage>(() => {}),
      },
    }
    const t0 = Date.now()
    const r = await applyChainPhase("final", [slow], vars0, meta0, {
      diagnostics: sink.diagnostics,
    })
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(r.vars).toStrictEqual(vars0)
    expect(sink.warns).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "slow", reason: "timeout" }),
      },
    ])
  })

  test("a timeoutMs above 2000 keeps a stage that settles before 2000 ms at runtime (m-2)", async () => {
    const sink = warnSink()
    const ok: ToolResultChainEntry = {
      pluginId: "ok",
      decl: {
        phase: "final",
        order: 0,
        timeoutMs: 5000,
        transform: (s) =>
          new Promise<ToolResultStage>((res) =>
            setTimeout(() => res({ ...s, content: "done" }), 20),
          ),
      },
    }
    const r = await applyChainPhase("final", [ok], vars0, meta0, { diagnostics: sink.diagnostics })
    expect(r.vars.content).toBe("done")
    expect(sink.warns).toEqual([])
  })

  test("isError undefined becomes false in the stage, as in base decb0e6", async () => {
    let seen: boolean | undefined
    const peek = entry("final", (s) => {
      seen = s.isError
      return s
    })
    const r = await applyChainPhase("final", [peek], { ...vars0, isError: undefined }, meta0)
    expect(seen).toBe(false)
    expect(r.vars.isError).toBe(false)
  })

  test("no stage for the phase: the vars deep-equal the input, no new keys", async () => {
    const r = await applyChainPhase("final", [entry("stamp", (s) => s)], vars0, meta0)
    expect(r.vars).toStrictEqual(vars0)
    expect(Object.keys(r.vars).sort()).toEqual(Object.keys(vars0).sort())
  })
})

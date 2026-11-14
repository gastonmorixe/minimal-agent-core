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

import type { ToolResultChainEntry } from "./tool-result-chain.ts"
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

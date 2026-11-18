/**
 * The second clamp (SPEC D5, C-5) in the tool round. It runs only when a
 * `pre-outcome` or `post-blob` stage changed `body.text`.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "../tools/truncation.ts"

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
  const dir = mkdtempSync(join(tmpdir(), "ma-second-clamp-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return { type: "tool_use", id: "tu_clamp", name: "Read", input: { file_path: path } }
}

function entry(
  phase: ToolResultPhase,
  transform: (s: ToolResultStage) => ToolResultStage,
): ToolResultChainEntry {
  return { pluginId: "p", decl: { phase, order: 0, transform } }
}

/** A stamp stage that records the stage it sees. */
function recorder(): { seen: ToolResultStage[]; stage: ToolResultChainEntry } {
  const seen: ToolResultStage[] = []
  return {
    seen,
    stage: entry("stamp", (s) => {
      seen.push(s)
      return s
    }),
  }
}

const isCoreTrunc = (a: { kind: string; owner?: string }) =>
  a.kind === "output-truncated" && a.owner === "core"

/** Text over the byte cap and over the line cap. */
const GROWTH = `\n${"y".repeat(100)}`.repeat(MAX_TOOL_OUTPUT_LINES + 500)

describe("tool round second clamp (C-5)", () => {
  test("a pre-outcome stage that grows the text past the cap is clamped again", async () => {
    expect(GROWTH.length).toBeGreaterThan(MAX_TOOL_OUTPUT_BYTES)
    const rec = recorder()
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        toolResultChain: [
          entry("pre-outcome", (s) => ({ ...s, body: { ...s.body, text: s.body.text + GROWTH } })),
          rec.stage,
        ],
      }),
    )
    expect(rec.seen).toHaveLength(1)
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.filter(isCoreTrunc)).toHaveLength(1)
    expect(s.truncInfo?.truncated).toBe(true)
    expect(s.body.text.length).toBeLessThan(GROWTH.length)
    expect(Buffer.byteLength(s.body.text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    const content = String(out.content)
    expect(content.length).toBeLessThan(GROWTH.length)
    expect(content).toContain("line one")
  })

  test("a pre-outcome stage that keeps the text adds no output-truncated annotation", async () => {
    const base = await executeToolRound(readTool(), baseCtx())
    const rec = recorder()
    const out = await executeToolRound(
      readTool(),
      baseCtx({ toolResultChain: [entry("pre-outcome", (s) => ({ ...s })), rec.stage] }),
    )
    expect(rec.seen).toHaveLength(1)
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.filter(isCoreTrunc)).toHaveLength(0)
    expect(s.truncInfo?.truncated ?? false).toBe(false)
    expect(out.content).toBe(base.content)
  })
})

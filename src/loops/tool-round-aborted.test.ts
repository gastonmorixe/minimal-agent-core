/**
 * Aborted calls in the tool round: the "canceled" rule (SPEC D5, C-9) and the
 * aborted outcome. Every signal is aborted before the call. No timers.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { ToolResultStage } from "../../plugin-api/src/types/tool-result-chain.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { BlobStore } from "../session/blob-store.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import type { ToolExecResult } from "../tools/tools.ts"
import {
  joinTruncationParts,
  renderTruncatedNotice,
  type TruncationParts,
  truncateToolOutputParts,
} from "../tools/truncation-parts.ts"

import { finalizeOutcome } from "./tool-outcome-finalize.ts"
import type { ToolResultChainEntry } from "./tool-result-chain.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const ROOT = mkdtempSync(join(tmpdir(), "ma-round-aborted-"))
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

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

/** The block text of a stage: finalize over a mutable copy of its annotations. */
function blockText(s: ToolResultStage): string {
  return finalizeOutcome({ body: s.body, annotations: [...s.annotations] }).text
}

let n = 0
function readTool(): ToolUseBlock {
  const dir = mkdtempSync(join(ROOT, "read-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return { type: "tool_use", id: `tu_ab_${++n}`, name: "Read", input: { file_path: path } }
}

function aborted(): AbortSignal {
  const c = new AbortController()
  c.abort()
  return c.signal
}

/** A stamp stage that records the stage it sees. */
function recorder(): { seen: ToolResultStage[]; stage: ToolResultChainEntry } {
  const seen: ToolResultStage[] = []
  return {
    seen,
    stage: {
      pluginId: "p",
      decl: {
        phase: "stamp",
        order: 0,
        transform: (s) => {
          seen.push(s)
          return s
        },
      },
    },
  }
}

const isCoreTrunc = (a: { kind: string; owner?: string }) =>
  a.kind === "output-truncated" && a.owner === "core"

describe("aborted call in the tool round", () => {
  test('C-9 aborted + empty body: "canceled"', async () => {
    const rec = recorder()
    const out = await executeToolRound(
      readTool(),
      baseCtx({ signal: aborted(), toolResultChain: [rec.stage] }),
    )
    expect(rec.seen).toHaveLength(1)
    const s = rec.seen[0] as ToolResultStage
    expect(s.aborted).toBe(true)
    expect(s.body.text).toBe("canceled")
    expect(s.annotations).toEqual([])
    expect(out.content).toBe("canceled")
  })

  describe.skipIf(!textFixturesPresent())("with the text fixtures", () => {
    test('C-9 aborted with text: no "canceled"', async () => {
      const rec = recorder()
      const out = await executeToolRound(
        readTool(),
        baseCtx({
          signal: aborted(),
          text: fixtureSyntheticTextResolver(),
          toolResultChain: [rec.stage],
        }),
      )
      const s = rec.seen[0] as ToolResultStage
      expect(s.aborted).toBe(true)
      expect(s.body.text).not.toBe("")
      expect(s.body.text).not.toBe("canceled")
      expect(String(out.content)).not.toContain("canceled")
      expect(out.content).toBe(blockText(s))
    })

    test('C-9 aborted + empty kept + notice: no "canceled"', async () => {
      const text = fixtureSyntheticTextResolver()
      const facts = truncateToolOutputParts("x".repeat(70_000), { tool: "Read" }, text).facts
      const notice = renderTruncatedNotice(text, facts)
      expect(notice).not.toBe("")
      // Hand-made parts with an empty kept text (no real tool makes them).
      const parts: TruncationParts = {
        kept: "",
        notice,
        facts,
        info: { tool: "Read", truncated: true, shownBytes: 0, shownLines: 0, cutLine: 0 },
      }
      const stub: ToolRoundContext["executeTool"] = async (): Promise<ToolExecResult> => ({
        content: joinTruncationParts(parts),
        is_error: true,
        _aborted: true,
        _truncParts: parts,
        _truncInfo: parts.info,
      })
      const rec = recorder()
      const out = await executeToolRound(
        readTool(),
        baseCtx({ text, executeTool: stub, toolResultChain: [rec.stage] }),
      )
      expect(rec.seen).toHaveLength(1)
      const s = rec.seen[0] as ToolResultStage
      expect(s.aborted).toBe(true)
      expect(s.body.text).toBe("")
      expect(s.annotations.filter(isCoreTrunc)).toHaveLength(1)
      expect(s.annotations.find(isCoreTrunc)?.text).toBe(notice)
      const content = String(out.content)
      expect(content).not.toContain("canceled")
      expect(content).toBe(blockText(s))
      expect(content).toContain(notice)
    })
  })

  test("aborted outcome: aborted true, no blob write, no output-preview", async () => {
    const dir = join(ROOT, "blobs")
    // Threshold 0: any non-aborted call would write a blob.
    const blobStore = new BlobStore({ sid: "ab", dir, config: { minBytesToPersist: 0 } })
    const rec = recorder()
    const tool = readTool()
    const out = await executeToolRound(
      tool,
      baseCtx({ signal: aborted(), blobStore, toolResultChain: [rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(s.aborted).toBe(true)
    expect(s.blob).toBeUndefined()
    expect(s.annotations.some((a) => a.kind === "raw-output")).toBe(false)
    expect(s.annotations.some((a) => a.kind === "output-preview")).toBe(false)
    expect(existsSync(blobStore.pathFor(tool.id))).toBe(false)
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
    expect(out.content).toBe(blockText(s))
  })

  test("the executeTool seam defaults to the real function: a Read still runs", async () => {
    const rec = recorder()
    const out = await executeToolRound(readTool(), baseCtx({ toolResultChain: [rec.stage] }))
    const s = rec.seen[0] as ToolResultStage
    expect(s.aborted).toBe(false)
    expect(s.isError).toBe(false)
    expect(s.body.text).toContain("line one")
    expect(s.body.text).toContain("line two")
    expect(String(out.content)).toContain("line two")
  })
})

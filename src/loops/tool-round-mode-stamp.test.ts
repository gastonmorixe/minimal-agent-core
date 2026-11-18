/**
 * The mode stamp in the tool round (SPEC v6.1 T4). Core appends the
 * `mode-active` annotation after the `final` phase. The `stamp` stage sees it
 * read only: a stage that removes or edits it loses its result (reason
 * "owner") and the block keeps the stamp.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { ModeManager } from "../modes/modes.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { finalizeOutcome } from "./tool-outcome-finalize.ts"
import { STAGE_FAILED, type ToolResultChainEntry } from "./tool-result-chain.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const ROOT = mkdtempSync(join(tmpdir(), "ma-round-mode-stamp-"))
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

const FILE = join(ROOT, "a.txt")
writeFileSync(FILE, "line one\nline two\n")
const readTool = (): ToolUseBlock => ({
  type: "tool_use",
  id: "tu_stamp",
  name: "Read",
  input: { file_path: FILE },
})

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

function warnSink() {
  const warns: { source: string; data: unknown }[] = []
  const diagnostics = createDiagnostics({
    emit: (e) => void warns.push({ source: e.source, data: e.structuredData }),
  })
  return { warns, diagnostics }
}

/** A real mode manager with a fixed clock and the fixture text. */
function askMode(): ModeManager {
  const mgr = new ModeManager(
    [{ id: "ask", label: "ASK", permissions: [{ tool: "*", allow: true }] }],
    "ask",
    "dark",
    () => new Date(Date.UTC(2026, 4, 22, 17, 52, 30)),
  )
  mgr.bindSyntheticText(fixtureSyntheticTextResolver())
  return mgr
}

describe.skipIf(!textFixturesPresent())("T4 the mode stamp in the tool round", () => {
  test("T4 the stamp stage sees mode-active as the last annotation, owner core", async () => {
    const rec = recorder()
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        modeManager: askMode(),
        text: fixtureSyntheticTextResolver(),
        toolResultChain: [rec.stage],
      }),
    )
    expect(rec.seen).toHaveLength(1)
    const s = rec.seen[0] as ToolResultStage
    const last = s.annotations[s.annotations.length - 1]
    expect(last?.kind).toBe("mode-active")
    expect(last?.owner).toBe("core")
    expect(last?.attrs).toEqual({ id: "ask", since: "2026-05-22T17:52:30.000Z" })
    expect(s.annotations.filter((a) => a.kind === "mode-active")).toHaveLength(1)
    expect(String(out.content).endsWith(last?.text ?? "never")).toBe(true)
    expect(out.content).toBe(blockText(s))
  })

  test("T4 a stamp stage that removes mode-active: result dropped (owner), the stamp stays in the block", async () => {
    const base = await executeToolRound(
      readTool(),
      baseCtx({ modeManager: askMode(), text: fixtureSyntheticTextResolver() }),
    )
    const sink = warnSink()
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        modeManager: askMode(),
        text: fixtureSyntheticTextResolver(),
        diagnostics: sink.diagnostics,
        toolResultChain: [
          entry("stamp", (s) => ({
            ...s,
            annotations: s.annotations.filter((a) => a.kind !== "mode-active"),
          })),
        ],
      }),
    )
    expect(out.content).toBe(base.content)
    // The stamp text is still the tail of the block.
    expect(String(out.content)).toContain('<ma::agent::mode-active id="ask"')
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "p", phase: "stamp", reason: "owner" }),
      },
    ])
  })

  test("T4 a stamp stage that edits the mode-active text: result dropped, block bytes unchanged", async () => {
    const base = await executeToolRound(
      readTool(),
      baseCtx({ modeManager: askMode(), text: fixtureSyntheticTextResolver() }),
    )
    const sink = warnSink()
    const out = await executeToolRound(
      readTool(),
      baseCtx({
        modeManager: askMode(),
        text: fixtureSyntheticTextResolver(),
        diagnostics: sink.diagnostics,
        toolResultChain: [
          entry("stamp", (s) => ({
            ...s,
            annotations: s.annotations.map((a) =>
              a.kind === "mode-active" ? { ...a, text: "EDITED" } : a,
            ),
          })),
        ],
      }),
    )
    expect(String(out.content)).not.toContain("EDITED")
    expect(out.content).toBe(base.content)
    expect(sink.warns.filter((w) => w.source === STAGE_FAILED)).toEqual([
      {
        source: STAGE_FAILED,
        data: expect.objectContaining({ pluginId: "p", phase: "stamp", reason: "owner" }),
      },
    ])
  })

  test("T4 bytes equal with no stamp stage and with an identity stamp stage", async () => {
    const none = await executeToolRound(
      readTool(),
      baseCtx({ modeManager: askMode(), text: fixtureSyntheticTextResolver() }),
    )
    const rec = recorder()
    const identity = await executeToolRound(
      readTool(),
      baseCtx({
        modeManager: askMode(),
        text: fixtureSyntheticTextResolver(),
        toolResultChain: [rec.stage],
      }),
    )
    expect(rec.seen).toHaveLength(1)
    expect(identity.content).toBe(none.content)
    expect(String(none.content)).toContain("line two")
  })

  test("T4 no mode active: no mode-active annotation", async () => {
    const rec = recorder()
    const out = await executeToolRound(
      readTool(),
      baseCtx({ text: fixtureSyntheticTextResolver(), toolResultChain: [rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.some((a) => a.kind === "mode-active")).toBe(false)
    expect(out.content).toBe(blockText(s))
  })
})

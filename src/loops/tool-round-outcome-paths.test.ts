/**
 * Round-level T2 per path and D2 (SPEC v6.1 D6, D8; W3 item 1).
 *
 * On each path of `executeToolRound` the block text must equal
 * `finalizeOutcome(outcome).text`, the text before the body end must be the
 * body, and each annotation span must cover its annotation text. The
 * recording `stamp` stage is the only way to read the outcome from outside
 * (it sees the outcome after the mode stamp, before the block is built).
 * No `mock.module`, no timers: aborted calls use a pre-aborted signal.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type { PersistedToolOutcome } from "../../plugin-api/src/types/tool-outcome-record.ts"
import type { ToolResultStage } from "../../plugin-api/src/types/tool-result-chain.ts"
import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import {
  denyDecision,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type ToolWillInvokePayload,
} from "../sdk/lifecycle.ts"
import { BlobStore } from "../session/blob-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { MAX_TOOL_OUTPUT_LINES } from "../tools/truncation.ts"

import { finalizeOutcome } from "./tool-outcome-finalize.ts"
import type { ToolResultChainEntry } from "./tool-result-chain.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const TMP = mkdtempSync(join(tmpdir(), "ma-outcome-paths-"))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

let seq = 0
const nextId = (p: string): string => `${p}_${++seq}`

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
    text: fixtureSyntheticTextResolver(),
    ...overrides,
  }
}

type AppendArgs = [
  ToolResultBlock,
  Date | undefined,
  { path: string; bytes: number; sha256: string } | undefined,
  PersistedToolOutcome | undefined,
]

/** A store that records the arguments of each `appendToolResult` call. */
function spyStore(): { calls: AppendArgs[]; store: SessionStore } {
  const calls: AppendArgs[] = []
  const store = {
    appendToolResult: (...args: AppendArgs) => {
      calls.push(args)
    },
  } as unknown as SessionStore
  return { calls, store }
}

interface Observed {
  block: ToolResultBlock
  /** The stage the recording `stamp` entry saw (the last one, if it ran twice). */
  stage: ToolResultStage | undefined
  /** How many times the recording stage ran. */
  runs: number
  /** The persisted record the store got (4th argument), if any. */
  record: PersistedToolOutcome | undefined
}

/**
 * Run the round with a recording `stamp` stage and a spy store. Returns the
 * block and the stage that the recorder saw.
 */
async function observe(block: ToolUseBlock, ctx: ToolRoundContext): Promise<Observed> {
  const seen: ToolResultStage[] = []
  const recorder: ToolResultChainEntry = {
    pluginId: "p",
    decl: {
      phase: "stamp",
      order: 0,
      transform: (s) => {
        seen.push(s)
        return s
      },
    },
  }
  const { calls, store } = spyStore()
  const out = await executeToolRound(block, {
    ...ctx,
    store,
    toolResultChain: [...(ctx.toolResultChain ?? []), recorder],
  })
  expect(calls).toHaveLength(1)
  const [stored, , , record] = calls[0] as AppendArgs
  expect(stored).toBe(out)
  return { block: out, stage: seen.at(-1), runs: seen.length, record }
}

/**
 * The shared T2 check. A `ToolResultStage` is not a `ToolOutcome`, but it has
 * `body` and `annotations`, which are the only fields that `finalizeOutcome`
 * reads, so the stage is passed to it as is.
 * - (a) the block text is the finalized text (string content only),
 * - (b) the text before the body end is `stage.body.text`,
 * - (c) each span covers its annotation text, in order,
 * - (d) the persisted record has the same body end and the same spans.
 */
function expectOutcomeFits(o: Observed): void {
  expect(o.runs).toBe(1)
  const stage = o.stage as ToolResultStage
  expect(typeof o.block.content).toBe("string")
  const fin = finalizeStage(stage)
  expect(fin.text).toBe(o.block.content as string)
  expect(fin.text.slice(0, fin.bodyEnd)).toBe(stage.body.text)
  expect(fin.spans).toHaveLength(stage.annotations.length)
  let last = fin.bodyEnd
  stage.annotations.forEach((a, i) => {
    const span = fin.spans[i]
    expect(span?.kind).toBe(a.kind)
    expect(span?.start).toBeGreaterThanOrEqual(last)
    expect(fin.text.slice(span?.start, span?.end)).toBe(a.text)
    last = span?.end ?? last
  })
  expect(last).toBeLessThanOrEqual(fin.text.length)
  // The persisted record carries the same structure.
  expect(o.record).toBeDefined()
  expect(o.record?.bodyEnd).toBe(fin.bodyEnd)
  expect(o.record?.annotations.map((s) => [s.kind, s.start, s.end])).toEqual(
    fin.spans.map((s) => [s.kind, s.start, s.end]),
  )
}

/** `finalizeOutcome` wants a mutable annotation list; the stage list is readonly. */
const finalizeStage = (s: ToolResultStage) =>
  finalizeOutcome({ body: s.body, annotations: [...s.annotations] })

const kinds = (s: ToolResultStage | undefined): string[] =>
  (s?.annotations ?? []).map((a) => a.kind)

/** A Read of a file that has `lines` lines of `width` characters. */
function readOf(lines: number, width: number, name: string): ToolUseBlock {
  const path = join(TMP, `${name}-${++seq}.txt`)
  const row = "x".repeat(width)
  writeFileSync(path, Array.from({ length: lines }, (_, i) => `${row}${i}`).join("\n"))
  return { type: "tool_use", id: nextId(name), name: "Read", input: { file_path: path } }
}

function askMode(): ModeManager {
  const mm = new ModeManager(
    [
      {
        id: "ask",
        label: "ASK",
        permissions: [
          { tool: "*", allow: true },
          { tool: "Bash", allow: false },
        ],
      },
    ],
    "ask",
    "dark",
    () => new Date(Date.UTC(2026, 4, 22, 17, 52, 30)),
  )
  mm.bindSyntheticText(fixtureSyntheticTextResolver())
  return mm
}

const bashTool = (): ToolUseBlock => ({
  type: "tool_use",
  id: nextId("bash"),
  name: "Bash",
  input: { command: "echo hi" },
})

function writeOf(name: string): ToolUseBlock {
  return {
    type: "tool_use",
    id: nextId(name),
    name: "Write",
    input: { file_path: join(TMP, `${name}-${++seq}.txt`), content: "payload\n" },
  }
}

const denying: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeTool() {
    return denyDecision<ToolWillInvokePayload>("blocked by policy")
  },
}

const hookFailing: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  hasFailClosedToolHook: () => true,
  async beforeTool() {
    throw new Error("boom")
  },
}

const modeTool = (): ToolUseBlock => ({
  type: "tool_use",
  id: nextId("mode"),
  name: "Mode",
  input: {},
})

const fetchTool = (): ToolUseBlock => ({
  type: "tool_use",
  id: nextId("fetch"),
  name: "Fetch",
  input: { url: "https://example.com" },
})

/** The smallest loader stub: one plugin tool, `Fetch`, that returns `result`. */
function loaderStub(result: unknown): PluginLoader {
  return {
    hasTool: (name: string) => name === "Fetch",
    dispatch: async () => result,
  } as unknown as PluginLoader
}

/** Over the line cap, so the plugin clamp cuts it. */
const LONG_BODY = Array.from({ length: MAX_TOOL_OUTPUT_LINES + 200 }, (_, i) => `row ${i}`).join(
  "\n",
)

const preAborted = (): AbortSignal => {
  const c = new AbortController()
  c.abort()
  return c.signal
}

describe.skipIf(!textFixturesPresent())("T2 block text fits the outcome, per path", () => {
  test("T2 plain tool: Read of a small file", async () => {
    const o = await observe(readOf(5, 10, "small"), baseCtx())
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(stage.annotations).toEqual([])
    expect(stage.truncInfo?.truncated ?? false).toBe(false)
    expect(o.record?.annotations).toEqual([])
    expect(o.block.content).toBe(stage.body.text)
    expect(o.block.is_error).toBeFalsy()
  })

  test("T2 truncated tool: Read of 1100 lines gives one core output-truncated annotation, body = kept text", async () => {
    const o = await observe(readOf(1100, 4, "trunc"), baseCtx())
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    const trunc = stage.annotations.filter((a) => a.kind === "output-truncated")
    expect(trunc).toHaveLength(1)
    expect(trunc[0]?.owner).toBe("core")
    expect(stage.truncInfo?.truncated).toBe(true)
    // The body is the kept text: fewer lines than the file, and the notice is not in it.
    expect(stage.body.text.split("\n").length).toBeLessThan(1100)
    expect(stage.body.text).not.toContain(trunc[0]?.text as string)
    // The notice span follows the body.
    const fin = finalizeStage(stage)
    const span = fin.spans.find((s) => s.kind === "output-truncated")
    expect(span?.start).toBeGreaterThanOrEqual(fin.bodyEnd)
  })

  test("T2 truncated + blob: raw-output and output-preview spans follow the notice", async () => {
    const dir = mkdtempSync(join(TMP, "blobs-"))
    const blobStore = new BlobStore({ sid: "sid-paths", dir })
    const block = readOf(1100, 12, "blob")
    const o = await observe(block, baseCtx({ blobStore }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    const order = kinds(stage)
    const iTrunc = order.indexOf("output-truncated")
    const iRaw = order.indexOf("raw-output")
    const iPreview = order.indexOf("output-preview")
    expect(iTrunc).toBeGreaterThanOrEqual(0)
    expect(iRaw).toBeGreaterThan(iTrunc)
    expect(iPreview).toBeGreaterThan(iRaw)
    expect(blobStore.has(block.id)).toBe(true)
    expect(stage.blob?.path).toBe(blobStore.pathFor(block.id))
    // The raw-output text names the blob path.
    expect(stage.annotations[iRaw]?.text).toContain(blobStore.pathFor(block.id))
  })

  test("T2 refusal by mode gate: ask mode, Bash", async () => {
    const o = await observe(bashTool(), baseCtx({ modeManager: askMode() }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(o.block.is_error).toBe(true)
    expect(stage.isError).toBe(true)
    expect(stage.body.text).not.toBe("")
    expect(kinds(stage)).toEqual(["mode-active"])
  })

  test("T2 refusal by policy deny", async () => {
    const o = await observe(writeOf("deny"), baseCtx({ lifecycle: denying }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(o.block.is_error).toBe(true)
    expect(stage.body.text).toBe("blocked by policy")
    expect(stage.annotations).toEqual([])
  })

  test("T2 hook failed", async () => {
    const o = await observe(writeOf("hookfail"), baseCtx({ lifecycle: hookFailing }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(o.block.is_error).toBe(true)
    expect(stage.body.text).not.toBe("")
    expect(stage.body.text).toContain("boom")
  })

  test("T2 Mode tool: text only, mode-active span last", async () => {
    const o = await observe(modeTool(), baseCtx({ modeManager: askMode() }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(o.block.is_error).toBe(false)
    expect(JSON.parse(stage.body.text).id).toBe("ask")
    // Text only: no body data, no clamp numbers.
    expect("data" in stage.body && stage.body.data !== undefined).toBe(false)
    expect(stage.truncInfo).toBeUndefined()
    expect(kinds(stage)).toEqual(["mode-active"])
    const fin = finalizeStage(stage)
    expect(fin.spans.at(-1)?.kind).toBe("mode-active")
    expect(fin.spans.at(-1)?.end).toBe(fin.text.length)
  })

  test('T2 aborted call: pre-aborted signal gives body "canceled", no output-truncated', async () => {
    // No `ctx.text`: the aborted text is "", so the round puts "canceled" in the body (C-9).
    const o = await observe(
      readOf(5, 10, "abort"),
      baseCtx({ signal: preAborted(), text: undefined }),
    )
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(stage.aborted).toBe(true)
    expect(stage.body.text).toBe("canceled")
    expect(kinds(stage)).not.toContain("output-truncated")
    expect(o.block.content).toBe("canceled")
  })

  test("T2 plugin tool: clamp on a long body", async () => {
    const loader = loaderStub({ kind: "tool_result", content: LONG_BODY })
    const o = await observe(fetchTool(), baseCtx({ loader }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    const trunc = stage.annotations.filter((a) => a.kind === "output-truncated")
    expect(trunc).toHaveLength(1)
    expect(trunc[0]?.owner).toBe("core")
    expect(stage.truncInfo?.truncated).toBe(true)
    expect(stage.body.text.length).toBeLessThan(LONG_BODY.length)
    // The full body is kept for the blob (no blob store here, so the outcome holds it).
    expect(stage.rawForBlob).toBe(LONG_BODY)
  })

  test("T2 non-tool-result plugin result", async () => {
    const loader = loaderStub({ kind: "ui", content: "not a tool result" })
    const o = await observe(fetchTool(), baseCtx({ loader }))
    expectOutcomeFits(o)
    const stage = o.stage as ToolResultStage
    expect(o.block.is_error).toBe(true)
    expect(stage.isError).toBe(true)
    expect(stage.body.text).not.toBe("")
    expect(stage.body.text).not.toContain("not a tool result")
  })
})

interface PathCase {
  name: string
  block: () => ToolUseBlock
  ctx: () => ToolRoundContext
  /** The result must be an error. */
  isError?: true
  /** The result must be aborted. */
  aborted?: true
}

const CASES: PathCase[] = [
  { name: "gate", block: bashTool, ctx: () => baseCtx({ modeManager: askMode() }), isError: true },
  {
    name: "prepError (bad input)",
    // `Read` without `file_path` fails the input check before any side effect.
    block: () => ({ type: "tool_use", id: nextId("bad"), name: "Read", input: {} }),
    ctx: () => baseCtx(),
    isError: true,
  },
  { name: "Mode", block: modeTool, ctx: () => baseCtx({ modeManager: askMode() }) },
  {
    name: "deny",
    block: () => writeOf("d2deny"),
    ctx: () => baseCtx({ lifecycle: denying }),
    isError: true,
  },
  {
    name: "hook failed",
    block: () => writeOf("d2hook"),
    ctx: () => baseCtx({ lifecycle: hookFailing }),
    isError: true,
  },
  {
    name: "aborted",
    block: () => readOf(5, 10, "d2abort"),
    ctx: () => baseCtx({ signal: preAborted() }),
    // The built-in aborted result is also an error result (`is_error` true).
    isError: true,
    aborted: true,
  },
]

describe.skipIf(!textFixturesPresent())("D2 every path makes an outcome", () => {
  test("D2 every path makes an outcome: gate, prepError (bad input), Mode, deny, hook failed, aborted", async () => {
    for (const c of CASES) {
      const o = await observe(c.block(), c.ctx())
      // The stamp stage ran once, with a string body, on this path.
      expect(o.runs, c.name).toBe(1)
      const stage = o.stage as ToolResultStage
      expect(typeof stage.body.text, c.name).toBe("string")
      expect(stage.isError, c.name).toBe(c.isError === true)
      expect(stage.aborted, c.name).toBe(c.aborted === true)
      if (c.isError) expect(o.block.is_error, c.name).toBe(true)
      expect(o.record, c.name).toBeDefined()
      expectOutcomeFits(o)
    }
  })

  test("T2 no stage: same block bytes as with an identity stage", async () => {
    // One blob dir for both runs, so the blob path in the footer is equal.
    const sameDir = mkdtempSync(join(TMP, "same-"))
    const withBlob = (): ToolRoundContext =>
      baseCtx({
        blobStore: new BlobStore({ sid: "sid-same", dir: sameDir }),
      })
    const all: PathCase[] = [
      { name: "plain", block: () => readOf(5, 10, "same-small"), ctx: () => baseCtx() },
      // The same id and file for both runs, so the blob path is equal.
      (() => {
        const b = readOf(1100, 12, "same-blob")
        return { name: "truncated + blob", block: () => b, ctx: withBlob }
      })(),
      {
        name: "plugin clamp",
        block: () => ({ ...fetchTool(), id: "same-fetch" }),
        ctx: () => baseCtx({ loader: loaderStub({ kind: "tool_result", content: LONG_BODY }) }),
      },
      ...CASES,
    ]
    for (const c of all) {
      const block = c.block()
      const bare = await executeToolRound(block, c.ctx())
      const withStage = await observe(block, c.ctx())
      expect(withStage.block.content, c.name).toEqual(bare.content)
      // With a chain stage `is_error` is `false`, not `undefined`, when the tool gave no flag
      // (the chain phase sets `isError = o.isError`). Compare the truth value.
      expect(Boolean(withStage.block.is_error), c.name).toBe(Boolean(bare.is_error))
      expect(withStage.block.tool_use_id, c.name).toBe(bare.tool_use_id)
    }
  })
})

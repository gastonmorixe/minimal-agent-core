/**
 * The second clamp (SPEC D5, C-5) in the tool round. It runs only when a
 * `pre-outcome` or `post-blob` stage changed `body.text`.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import type {
  ToolResultPhase,
  ToolResultStage,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { createBlobsReadApi } from "../plugins/host/providers/blobs-read.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { BlobStore, shortSha256 } from "../session/blob-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "../tools/truncation.ts"

import { finalizeOutcome } from "./tool-outcome-finalize.ts"
import type { ToolResultChainEntry } from "./tool-result-chain.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

/** The real codec (sibling checkout), else `NO_SIDEBAND`: the core tags render here. */
const SB = fixtureSidebandOrNone()
/** `describe` for the tests that pin the bytes of a core tag. */
const describeSb = describe.skipIf(!sidebandFixturePresent())

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    sidebandApi: SB,
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

// --- The grown text above the second clamp goes to a blob -----------------

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

let seq = 0
/** A Read of a file with `lines` short lines (about 20 bytes each). */
function readLines(lines: number): ToolUseBlock {
  const path = join(tmp("ma-grown-src-"), "a.txt")
  writeFileSync(
    path,
    Array.from({ length: lines }, (_, i) => `row ${i} ${"z".repeat(12)}`).join("\n"),
  )
  return { type: "tool_use", id: `tu_grown_${++seq}`, name: "Read", input: { file_path: path } }
}

/** A stage that appends GROWTH to the text and keeps the grown text. */
function grower(phase: ToolResultPhase): { grown: () => string; stage: ToolResultChainEntry } {
  let grown = ""
  return {
    grown: () => grown,
    stage: entry(phase, (s) => {
      grown = s.body.text + GROWTH
      return { ...s, body: { ...s.body, text: grown } }
    }),
  }
}

function newStore(config?: ConstructorParameters<typeof BlobStore>[0]["config"]) {
  const dir = join(tmp("ma-grown-blobs-"), "blobs")
  return { dir, store: new BlobStore({ sid: "g", dir, ...(config ? { config } : {}) }) }
}

/** The annotation kinds without the TUI-elision preview (it is not part of the clamp). */
const kindsNoPreview = (s: ToolResultStage): string[] =>
  s.annotations.map((a) => a.kind).filter((k) => k !== "output-preview")

const blockOf = (s: ToolResultStage): string =>
  finalizeOutcome({ body: s.body, annotations: [...s.annotations] }).text

describeSb("second clamp writes the grown body to a blob", () => {
  test("second clamp writes the grown body to <id>_grown.raw", async () => {
    const { dir, store } = newStore()
    const g = grower("post-blob")
    const rec = recorder()
    const tool = readLines(10)
    await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [g.stage, rec.stage] }),
    )
    const file = join(dir, `${tool.id}_grown.raw`)
    expect(existsSync(file)).toBe(true)
    // The bytes are the grown text: no footer, no notice, no streak note.
    expect(readFileSync(file, "utf8")).toBe(g.grown())
    const s = rec.seen[0] as ToolResultStage
    const raw = s.annotations.find((a) => a.kind === "raw-output")
    expect(raw?.attrs?.path).toBe(file)
    expect(raw?.attrs?.sha256).toBe(shortSha256(g.grown()))
    expect(s.blob?.path).toBe(file)
    expect(s.blob?.bytes).toBe(Buffer.byteLength(g.grown(), "utf8"))
    expect(s.blob?.sha256).toBe(shortSha256(g.grown()))
  })

  test("second clamp: raw-output annotation points to the grown blob and is placed after output-truncated", async () => {
    const { dir, store } = newStore()
    const rec = recorder()
    const tool = readLines(10)
    const out = await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [grower("post-blob").stage, rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    // The first write was skipped (small body), so the footer is ADDED here.
    const kinds = s.annotations.map((a) => a.kind)
    expect(kinds.filter((k) => k === "raw-output")).toHaveLength(1)
    expect(kinds.indexOf("raw-output")).toBe(kinds.indexOf("output-truncated") + 1)
    expect(readdirSync(dir)).toEqual([`${tool.id}_grown.raw`])
    expect(String(out.content)).toContain(`${tool.id}_grown.raw`)
    expect(out.content).toBe(blockOf(s))
  })

  test("second clamp with an existing first blob: the first blob file is unchanged and the footer cites the grown blob once", async () => {
    const { dir, store } = newStore()
    const g = grower("post-blob")
    const rec = recorder()
    const tool = readLines(600)
    const out = await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [g.stage, rec.stage] }),
    )
    const first = join(dir, `${tool.id}.raw`)
    const grownFile = join(dir, `${tool.id}_grown.raw`)
    expect(existsSync(first)).toBe(true)
    expect(existsSync(grownFile)).toBe(true)
    // The first blob keeps the body before the stage (no GROWTH in it).
    const firstText = readFileSync(first, "utf8")
    expect(firstText).toContain("row 599")
    expect(firstText).not.toContain("yyyyyyyyyy")
    expect(readFileSync(grownFile, "utf8")).toBe(g.grown())
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.filter((a) => a.kind === "raw-output")).toHaveLength(1)
    const content = String(out.content)
    expect(content.split(`${tool.id}_grown.raw`).length - 1).toBeGreaterThanOrEqual(1)
    expect(content).not.toContain(`${tool.id}.raw"`)
    expect(content.match(/<ma::agent::raw-output /g)).toHaveLength(1)
  })

  test("a pre-outcome stage with a first blob: footer replaced in place, once", async () => {
    const { dir, store } = newStore()
    const rec = recorder()
    const tool = readLines(600)
    await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [grower("pre-outcome").stage, rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    const raws = s.annotations.filter((a) => a.kind === "raw-output")
    expect(raws).toHaveLength(1)
    expect(raws[0]?.attrs?.path).toBe(join(dir, `${tool.id}_grown.raw`))
    const kinds = s.annotations.map((a) => a.kind)
    expect(kinds.indexOf("raw-output")).toBe(kinds.indexOf("output-truncated") + 1)
  })

  test("second clamp, store null: same bytes as today", async () => {
    const rec = recorder()
    const out = await executeToolRound(
      readLines(10),
      baseCtx({ toolResultChain: [grower("post-blob").stage, rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(kindsNoPreview(s)).toEqual(["output-truncated"])
    expect(s.blob).toBeUndefined()
    expect(out.content).toBe(blockOf(s))
    expect(String(out.content)).not.toContain("raw-output")
  })

  test("second clamp, blobSkipTools tool: no blob, notice kept", async () => {
    const { dir, store } = newStore()
    const rec = recorder()
    const out = await executeToolRound(
      readLines(600),
      baseCtx({
        blobStore: store,
        blobSkipTools: new Set(["Read"]),
        toolResultChain: [grower("post-blob").stage, rec.stage],
      }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(kindsNoPreview(s)).toEqual(["output-truncated"])
    expect(s.blob).toBeUndefined()
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
    expect(out.content).toBe(blockOf(s))
  })

  test("second clamp, aborted: no blob", async () => {
    const { dir, store } = newStore({ minBytesToPersist: 0 })
    const rec = recorder()
    const c = new AbortController()
    c.abort()
    await executeToolRound(
      readLines(10),
      baseCtx({
        signal: c.signal,
        blobStore: store,
        toolResultChain: [grower("post-blob").stage, rec.stage],
      }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(s.aborted).toBe(true)
    expect(s.annotations.filter(isCoreTrunc)).toHaveLength(1)
    expect(s.annotations.some((a) => a.kind === "raw-output")).toBe(false)
    expect(s.blob).toBeUndefined()
    expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
  })

  test("second clamp, write returns null (store disabled or text under the minimum): same as today", async () => {
    for (const config of [{ enabled: false }, { minBytesToPersist: 100_000_000 }]) {
      const { dir, store } = newStore(config)
      const rec = recorder()
      const out = await executeToolRound(
        readLines(600),
        baseCtx({ blobStore: store, toolResultChain: [grower("post-blob").stage, rec.stage] }),
      )
      const s = rec.seen[0] as ToolResultStage
      expect(kindsNoPreview(s)).toEqual(["output-truncated"])
      expect(s.blob).toBeUndefined()
      expect(!existsSync(dir) || readdirSync(dir).length === 0).toBe(true)
      expect(out.content).toBe(blockOf(s))
    }
  })

  test("second clamp, write throws: the round still returns, no blob", async () => {
    const { store } = newStore()
    const bad = Object.assign(Object.create(store), {
      // Only the grown write fails; the first blob write is not guarded.
      writeAsync: async (id: string, raw: string) => {
        if (id.endsWith("_grown")) throw new Error("disk full")
        return store.writeAsync(id, raw)
      },
    }) as BlobStore
    const rec = recorder()
    const out = await executeToolRound(
      readLines(10),
      baseCtx({ blobStore: bad, toolResultChain: [grower("post-blob").stage, rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    expect(kindsNoPreview(s)).toEqual(["output-truncated"])
    expect(out.content).toBe(blockOf(s))
  })

  test("no stage: no second clamp, no extra file", async () => {
    const { dir, store } = newStore()
    const rec = recorder()
    const tool = readLines(600)
    const out = await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [rec.stage] }),
    )
    expect(readdirSync(dir)).toEqual([`${tool.id}.raw`])
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.filter((a) => a.kind === "raw-output")).toHaveLength(1)
    expect(s.blob?.path).toBe(join(dir, `${tool.id}.raw`))
    expect(out.content).toBe(blockOf(s))
  })

  test("a stage that keeps the text: no second clamp, no extra file", async () => {
    const { dir, store } = newStore()
    const tool = readLines(600)
    await executeToolRound(
      tool,
      baseCtx({
        blobStore: store,
        toolResultChain: [entry("post-blob", (s) => ({ ...s }))],
      }),
    )
    expect(readdirSync(dir)).toEqual([`${tool.id}.raw`])
  })

  test("appendToolResult receives the grown blob as rawPath", async () => {
    const { dir, store } = newStore()
    type Args = [unknown, unknown, { path: string; bytes: number; sha256: string } | undefined]
    const calls: Args[] = []
    const spy = {
      appendToolResult: (...a: Args) => {
        calls.push(a)
      },
    } as unknown as SessionStore
    const g = grower("post-blob")
    const tool = readLines(600)
    await executeToolRound(
      tool,
      baseCtx({ blobStore: store, store: spy, toolResultChain: [g.stage] }),
    )
    expect(calls).toHaveLength(1)
    const raw = (calls[0] as Args)[2]
    expect(raw?.path).toBe(join(dir, `${tool.id}_grown.raw`))
    expect(raw?.bytes).toBe(Buffer.byteLength(g.grown(), "utf8"))
    expect(raw?.sha256).toBe(shortSha256(g.grown()))
  })

  test("the output-preview annotation carries the grown path when it is added", async () => {
    const { dir, store } = newStore()
    const rec = recorder()
    const tool = readLines(600)
    await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [grower("post-blob").stage, rec.stage] }),
    )
    const s = rec.seen[0] as ToolResultStage
    const kinds = s.annotations.map((a) => a.kind)
    // The final stage runs after the preview; read it from the stamp stage.
    expect(kinds).toContain("output-preview")
    const preview = s.annotations.find((a) => a.kind === "output-preview")
    expect(preview?.attrs?.path).toBe(join(dir, `${tool.id}_grown.raw`))
    expect(kinds.indexOf("raw-output")).toBeLessThan(kinds.indexOf("output-preview"))
    expect(kinds.indexOf("output-truncated")).toBeLessThan(kinds.indexOf("raw-output"))
  })
})

describeSb("BlobStore with a grown id (<id>_grown)", () => {
  function put(store: BlobStore, id: string, ageSec: number): void {
    store.write(id, "q".repeat(5000))
    const t = new Date(Date.now() - ageSec * 1000)
    utimesSync(store.pathFor(id), t, t)
  }

  test("list() returns the grown id, and eviction keeps a protected grown id", () => {
    const { dir, store } = newStore()
    put(store, "tu_a_grown", 100) // the oldest, but protected
    put(store, "tu_b", 50)
    expect(store.list().map((b) => b.id)).toEqual(["tu_a_grown", "tu_b"])
    const small = new BlobStore({ sid: "g", dir, config: { maxBlobsPerSession: 1 } })
    small._evictIfOverCapForTests("tu_a_grown")
    expect(small.list().map((b) => b.id)).toEqual(["tu_a_grown"])
    // Not protected: the oldest grown id is evicted first, by its file name.
    put(small, "tu_c", 10)
    expect(small.list().map((b) => b.id)).toEqual(["tu_c"])
  })

  test("with a cap of 1 blob the grown write evicts the FIRST blob of the same call", async () => {
    // Real behavior: the grown blob is the protected id, so the first blob
    // (tu_x.raw) is the only candidate and is removed. The footer and the
    // session record cite the grown blob, so no cited path is lost.
    const { dir, store } = newStore({ maxBlobsPerSession: 1 })
    const rec = recorder()
    const tool = readLines(600)
    const out = await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [grower("post-blob").stage, rec.stage] }),
    )
    expect(readdirSync(dir)).toEqual([`${tool.id}_grown.raw`])
    expect(store.list().map((b) => b.id)).toEqual([`${tool.id}_grown`])
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.find((a) => a.kind === "raw-output")?.attrs?.path).toBe(
      join(dir, `${tool.id}_grown.raw`),
    )
    expect(String(out.content)).not.toContain(`${tool.id}.raw"`)
  })
})

describe("the grown blob id is readable by the host capability (listed implies readable)", () => {
  test("list() returns <id>_grown and read(<id>_grown) returns the same text", async () => {
    // The real blobs:read guard only reads ids that match ^[A-Za-z0-9_-]+$.
    // A dotted id (`<id>.grown`) was listed but could not be read.
    const root = tmp("ma-grown-read-")
    const sid = "ba0ad20f-0000-4000-8000-666ff6ccaa5b"
    const dir = join(root, `${sid}.blobs`)
    const store = new BlobStore({ sid, dir })
    const g = grower("post-blob")
    const tool = readLines(10)
    await executeToolRound(
      tool,
      baseCtx({ blobStore: store, toolResultChain: [g.stage, recorder().stage] }),
    )
    const api = createBlobsReadApi({ dir: root })
    const listed = await api.list(sid)
    const id = `${tool.id}_grown`
    expect(listed.items.map((i) => i.toolUseId)).toContain(id)
    // Every listed id must be readable, not only the grown one.
    for (const it of listed.items) {
      const r = await api.read(sid, it.toolUseId)
      expect(r).not.toBeNull()
    }
    // Ask for the whole file: the default read size clips a large blob.
    const r = await api.read(sid, id, { maxBytes: 10_000_000 })
    expect(r?.clipped).toBe(false)
    expect(r?.text).toBe(g.grown())
  })
})

describe("no codec (NO_SIDEBAND): the round adds no raw-output footer and no stray join", () => {
  test("a blob is written, but the model text has no footer and no blank tail", async () => {
    const { dir, store } = newStore({ minBytesToPersist: 1 })
    const rec = recorder()
    const tool = readLines(10)
    const out = await executeToolRound(
      tool,
      baseCtx({ sidebandApi: NO_SIDEBAND, blobStore: store, toolResultChain: [rec.stage] }),
    )
    expect(existsSync(join(dir, `${tool.id}.raw`))).toBe(true)
    const s = rec.seen[0] as ToolResultStage
    expect(s.annotations.some((a) => a.kind === "raw-output")).toBe(false)
    const content = String(out.content)
    expect(content.endsWith("\n")).toBe(false)
    expect(content).not.toContain("raw-output")
  })
})

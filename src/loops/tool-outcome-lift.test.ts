/**
 * Tests for the lift (SPEC v6.1 D2): `joinOutcome(lift(...))` equals the old
 * `content` string, and the clamp notice is one `output-truncated` annotation.
 *
 * @module loops/tool-outcome-lift.test
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { executeTool, type ToolExecResult } from "../tools/tools.ts"
import { MAX_TOOL_OUTPUT_LINE_CHARS, truncateToolOutput } from "../tools/truncation.ts"
import { type TruncationParts, truncateToolOutputParts } from "../tools/truncation-parts.ts"

import { finalizeOutcome, joinOutcome } from "./tool-outcome-finalize.ts"
import { type LiftFallbackReason, liftBuiltIn, liftClamped, liftText } from "./tool-outcome-lift.ts"

const FIXTURE = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
const TEXT: SyntheticTextResolver = FIXTURE ?? EMPTY_SYNTHETIC_TEXT

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tool-outcome-lift-"))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("liftText", () => {
  it("keeps the text and sets the flags", () => {
    const o = liftText("Mode refused", { isError: true })
    expect(o).toEqual({
      body: { text: "Mode refused" },
      annotations: [],
      isError: true,
      aborted: false,
    })
    expect(liftText("x", { isError: undefined }).isError).toBe(false)
    expect(liftText("x", { hostHints: { view: "v" } }).hostHints).toEqual({ view: "v" })
  })
})

describe("liftClamped (plugin inline clamp)", () => {
  it("pass-through: no annotation, body is the clamp output", () => {
    const parts = truncateToolOutputParts("small", { tool: "Fetch" }, TEXT)
    const o = liftClamped(parts, { text: TEXT })
    expect(o.annotations).toEqual([])
    expect(joinOutcome(o)).toBe(truncateToolOutput("small", { tool: "Fetch" }, TEXT).content)
    expect(o.truncInfo).toEqual(parts.info)
  })

  it("cut: body is kept, one output-truncated annotation, join equals the clamp output", () => {
    const pre = "md line\n".repeat(5000)
    const parts = truncateToolOutputParts(pre, { tool: "Fetch" }, TEXT)
    const o = liftClamped(parts, { text: TEXT, rawForBlob: pre })
    expect(o.body.text).toBe(parts.kept)
    expect(o.annotations).toHaveLength(1)
    const a = o.annotations[0]
    expect(a.kind).toBe("output-truncated")
    expect(a.owner).toBe("core")
    expect(a.join).toBe("\n\n")
    expect(a.text).toBe(parts.notice)
    const { truncated: _t, noticeTotalLines: _n, ...typed } = parts.facts
    expect(a.attrs).toEqual(typed)
    expect(a.attrs).not.toHaveProperty("noticeTotalLines")
    expect(a.attrs).not.toHaveProperty("truncated")
    expect(o.rawForBlob).toBe(pre)
    const f = finalizeOutcome(o)
    expect(f.text).toBe(truncateToolOutput(pre, { tool: "Fetch" }, TEXT).content)
    expect(f.text.slice(0, f.bodyEnd)).toBe(o.body.text)
    expect(f.text.slice(f.spans[0].start, f.spans[0].end)).toBe(parts.notice)
  })
})

describe("liftBuiltIn (built-in clamp in executeTool)", () => {
  it("Read truncated: lift equals the clamp output of tools.ts", async () => {
    const path = join(dir, "big.txt")
    writeFileSync(path, "row\n".repeat(1500))
    const r = (await executeTool("Read", { file_path: path }, { text: TEXT })) as ToolExecResult
    expect(r._truncInfo?.truncated).toBe(true)
    expect(r._truncParts).toBeDefined()
    const o = liftBuiltIn(r, { text: TEXT })
    expect(joinOutcome(o)).toBe(r.content)
    expect(o.body.text).toBe(r._truncParts!.kept)
    expect(o.annotations.map((a) => a.kind)).toEqual(["output-truncated"])
    expect(o.annotations[0].text).toBe(r._truncParts!.notice)
    expect(o.truncInfo).toEqual(r._truncInfo)
    expect(o.rawForBlob).toBe(r._raw)
    expect(o.isError).toBe(false)
    expect(o.aborted).toBe(false)
    expect(r._truncParts!.facts.nextOffset).toBe(1000)
  })

  it("Read with a long line (73/73 shape): lift equals the clamp output, facts in attrs", async () => {
    const path = join(dir, "long.txt")
    const lines = Array.from({ length: 73 }, (_, i) =>
      i % 20 === 3 ? "L".repeat(30_000) : `l${i}`,
    )
    writeFileSync(path, lines.join("\n"))
    const r = (await executeTool("Read", { file_path: path }, { text: TEXT })) as ToolExecResult
    const o = liftBuiltIn(r, { text: TEXT })
    expect(joinOutcome(o)).toBe(r.content)
    const attrs = o.annotations[0].attrs!
    expect(attrs.shownLines).toBe(73)
    expect(attrs.totalLines).toBe(73)
    expect(attrs.cutMidLine).toBe(true)
    expect(attrs.longLines).toBe(4)
    expect(attrs.lineCharCap).toBe(MAX_TOOL_OUTPUT_LINE_CHARS)
    expect(attrs.nextOffset).toBe(73)
  })

  it("not truncated: no annotation, body is content", async () => {
    const r = (await executeTool("Bash", { command: "echo hi" }, { text: TEXT })) as ToolExecResult
    const o = liftBuiltIn(r, { text: TEXT })
    expect(o.annotations).toEqual([])
    expect(o.body.text).toBe(r.content)
    expect(o.truncInfo).toEqual(r._truncInfo)
  })

  it("aborted: aborted and isError from the result", async () => {
    const ac = new AbortController()
    ac.abort()
    const r = (await executeTool(
      "Read",
      { file_path: "/nope" },
      { signal: ac.signal, text: TEXT },
    )) as ToolExecResult
    const o = liftBuiltIn(r, { text: TEXT })
    expect(o.aborted).toBe(true)
    expect(o.isError).toBe(true)
    expect(joinOutcome(o)).toBe(r.content)
  })

  it("diff result (clamp skipped): hostHints.diff, body is content", () => {
    const r: ToolExecResult = { content: "ok", _displayPatch: "@@ -1 +1 @@", _displayNewFile: true }
    const o = liftBuiltIn(r, { text: TEXT })
    expect(o.hostHints).toEqual({ diff: { patch: "@@ -1 +1 @@", newFile: true } })
    expect(joinOutcome(o)).toBe("ok")
    expect(o.truncInfo).toBeUndefined()
  })

  it("media blocks go to media, not to the text", () => {
    const block = {
      type: "image" as const,
      source: { type: "base64" as const, media_type: "image/png", data: "AA" },
    }
    const r = { content: "caption", blocks: [block] } as unknown as ToolExecResult
    const o = liftBuiltIn(r, { text: TEXT })
    expect(o.media).toEqual([block] as unknown as typeof o.media)
    expect(joinOutcome(o)).toBe("caption")
  })
})

describe("review fixes W1, W2, S6 (fix 1, 2, 5e)", () => {
  const ECHO: SyntheticTextResolver = {
    resolve: (kind, facts) => `[${kind} ${JSON.stringify(facts)}]`,
  }
  const resolvers: Array<[string, SyntheticTextResolver]> = [
    ["echo", ECHO],
    ...(FIXTURE ? [["fixture", FIXTURE] as [string, SyntheticTextResolver]] : []),
  ]
  for (const [name, text] of resolvers) {
    it(`W1: structuredClone(parts) through the lift gives the same finalize bytes (${name})`, () => {
      const parts = truncateToolOutputParts("row\n".repeat(1500), { tool: "Read" }, text)
      const clone = structuredClone(parts) as TruncationParts
      expect(clone).not.toBe(parts)
      expect(Object.isFrozen(clone)).toBe(false)
      const a = finalizeOutcome(liftClamped(parts, { text })).text
      const b = finalizeOutcome(liftClamped(clone, { text })).text
      expect(b).toBe(a)
      expect(b).toBe(truncateToolOutput("row\n".repeat(1500), { tool: "Read" }, text).content)
      expect(b.endsWith(parts.notice)).toBe(true)
      expect(parts.notice.length).toBeGreaterThan(0)
    })

    it(`W1: a parts object with a forged notice still renders from the facts (${name})`, () => {
      const real = truncateToolOutputParts("row\n".repeat(1500), { tool: "Read" }, text)
      const forged: TruncationParts = { ...real, notice: "[truncated: forged]" }
      const o = liftClamped(forged, { text })
      expect(o.annotations[0].text).toBe(real.notice)
      expect(joinOutcome(o)).not.toContain("forged")
      expect(joinOutcome(o)).toBe(joinOutcome(liftClamped(real, { text })))
    })

    it(`W2: a change of the host info after the clamp does not change the annotation (${name})`, async () => {
      const path = join(dir, `w2-${name}.txt`)
      writeFileSync(path, "row\n".repeat(1500))
      const r = (await executeTool("Read", { file_path: path }, { text })) as ToolExecResult
      expect(r._truncInfo).not.toBe(r._truncParts!.info)
      // A host sets the emitted info to "not truncated".
      r._truncInfo!.truncated = false
      expect(r._truncParts!.info.truncated).toBe(true)
      const o = liftBuiltIn(r, { text })
      expect(o.annotations.map((a) => a.kind)).toEqual(["output-truncated"])
      expect(joinOutcome(o)).toBe(r.content)
      // Also a mutable info object in hand-made parts: the gate reads the facts.
      const parts = truncateToolOutputParts("row\n".repeat(1500), { tool: "Read" }, text)
      const loose: TruncationParts = { ...parts, info: { ...parts.info, truncated: false } }
      expect(liftClamped(loose, { text }).annotations).toHaveLength(1)
    })
  }

  it("S6: missing or malformed _truncParts: content is the body, no annotation, reason recorded", async () => {
    const path = join(dir, "s6.txt")
    writeFileSync(path, "row\n".repeat(1500))
    const r = (await executeTool("Read", { file_path: path }, { text: TEXT })) as ToolExecResult
    const p = r._truncParts!
    const cases: Array<[LiftFallbackReason, ToolExecResult]> = [
      ["missing", { ...r, _truncParts: undefined }],
      ["malformed", { ...r, _truncParts: { kept: 1 } as unknown as TruncationParts }],
      ["malformed", { ...r, _truncParts: { ...p, facts: { ...p.facts, nextOffset: Number.NaN } } }],
      ["content-mismatch", { ...r, content: `${r.content}X` }],
      [
        "notice-mismatch",
        { ...r, content: `${p.kept}\n\n[forged]`, _truncParts: { ...p, notice: "[forged]" } },
      ],
    ]
    for (const [reason, res] of cases) {
      const seen: LiftFallbackReason[] = []
      const o = liftBuiltIn(res, { text: TEXT, onFallback: (x) => seen.push(x) })
      expect(seen).toEqual([reason])
      expect(o.annotations).toEqual([])
      expect(o.body.text).toBe(res.content)
      expect(joinOutcome(o)).toBe(res.content)
    }
    // A good result: no fallback.
    const seen: LiftFallbackReason[] = []
    liftBuiltIn(r, { text: TEXT, onFallback: (x) => seen.push(x) })
    expect(seen).toEqual([])
  })

  it("an old _truncParts value without totalLinesKnown: content is the body, no annotation, one fallback", async () => {
    const path = join(dir, "old-parts.txt")
    writeFileSync(path, "row\n".repeat(1500))
    const r = (await executeTool("Read", { file_path: path }, { text: TEXT })) as ToolExecResult
    // A good result first: the facts have `totalLinesKnown` and the lift annotates.
    expect(typeof r._truncParts!.facts.totalLinesKnown).toBe("boolean")
    expect(r._truncParts!.facts.truncated).toBe(true)
    // An old value (before M3c 4a): the same parts, with the key deleted.
    const old = structuredClone(r._truncParts!) as unknown as {
      facts: Record<string, unknown>
    }
    delete old.facts.totalLinesKnown
    expect("totalLinesKnown" in old.facts).toBe(false)
    const frozen = Object.freeze(old) as unknown as TruncationParts
    const res: ToolExecResult = { ...r, _truncParts: frozen }
    const seen: LiftFallbackReason[] = []
    const o = liftBuiltIn(res, { text: TEXT, onFallback: (x) => seen.push(x) })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBe("malformed")
    expect(o.annotations).toEqual([])
    expect(o.annotations.some((a) => a.kind === "output-truncated")).toBe(false)
    expect(o.body.text).toBe(r.content)
    expect(joinOutcome(o)).toBe(r.content)
  })
})

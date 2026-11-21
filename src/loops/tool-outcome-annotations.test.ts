/**
 * Tests for the core annotation builders (SPEC v6.1 D5), the T2 extra cases
 * 1-3 at module level, and the D-B one-value gate.
 *
 * Each "legacy" helper below builds the string the same way
 * `src/loops/tool-round.ts` builds `content` today (a38c86b).
 *
 * @module loops/tool-outcome-annotations.test
 */

import { describe, expect, it } from "bun:test"

import type { ToolAnnotation, ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  computeTuiElision,
  diagnosticsAnnotationText,
  formatDiagnosticsAnnotation,
} from "../agent/tool-preview-budget.ts"
import { modeActiveStampText } from "../modes/mode-text.ts"
import { wrapHookContext } from "../sdk/hook-context.ts"
import { type BlobWriteResult, formatBytes } from "../session/blob-store.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { previewTagText } from "../tools/tool-result-text.ts"
import { truncateToolOutput } from "../tools/truncation.ts"
import {
  renderTruncatedNotice,
  type TruncationFacts,
  type TruncationParts,
  truncateToolOutputParts,
} from "../tools/truncation-parts.ts"

import {
  appendAnnotations,
  buildCoreAnnotation,
  CORE_OWNER,
  cancelWhenEmpty,
  diagnosticsAnnotation,
  MODE_ACTIVE_SPEC,
  modeActiveAnnotation,
  OUTPUT_PREVIEW_SPEC,
  OUTPUT_TRUNCATED_SPEC,
  outputPreviewAnnotation,
  outputStreakAnnotation,
  outputTruncatedAnnotation,
  outputTruncatedFromParts,
  policyAnnotations,
  RAW_OUTPUT_SPEC,
  rawOutputAnnotation,
  replaceBodyClearAnnotations,
  truncationAttrs,
} from "./tool-outcome-annotations.ts"
import { finalizeOutcome, joinOutcome } from "./tool-outcome-finalize.ts"
import { liftClamped, liftText } from "./tool-outcome-lift.ts"

/** Deterministic resolver: each kind gives its kind and facts. Runs with no fixtures. */
const ECHO: SyntheticTextResolver = {
  resolve: (kind, facts) => `[${kind} ${JSON.stringify(facts)}]`,
}
const FIXTURE = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
const RESOLVERS: Array<[string, SyntheticTextResolver]> = [
  ["echo", ECHO],
  ["empty", EMPTY_SYNTHETIC_TEXT],
  ...(FIXTURE ? [["fixture", FIXTURE] as [string, SyntheticTextResolver]] : []),
]

const BLOB: BlobWriteResult = {
  path: "/tmp/ma/blobs/toolu_1.raw",
  bytes: 5123,
  sha256: "0123456789abcdef",
}

/** The real codec (sibling checkout), else `NO_SIDEBAND`. Byte pins skip without it. */
const SB = fixtureSidebandOrNone()
/** `describe` for the tests that pin the bytes of a sideband tag. */
const describeSb = describe.skipIf(!sidebandFixturePresent())

/**
 * The pinned v2 bytes of the raw-output footer. The real bytes come from
 * `RAW_OUTPUT_SPEC` (`renderCoreKind(sb, "raw-output", ...)` with the sibling codec).
 */
function legacyRawFooter(b: { path: string; size: string | number; sha256: string }): string {
  return `<ma::agent::raw-output path="${b.path}" size="${b.size}" sha256="${b.sha256}" />`
}
/** {@link legacyRawFooter} of a blob write result. */
function rawFooter(b: BlobWriteResult): string {
  return legacyRawFooter({ path: b.path, size: formatBytes(b.bytes), sha256: b.sha256 })
}

/** T2 checks of SPEC: equal text, body end, each span slice. */
function expectT2(o: Pick<ToolOutcome, "body" | "annotations">, legacy: string): void {
  const f = finalizeOutcome(o)
  expect(f.text).toBe(legacy)
  expect(f.text.slice(0, f.bodyEnd)).toBe(o.body.text)
  o.annotations.forEach((a, i) => {
    expect(f.text.slice(f.spans[i].start, f.spans[i].end)).toBe(a.text)
  })
}

/** Each core annotation: owner core, frozen, frozen attrs. */
function expectCore(a: ToolAnnotation): void {
  expect(a.owner).toBe(CORE_OWNER)
  expect(Object.isFrozen(a)).toBe(true)
  if (a.attrs) expect(Object.isFrozen(a.attrs)).toBe(true)
}

/** A 100-line body of about 5 kB. */
function body100(): string {
  return Array.from(
    { length: 100 },
    (_, i) => `${String(i + 1).padStart(4, "0")} ${"d".repeat(45)}`,
  ).join("\n")
}

describeSb("core builders give today's bytes", () => {
  for (const [name, text] of RESOLVERS) {
    it(`each builder text equals the legacy function (${name})`, () => {
      const streak = outputStreakAnnotation("[note: streak]", "Read", 3)!
      expect(streak.text).toBe("[note: streak]")
      expect(streak.join).toBe("\n\n")
      expect(outputStreakAnnotation(null, "Read", 3)).toBeNull()
      expect(outputStreakAnnotation("", "Read", 3)).toBeNull()

      const diag = diagnosticsAnnotation(SB, ["a", " ", "b"], "ad-hoc")!
      expect(diag.join + diag.text).toBe(formatDiagnosticsAnnotation(SB, ["a", " ", "b"], "ad-hoc"))
      expect(diag.text).toBe(diagnosticsAnnotationText(SB, ["a", " ", "b"], "ad-hoc"))
      expect(diagnosticsAnnotation(SB, [" ", "\n"])).toBeNull()
      expect(formatDiagnosticsAnnotation(SB, [" "])).toBe("")

      const raw = rawOutputAnnotation(SB, BLOB)!
      expect(raw.text).toBe(rawFooter(BLOB))
      expect(raw.join).toBe("\n\n")

      const mode = modeActiveAnnotation(text, "ask", "2026-01-01T00:00:00.000Z")
      const legacyStamp = modeActiveStampText(text, "ask", "2026-01-01T00:00:00.000Z")
      if (legacyStamp) {
        expect(mode!.text).toBe(legacyStamp)
        expect(mode!.joinWhenEmpty).toBe(false)
      } else {
        expect(mode).toBeNull()
      }
      expect(modeActiveAnnotation(text, null, "x")).toBeNull()

      for (const a of [streak, diag, raw, ...(mode ? [mode] : [])]) expectCore(a)
    })
  }

  it("policy: one annotation per clean line, join \\n (rule P)", () => {
    const notes = ["first", "  ", { text: "second" }, 42]
    const anns = policyAnnotations(SB, notes)
    expect(anns.map((a) => a.text)).toEqual([
      "<ma::agent::policy>first</ma::agent::policy>",
      "<ma::agent::policy>second</ma::agent::policy>",
    ])
    expect(anns.every((a) => a.join === "\n")).toBe(true)
    expectT2(appendAnnotations(liftText("x"), ...anns), `x\n${wrapHookContext(SB, notes)}`)
    expect(policyAnnotations(SB, [])).toEqual([])
  })

  it("mode stamp on empty content: no join (joinWhenEmpty false)", () => {
    const stamp = modeActiveAnnotation(ECHO, "ask", "t")!
    const legacy = (content: string) =>
      content.length > 0 ? `${content}\n\n${stamp.text}` : stamp.text
    expectT2(appendAnnotations(liftText(""), stamp), legacy(""))
    expectT2(appendAnnotations(liftText("r"), stamp), legacy("r"))
  })
})

describeSb("T2 extra cases at module level (SPEC T2, review C-1, C-8, C-9)", () => {
  for (const [name, text] of RESOLVERS) {
    it(`case 1: 100 lines, 5 kB, footer, preview; total= counts the footer (C-1) (${name})`, () => {
      const body = body100()
      expect(Buffer.byteLength(body)).toBeGreaterThan(4096)
      expect(Buffer.byteLength(body)).toBeLessThan(6000)
      const tool = "Bash"
      // Legacy (TR): clamp (pass-through), blob footer, preview on full content.
      let legacy = truncateToolOutput(body, { tool }, text).content
      legacy = `${legacy}\n\n${rawFooter(BLOB)}`
      const e = computeTuiElision(legacy, tool, SB)!
      expect(e.total).toBe(102) // 100 body lines + blank line + footer line
      legacy = `${legacy}\n\n${previewTagText(text, { shown: e.shown, total: e.total, tool, rawPath: BLOB.path })}`

      // v6: lift + raw-output + preview on the finalize prefix.
      let o = liftClamped(truncateToolOutputParts(body, { tool }, text), { text })
      expect(o.annotations).toEqual([])
      o = appendAnnotations(o, rawOutputAnnotation(SB, BLOB))
      const preview = outputPreviewAnnotation(SB, text, o, tool, BLOB.path)!
      expect(preview.attrs).toEqual({ shown: 10, total: 102, tool, path: BLOB.path })
      o = appendAnnotations(o, preview)
      expectT2(o, legacy)
      // Counting on body.text gives 100, not 102: the wrong input (C-1).
      expect(computeTuiElision(o.body.text, tool, SB)!.total).toBe(100)
    })

    it(`case 2: whitespace policy note gives one bare "\\n" (C-8) (${name})`, () => {
      const notes = ["   "]
      const legacy = `ok\n${wrapHookContext(SB, notes)}`
      expect(legacy).toBe("ok\n")
      const anns = policyAnnotations(SB, notes)
      expect(anns).toHaveLength(1)
      expect(anns[0].text).toBe("")
      expect(anns[0].join).toBe("\n")
      expectCore(anns[0])
      expectT2(appendAnnotations(liftText("ok"), ...anns), legacy)
    })

    it(`case 3: aborted, empty kept, notice: no "canceled" (C-9) (${name})`, () => {
      const facts = truncateToolOutputParts("x".repeat(70_000), { tool: "Bash" }, text).facts
      const notice = renderTruncatedNotice(text, facts)
      // Hand-made parts with an empty kept text (not made by the clamp).
      const parts: TruncationParts = {
        kept: "",
        notice,
        facts,
        info: { tool: "Bash", truncated: true, shownBytes: 0, shownLines: 0, cutLine: 0 },
      }
      // Legacy (TR:771-778): content holds the notice, so `!content` is false.
      let legacy = `${parts.kept}\n\n${parts.notice}`
      if (!legacy) legacy = "canceled"
      let o = liftClamped(parts, { aborted: true, isError: true, text })
      expect(o.body.text).toBe("")
      expect(o.aborted).toBe(true)
      o = cancelWhenEmpty(o)
      expect(o.body.text).toBe("")
      expectT2(o, legacy)
      expect(joinOutcome(o)).not.toContain("canceled")
    })
  }

  it("canceled is set when finalize gives an empty string", () => {
    const o = cancelWhenEmpty(liftText("", { aborted: true, isError: true }))
    expect(o.body.text).toBe("canceled")
    const kept = cancelWhenEmpty(liftText("partial", { aborted: true }))
    expect(kept.body.text).toBe("partial")
  })
})

describeSb("full D5 order: lift + all core annotations equals today's content", () => {
  for (const [name, text] of RESOLVERS) {
    it(`built-in truncated + streak + diagnostics + footer + preview + policy + stamp (${name})`, () => {
      const tool = "Read"
      const output = "row\n".repeat(1200)
      const ctx = { tool, totalLines: 1201, startLine: 0 }
      const notes = ["fix lint"]
      const lifecycle = ["policy one", " ", "policy two"]
      const streakNote = "[note: Read streak]"
      const since = "2026-11-17T00:00:00.000Z"

      // Legacy: the TR sequence on one string.
      let legacy = truncateToolOutput(output, ctx, text).content
      legacy = `${legacy}\n\n${streakNote}`
      legacy = `${legacy}${formatDiagnosticsAnnotation(SB, notes)}`
      legacy = `${legacy}\n\n${rawFooter(BLOB)}`
      const e = computeTuiElision(legacy, tool, SB)
      if (e) legacy = `${legacy}\n\n${previewTagText(text, { ...e, tool, rawPath: BLOB.path })}`
      legacy = `${legacy}\n${wrapHookContext(SB, lifecycle)}`
      const stamp = modeActiveStampText(text, "ask", since)
      if (stamp) legacy = legacy.length > 0 ? `${legacy}\n\n${stamp}` : stamp

      // v6.
      let o = liftClamped(truncateToolOutputParts(output, ctx, text), { text })
      o = appendAnnotations(
        o,
        outputStreakAnnotation(streakNote, tool, 3),
        diagnosticsAnnotation(SB, notes),
        rawOutputAnnotation(SB, BLOB),
      )
      o = appendAnnotations(o, outputPreviewAnnotation(SB, text, o, tool, BLOB.path))
      o = appendAnnotations(
        o,
        ...policyAnnotations(SB, lifecycle),
        modeActiveAnnotation(text, "ask", since),
      )
      expectT2(o, legacy)
      const kinds = o.annotations.map((a) => a.kind)
      expect(kinds.slice(0, 4)).toEqual([
        "output-truncated",
        "output-streak",
        "diagnostics",
        "raw-output",
      ])
      for (const a of o.annotations) expectCore(a)
    })
  }

  it("binary placeholder clears the annotations (D5 body table)", () => {
    let o = liftClamped(truncateToolOutputParts("row\n".repeat(1200), { tool: "Read" }, ECHO), {
      text: ECHO,
    })
    o = appendAnnotations(o, outputStreakAnnotation("[note]", "Read", 3))
    o = replaceBodyClearAnnotations(o, "<ma::agent::binary-result />")
    expect(joinOutcome(o)).toBe("<ma::agent::binary-result />")
  })
})

describeSb("D-B gate: text and attrs come from one value", () => {
  const facts = (bytes: number): TruncationFacts =>
    truncateToolOutputParts("row\n".repeat(bytes), { tool: "Read", startLine: 0 }, ECHO).facts

  it("a change of the source changes both the text and the attrs", () => {
    const a = outputTruncatedAnnotation(ECHO, facts(1200))
    const b = outputTruncatedAnnotation(ECHO, facts(1300))
    expect(a.attrs).not.toEqual(b.attrs)
    expect(a.text).not.toBe(b.text)
    const r1 = rawOutputAnnotation(SB, BLOB)!
    const r2 = rawOutputAnnotation(SB, { ...BLOB, sha256: "ffffffffffffffff" })!
    expect(r1.attrs!.sha256).not.toBe(r2.attrs!.sha256)
    expect(r1.text).not.toBe(r2.text)
    const m1 = modeActiveAnnotation(ECHO, "ask", "t1")!
    const m2 = modeActiveAnnotation(ECHO, "plan", "t1")!
    expect(m1.attrs!.id).not.toBe(m2.attrs!.id)
    expect(m1.text).not.toBe(m2.text)
  })

  it("attrs and text cannot disagree: the text is the render of the attrs", () => {
    const t = outputTruncatedAnnotation(ECHO, facts(1200))
    // The attrs have no noticeTotalLines (S1): the render uses totalLines,
    // which is the same value here (startLine 0, measured total).
    expect(t.attrs).not.toHaveProperty("noticeTotalLines")
    expect(renderTruncatedNotice(ECHO, t.attrs as unknown as TruncationFacts)).toBe(t.text)
    expect(
      OUTPUT_TRUNCATED_SPEC.render({ text: ECHO, facts: t.attrs as unknown as TruncationFacts }),
    ).toBe(t.text)
    const r = rawOutputAnnotation(SB, BLOB)!
    expect(r.text).toBe(
      legacyRawFooter({
        path: String(r.attrs!.path),
        size: String(r.attrs!.size),
        sha256: String(r.attrs!.sha256),
      }),
    )
    expect(RAW_OUTPUT_SPEC.render({ ...BLOB, sb: SB })).toBe(r.text)
    const o = appendAnnotations(liftText(body100()), rawOutputAnnotation(SB, BLOB))
    const p = outputPreviewAnnotation(SB, ECHO, o, "Bash", BLOB.path)!
    const pa = p.attrs as { shown: number; total: number; tool: string; path: string }
    expect(
      OUTPUT_PREVIEW_SPEC.render({
        text: ECHO,
        shown: pa.shown,
        total: pa.total,
        tool: pa.tool,
        rawPath: pa.path,
      }),
    ).toBe(p.text)
    const m = modeActiveAnnotation(ECHO, "ask", "t1")!
    expect(
      MODE_ACTIVE_SPEC.render({
        text: ECHO,
        id: String(m.attrs!.id),
        since: String(m.attrs!.since),
      }),
    ).toBe(m.text)
    const d = diagnosticsAnnotation(SB, ["a", "b"])!
    expect(d.attrs).toEqual({ count: 2 })
    expect(d.text).toContain('count="2"')
  })

  it("the annotation and its attrs are frozen", () => {
    const a = outputTruncatedAnnotation(ECHO, facts(1200))
    expect(() => {
      ;(a as { text: string }).text = "forged"
    }).toThrow()
    expect(() => {
      ;(a.attrs as Record<string, unknown>).shownBytes = 1
    }).toThrow()
  })

  it("a builder reads the source once: a mutated source after the build changes nothing", () => {
    const src = { sb: SB, path: "/a", bytes: 10, sha256: "aa" }
    const a = buildCoreAnnotation(RAW_OUTPUT_SPEC, src)
    src.path = "/b"
    expect(a.attrs!.path).toBe("/a")
    expect(a.text).toContain('path="/a"')
  })

  it("a hand-made notice that disagrees with the facts is not used", () => {
    const real = truncateToolOutputParts("row\n".repeat(1200), { tool: "Read" }, ECHO)
    const forged: TruncationParts = { ...real, notice: "[truncated: forged]" }
    const a = outputTruncatedFromParts(forged, ECHO)!
    expect(a.text).toBe(real.notice)
    expect(a.text).toBe(renderTruncatedNotice(ECHO, real.facts))
    // The clamp parts object: the text is the render of the facts too.
    const b = outputTruncatedFromParts(real, ECHO)!
    expect(b.text).toBe(real.notice)
    expect(b.attrs).toEqual(truncationAttrs(real.facts))
    // A structuredClone gives the same annotation (W1).
    expect(outputTruncatedFromParts(structuredClone(real), ECHO)).toEqual(b)
  })

  it("the gate reads facts.truncated, not info.truncated (W2)", () => {
    const real = truncateToolOutputParts("row\n".repeat(1200), { tool: "Read" }, ECHO)
    const infoOff: TruncationParts = { ...real, info: { ...real.info, truncated: false } }
    expect(outputTruncatedFromParts(infoOff, ECHO)?.text).toBe(real.notice)
    const pass = truncateToolOutputParts("ok", { tool: "Read" }, ECHO)
    const infoOn: TruncationParts = { ...pass, info: { ...pass.info, truncated: true } }
    expect(outputTruncatedFromParts(infoOn, ECHO)).toBeNull()
  })

  it("typed attrs: the D-H facts, not noticeTotalLines and not truncated (S1)", () => {
    const real = truncateToolOutputParts("row\n".repeat(1200), { tool: "Read" }, ECHO)
    const a = outputTruncatedAnnotation(ECHO, real.facts)
    expect(Object.keys(a.attrs!).sort()).toEqual(
      [
        "tool",
        "shownBytes",
        "totalBytes",
        "shownLines",
        "totalLines",
        "totalLinesKnown",
        "cutLine",
        "cutByte",
        "cutMidLine",
        "longLines",
        "lineCharCap",
        "lastLinePartial",
        "nextOffset",
      ].sort(),
    )
    // Core measured the total here (no ctx.totalLines), so the fact is false.
    expect(a.attrs!.totalLinesKnown).toBe(false)
    const given = truncateToolOutputParts(
      "row\n".repeat(1200),
      { tool: "Read", totalLines: 1200 },
      ECHO,
    )
    expect(outputTruncatedAnnotation(ECHO, given.facts).attrs!.totalLinesKnown).toBe(true)
  })

  it("buildCoreAnnotation rejects a spec that this module did not make (S3)", () => {
    const fake = { ...RAW_OUTPUT_SPEC, render: () => "forged" }
    const src = { ...BLOB, sb: SB }
    expect(() => buildCoreAnnotation(fake, src)).toThrow(TypeError)
    expect(() => buildCoreAnnotation(Object.freeze(fake), src)).toThrow(TypeError)
    expect(buildCoreAnnotation(RAW_OUTPUT_SPEC, src).text).toBe(rawFooter(BLOB))
  })
})

describe("no codec (NO_SIDEBAND): the tag kinds give no annotation and no stray join", () => {
  it("diagnostics, raw-output and policy give nothing", () => {
    expect(diagnosticsAnnotation(NO_SIDEBAND, ["a", "b"], "ad-hoc")).toBeNull()
    expect(formatDiagnosticsAnnotation(NO_SIDEBAND, ["a"])).toBe("")
    expect(diagnosticsAnnotationText(NO_SIDEBAND, ["a"])).toBe("")
    expect(rawOutputAnnotation(NO_SIDEBAND, BLOB)).toBeNull()
    expect(policyAnnotations(NO_SIDEBAND, ["one", "two"])).toEqual([])
    expect(wrapHookContext(NO_SIDEBAND, ["one", "two"])).toBe("")
  })

  it("finalize keeps the body only: no \\n\\n and no \\n where the tags were", () => {
    const o = appendAnnotations(
      liftText("ok"),
      diagnosticsAnnotation(NO_SIDEBAND, ["note"]),
      rawOutputAnnotation(NO_SIDEBAND, BLOB),
      ...policyAnnotations(NO_SIDEBAND, ["line"]),
    )
    expect(o.annotations).toEqual([])
    expect(joinOutcome(o)).toBe("ok")
  })

  it("a whitespace-only policy note keeps the bare \\n of rule P item 2", () => {
    const anns = policyAnnotations(NO_SIDEBAND, ["   "])
    expect(anns).toHaveLength(1)
    expect(joinOutcome(appendAnnotations(liftText("ok"), ...anns))).toBe("ok\n")
  })
})

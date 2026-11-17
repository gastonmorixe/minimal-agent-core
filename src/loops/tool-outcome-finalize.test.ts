/**
 * Tests for the D6 join and the T2 span facts of `tool-outcome-finalize.ts`.
 *
 * @module loops/tool-outcome-finalize.test
 */

import { describe, expect, it } from "bun:test"

import type { ToolAnnotation, ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"

import { finalizeOutcome, joinOutcome } from "./tool-outcome-finalize.ts"

function ann(
  kind: string,
  text: string,
  join: string,
  extra: Partial<ToolAnnotation> = {},
): ToolAnnotation {
  return { kind, text, join, owner: "core", ...extra }
}

function outcome(text: string, annotations: ToolAnnotation[]): ToolOutcome {
  return { body: { text }, annotations, isError: false, aborted: false }
}

/** D6 reference loop, copied from SPEC v6.1 D6. */
function specJoin(o: ToolOutcome): string {
  let out = o.body.text
  for (const a of o.annotations) {
    out += out.length === 0 && a.joinWhenEmpty === false ? a.text : a.join + a.text
  }
  return out
}

/** T2 checks: body end, each span slice, and equality with the D6 loop. */
function expectT2(o: ToolOutcome): void {
  const f = finalizeOutcome(o)
  expect(f.text).toBe(specJoin(o))
  expect(f.text).toBe(joinOutcome(o))
  expect(f.text.slice(0, f.bodyEnd)).toBe(o.body.text)
  expect(f.spans).toHaveLength(o.annotations.length)
  o.annotations.forEach((a, i) => {
    const span = f.spans[i]
    expect(span?.kind).toBe(a.kind)
    expect(f.text.slice(span?.start, span?.end)).toBe(a.text)
  })
}

describe("joinOutcome (SPEC D6)", () => {
  it("no annotations gives body.text", () => {
    const o = outcome("hello", [])
    expect(joinOutcome(o)).toBe("hello")
    expect(finalizeOutcome(o)).toEqual({ text: "hello", bodyEnd: 5, spans: [] })
  })

  it("join \\n\\n puts a blank line before the annotation", () => {
    const o = outcome("out", [ann("raw-output", "<ma::agent::raw-output/>", "\n\n")])
    expect(joinOutcome(o)).toBe("out\n\n<ma::agent::raw-output/>")
    expectT2(o)
  })

  it("join \\n puts one line break before each policy line", () => {
    const o = outcome("out", [ann("policy", "<p1>", "\n"), ann("policy", "<p2>", "\n")])
    expect(joinOutcome(o)).toBe("out\n<p1>\n<p2>")
    expectT2(o)
  })

  it("policy annotation with empty text gives one bare trailing \\n (D5 rule P)", () => {
    const o = outcome("out", [ann("policy", "", "\n")])
    expect(joinOutcome(o)).toBe("out\n")
    expectT2(o)
  })

  it("empty body and joinWhenEmpty false: no join", () => {
    const o = outcome("", [ann("mode-active", "<stamp/>", "\n\n", { joinWhenEmpty: false })])
    expect(joinOutcome(o)).toBe("<stamp/>")
    expectT2(o)
    expect(finalizeOutcome(o).spans[0]).toEqual({ kind: "mode-active", start: 0, end: 8 })
  })

  it("empty body and joinWhenEmpty true: join stays", () => {
    const o = outcome("", [ann("mode-active", "<stamp/>", "\n\n", { joinWhenEmpty: true })])
    expect(joinOutcome(o)).toBe("\n\n<stamp/>")
    expectT2(o)
  })

  it("empty body and joinWhenEmpty not set: join stays (default true)", () => {
    const o = outcome("", [ann("output-streak", "[note]", "\n\n")])
    expect(joinOutcome(o)).toBe("\n\n[note]")
    expectT2(o)
  })

  it("non-empty body and joinWhenEmpty false: join stays", () => {
    const o = outcome("x", [ann("mode-active", "<stamp/>", "\n\n", { joinWhenEmpty: false })])
    expect(joinOutcome(o)).toBe("x\n\n<stamp/>")
    expectT2(o)
  })

  it("joinWhenEmpty false checks the text so far, not only the body", () => {
    const o = outcome("", [
      ann("policy", "", "\n"),
      ann("mode-active", "<stamp/>", "\n\n", { joinWhenEmpty: false }),
    ])
    expect(joinOutcome(o)).toBe("\n\n\n<stamp/>")
    expectT2(o)
  })

  it("many annotations keep the append order (D5 order)", () => {
    const o = outcome("body", [
      ann("output-truncated", "[truncated: 1]", "\n\n", { attrs: { cutMidLine: true } }),
      ann("output-streak", "[note: 2]", "\n\n"),
      ann("diagnostics", "<ma::agent::diagnostics>d</ma::agent::diagnostics>", "\n\n"),
      ann("raw-output", "<ma::agent::raw-output/>", "\n\n"),
      ann("output-preview", "<ma::agent::output-preview/>", "\n\n"),
      ann("policy", "<ma::agent::policy>p</ma::agent::policy>", "\n"),
      ann("mode-active", "<ma::agent::mode-active/>", "\n\n", { joinWhenEmpty: false }),
    ])
    expectT2(o)
    const f = finalizeOutcome(o)
    expect(f.spans.map((s) => s.kind)).toEqual(o.annotations.map((a) => a.kind))
    expect(f.spans[0]?.attrs).toEqual({ cutMidLine: true })
    expect(f.spans[1] && "attrs" in f.spans[1]).toBe(false)
    for (let i = 1; i < f.spans.length; i++) {
      expect(f.spans[i]?.start).toBeGreaterThanOrEqual(f.spans[i - 1]?.end ?? 0)
    }
  })

  it("spans use UTF-16 offsets for non-ASCII text", () => {
    const o = outcome("é😀", [ann("policy", "ß😀", "\n")])
    expectT2(o)
    expect(finalizeOutcome(o).bodyEnd).toBe(3)
  })

  it("data+text body: finalize reads body.text only", () => {
    const o: ToolOutcome = {
      body: { data: { secret: "not in text" }, text: "shown", schema: { type: "object" } },
      annotations: [ann("raw-output", "<f/>", "\n\n")],
      isError: false,
      aborted: false,
    }
    expect(joinOutcome(o)).toBe("shown\n\n<f/>")
    expect(joinOutcome(o)).not.toContain("not in text")
    expectT2(o)
  })

  it("does not read media and does not change the input", () => {
    const o: ToolOutcome = {
      body: { text: "t" },
      media: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA==" } }],
      annotations: [ann("policy", "p", "\n")],
      isError: true,
      aborted: true,
    }
    const before = structuredClone(o)
    expect(joinOutcome(o)).toBe("t\np")
    expect(o).toEqual(before)
  })
})

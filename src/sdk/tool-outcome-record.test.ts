import { describe, expect, it } from "bun:test"

import type {
  CoreAnnotationKind,
  ToolAnnotation,
  ToolOutcome,
} from "../../plugin-api/src/types/tool-outcome.ts"
import {
  type PersistedToolOutcome,
  TOOL_OUTCOME_DATA_INLINE_MAX_BYTES,
} from "../../plugin-api/src/types/tool-outcome-record.ts"
import { finalizeOutcome } from "../loops/tool-outcome-finalize.ts"
import { jsonProtoKey, throwingGetter } from "../test-utils/hostile-plugin.ts"

import {
  attachPersistedOutcome,
  CORE_OWNED_KINDS,
  CORE_SPAN_TEXT_MAX_BYTES,
  checkPluginAnnotationCaps,
  outcomeTextOf,
  PLUGIN_ANNOTATION_CAPS,
  type PluginAnnotationCap,
  TOOL_OUTCOME_DATA_DROPPED,
  TOOL_OUTCOME_RECORD_DROPPED,
  TOOL_OUTCOME_RECORD_SKIPPED,
  toPersistedToolOutcome,
  validatePersistedToolOutcome,
} from "./tool-outcome-record.ts"

function ann(kind: string, text: string, join: string, extra: Partial<ToolAnnotation> = {}) {
  return { kind, text, join, owner: "core", ...extra } satisfies ToolAnnotation
}

function outcome(body: ToolOutcome["body"], annotations: ToolAnnotation[] = []): ToolOutcome {
  return { body, annotations, isError: false, aborted: false }
}

function collect() {
  const seen: { id: string; data: Record<string, unknown> }[] = []
  return { seen, report: (id: string, data: Record<string, unknown>) => seen.push({ id, data }) }
}

const rich = outcome({ text: "one\ntwo" }, [
  ann("raw-output", '<raw path="/b" />', "\n\n", { attrs: { path: "/b", bytes: 9 } }),
  ann("policy", "policy line A", "\n"),
  ann("policy", "policy line B", "\n"),
  ann("mode-active", "<mode />", "\n\n", { joinWhenEmpty: false }),
])

describe("toPersistedToolOutcome", () => {
  it("text only: bodyEnd is the text length, no spans", () => {
    const rec = toPersistedToolOutcome(outcome({ text: "hello" }), "hello")
    expect(rec).toEqual({ v: 1, bodyEnd: 5, annotations: [] })
  })

  it("spans slice the annotation texts; the body slice is the body text (T2)", () => {
    const text = finalizeOutcome(rich).text
    const rec = toPersistedToolOutcome(rich, text)
    expect(rec).toBeDefined()
    if (!rec) return
    expect(text.slice(0, rec.bodyEnd)).toBe("one\ntwo")
    expect(rec.annotations.map((s) => text.slice(s.start, s.end))).toEqual(
      rich.annotations.map((a) => a.text),
    )
    expect(rec.annotations[0]?.attrs).toEqual({ path: "/b", bytes: 9 })
    expect("attrs" in (rec.annotations[1] ?? {})).toBe(false)
  })

  it("empty body + mode stamp with joinWhenEmpty false: the span starts at 0", () => {
    const o = outcome({ text: "" }, [ann("mode-active", "<m/>", "\n\n", { joinWhenEmpty: false })])
    expect(toPersistedToolOutcome(o, "<m/>")).toEqual({
      v: 1,
      bodyEnd: 0,
      annotations: [{ kind: "mode-active", start: 0, end: 4 }],
    })
  })

  it("an empty policy text gives start === end", () => {
    const o = outcome({ text: "x" }, [ann("policy", "", "\n")])
    const rec = toPersistedToolOutcome(o, "x\n")
    expect(rec?.annotations).toEqual([{ kind: "policy", start: 2, end: 2 }])
  })

  it("text mismatch: no record and one record-skipped diagnostic", () => {
    const { seen, report } = collect()
    expect(toPersistedToolOutcome(rich, "other text", report, "Bash")).toBeUndefined()
    expect(seen).toEqual([
      { id: TOOL_OUTCOME_RECORD_SKIPPED, data: { tool: "Bash", reason: "text-mismatch" } },
    ])
  })

  it("never copies hostHints, truncInfo, rawForBlob, blob, media or text", () => {
    const o: ToolOutcome = {
      ...outcome({ text: "x" }),
      hostHints: { view: "v", header: "h" },
      truncInfo: { truncated: true } as unknown as ToolOutcome["truncInfo"],
      rawForBlob: "raw",
      blob: { path: "/p", bytes: 1, sha256: "s" },
      media: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA" } }],
    }
    const rec = toPersistedToolOutcome(o, "x")
    expect(Object.keys(rec ?? {}).sort()).toEqual(["annotations", "bodyEnd", "v"])
  })

  it("keeps JSON data and schema as JSON copies", () => {
    const data = { rows: [1, 2], when: new Date(0) }
    const o = outcome({ text: "x", data, schema: { type: "object" } })
    const rec = toPersistedToolOutcome(o, "x")
    expect(rec?.data).toEqual({ rows: [1, 2], when: "1970-01-01T00:00:00.000Z" })
    expect(rec?.data).not.toBe(data)
    expect(rec?.schema).toEqual({ type: "object" })
  })

  it("data at the cap stays; one byte over the cap is dropped with one diagnostic", () => {
    // JSON of a string is the string plus 2 quote bytes.
    const atCap = "a".repeat(TOOL_OUTCOME_DATA_INLINE_MAX_BYTES - 2)
    expect(toPersistedToolOutcome(outcome({ text: "x", data: atCap }), "x")?.data).toBe(atCap)

    const { seen, report } = collect()
    const over = `${atCap}a`
    const rec = toPersistedToolOutcome(outcome({ text: "x", data: over }), "x", report, "T")
    expect(rec).toEqual({ v: 1, bodyEnd: 1, annotations: [] })
    expect(seen).toEqual([
      {
        id: TOOL_OUTCOME_DATA_DROPPED,
        data: {
          tool: "T",
          field: "data",
          bytes: TOOL_OUTCOME_DATA_INLINE_MAX_BYTES + 1,
          reason: "over-cap",
        },
      },
    ])
  })

  it("measures UTF-8 bytes, not UTF-16 units", () => {
    // "é" is 1 UTF-16 unit and 2 UTF-8 bytes.
    const data = "é".repeat(TOOL_OUTCOME_DATA_INLINE_MAX_BYTES / 2)
    const { seen, report } = collect()
    expect(toPersistedToolOutcome(outcome({ text: "x", data }), "x", report)?.data).toBeUndefined()
    expect(seen[0]?.data.bytes).toBe(TOOL_OUTCOME_DATA_INLINE_MAX_BYTES + 2)
  })

  const unserializable: [string, () => unknown][] = [
    ["a BigInt", () => ({ n: 1n })],
    [
      "a cycle",
      () => {
        const a: Record<string, unknown> = {}
        a.self = a
        return a
      },
    ],
    [
      "a throwing toJSON",
      () => ({
        toJSON() {
          throw new Error("no")
        },
      }),
    ],
    ["a throwing getter (hostile fixture)", () => throwingGetter("x")],
    ["a function", () => () => 1],
  ]
  for (const [name, make] of unserializable) {
    it(`data with ${name}: dropped, the record stays, bytes -1`, () => {
      const { seen, report } = collect()
      const rec = toPersistedToolOutcome(outcome({ text: "x", data: make() }), "x", report)
      expect(rec).toEqual({ v: 1, bodyEnd: 1, annotations: [] })
      expect(seen).toEqual([
        {
          id: TOOL_OUTCOME_DATA_DROPPED,
          data: { field: "data", bytes: -1, reason: "not-serializable" },
        },
      ])
    })
  }

  it("data with an own __proto__ key (hostile fixture) keeps the key as data", () => {
    const rec = toPersistedToolOutcome(outcome({ text: "x", data: jsonProtoKey() }), "x")
    const data = rec?.data as Record<string, unknown>
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype)
    expect(Object.keys(data)).toEqual(["text", "__proto__"])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it("an annotation that throws on read gives no record and does not throw", () => {
    const bad = { ...outcome({ text: "x" }), annotations: [throwingGetter("kind")] }
    const { seen, report } = collect()
    expect(toPersistedToolOutcome(bad as unknown as ToolOutcome, "x", report)).toBeUndefined()
    expect(seen[0]).toEqual({
      id: TOOL_OUTCOME_RECORD_SKIPPED,
      data: { reason: "invalid-outcome" },
    })
  })

  it("an attribute value that JSON does not keep gives no record", () => {
    const o = outcome({ text: "x" }, [
      ann("k", "t", "\n", { attrs: { bad: Number.NaN } as Record<string, number> }),
    ])
    expect(toPersistedToolOutcome(o, "x\nt")).toBeUndefined()
  })
})

describe("validatePersistedToolOutcome", () => {
  const text = finalizeOutcome(rich).text
  const good = toPersistedToolOutcome(rich, text)

  it("accepts a converter record and gives an equal copy", () => {
    const back = validatePersistedToolOutcome(JSON.parse(JSON.stringify(good)), text)
    expect(back).toEqual(good)
  })

  it("accepts data, schema and a dataRef with no I/O", () => {
    const value = {
      v: 1 as const,
      bodyEnd: 1,
      annotations: [],
      data: [1],
      schema: { type: "array" },
      dataRef: { path: "/missing/file", bytes: 3, sha256: "abc" },
    }
    expect(validatePersistedToolOutcome(value, "x")).toEqual(value)
  })

  const bad: [string, unknown][] = [
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["v 2", { ...good, v: 2 }],
    ["no annotations", { v: 1, bodyEnd: 0 }],
    ["a negative bodyEnd", { ...good, bodyEnd: -1 }],
    ["a bodyEnd after the text", { ...good, bodyEnd: text.length + 1 }],
    ["a fractional offset", { ...good, bodyEnd: 1.5 }],
    [
      "a span end after the text",
      { v: 1, bodyEnd: 0, annotations: [{ kind: "k", start: 0, end: 999 }] },
    ],
    ["a span before bodyEnd", { v: 1, bodyEnd: 3, annotations: [{ kind: "k", start: 1, end: 4 }] }],
    ["end before start", { v: 1, bodyEnd: 0, annotations: [{ kind: "k", start: 4, end: 2 }] }],
    [
      "spans out of order",
      {
        v: 1,
        bodyEnd: 0,
        annotations: [
          { kind: "a", start: 4, end: 6 },
          { kind: "b", start: 1, end: 2 },
        ],
      },
    ],
    ["a span with no kind", { v: 1, bodyEnd: 0, annotations: [{ start: 0, end: 1 }] }],
    [
      "bad attrs",
      { v: 1, bodyEnd: 0, annotations: [{ kind: "k", attrs: { a: {} }, start: 0, end: 1 }] },
    ],
    ["a schema that is not an object", { v: 1, bodyEnd: 0, annotations: [], schema: "s" }],
    ["a bad dataRef", { v: 1, bodyEnd: 0, annotations: [], dataRef: { path: 1 } }],
    ["a throwing getter (hostile fixture)", throwingGetter("v")],
  ]
  for (const [name, value] of bad) {
    it(`rejects ${name} with undefined and does not throw`, () => {
      expect(validatePersistedToolOutcome(value, text)).toBeUndefined()
    })
  }

  it("keeps only the known keys", () => {
    const back = validatePersistedToolOutcome({ v: 1, bodyEnd: 0, annotations: [], text: "x" }, "x")
    expect(back).toEqual({ v: 1, bodyEnd: 0, annotations: [] })
  })
})

describe("outcomeTextOf (D8 rule 1)", () => {
  it("string, first text block, or empty", () => {
    expect(outcomeTextOf("abc")).toBe("abc")
    expect(
      outcomeTextOf([
        { type: "image" },
        { type: "text", text: "t1" },
        { type: "text", text: "t2" },
      ] as never),
    ).toBe("t1")
    expect(outcomeTextOf([{ type: "image" }] as never)).toBe("")
  })
})

describe("attachPersistedOutcome", () => {
  it("sets block.outcome and gives the same object", () => {
    const text = finalizeOutcome(rich).text
    const block: { outcome?: PersistedToolOutcome } = {}
    const rec = attachPersistedOutcome(block, rich, text)
    expect(rec).toBeDefined()
    expect(block.outcome).toBe(rec)
  })

  it("no outcome or a mismatch: no key on the block", () => {
    const block: { outcome?: PersistedToolOutcome } = {
      outcome: { v: 1, bodyEnd: 0, annotations: [] },
    }
    expect(attachPersistedOutcome(block, undefined, "x")).toBeUndefined()
    expect("outcome" in block).toBe(false)
    expect(attachPersistedOutcome(block, rich, "x")).toBeUndefined()
    expect("outcome" in block).toBe(false)
  })
})

describe("E14 caps on plugin-owned spans (restore)", () => {
  /** A record and its text: one span for each text, joined with a line break. */
  function spans(texts: string[], kind = "note", attrs?: Record<string, string | number>) {
    let text = "body"
    const annotations: PersistedToolOutcome["annotations"] = []
    for (const t of texts) {
      text += "\n"
      const start = text.length
      text += t
      annotations.push({ kind, ...(attrs && { attrs }), start, end: text.length })
    }
    return { text, record: { v: 1, bodyEnd: 4, annotations } as PersistedToolOutcome }
  }

  it("the core kind list is the CoreAnnotationKind type", () => {
    const all: Record<CoreAnnotationKind, true> = {
      "mode-active": true,
      policy: true,
      "raw-output": true,
      "output-preview": true,
      "output-truncated": true,
      "output-streak": true,
      diagnostics: true,
    }
    expect([...CORE_OWNED_KINDS].sort()).toEqual(Object.keys(all).sort())
  })

  it("has the E14 values", () => {
    expect(PLUGIN_ANNOTATION_CAPS).toEqual({
      count: 8,
      textBytes: 2048,
      attrKeys: 16,
      attrValueBytes: 256,
      totalBytes: 8192,
    })
  })

  it("at each cap: no cap is reported", () => {
    const atCaps = [
      spans(Array(8).fill("x")),
      spans(["y".repeat(2048)]),
      spans(["z"], "note", Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`k${i}`, 1]))),
      spans(["z"], "note", { k: "v".repeat(256) }),
      spans(Array(4).fill("w".repeat(2048))),
    ]
    for (const c of atCaps)
      expect(checkPluginAnnotationCaps(c.record, c.text)).toEqual({ ok: true })
  })

  it("names the first cap that a record passes over", () => {
    const cases: [ReturnType<typeof spans>, PluginAnnotationCap][] = [
      [spans(Array(9).fill("x")), "count"],
      [spans(["y".repeat(3000)]), "text-bytes"],
      [spans(["é".repeat(1025)]), "text-bytes"], // 2050 UTF-8 bytes, 1025 UTF-16 units
      [
        spans(
          ["z"],
          "note",
          Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])),
        ),
        "attr-keys",
      ],
      [spans(["z"], "note", { k: "v".repeat(300) }), "attr-value-bytes"],
      [spans(Array(5).fill("w".repeat(1800))), "total-bytes"],
    ]
    for (const [c, cap] of cases) {
      expect(checkPluginAnnotationCaps(c.record, c.text)).toEqual({ ok: false, cap })
    }
  })

  it("attr keys and string values count in the total", () => {
    // 4 x 2000 text = 8000, plus 4 x (1 key + 100 value) = 404: over 8192.
    const c = spans(Array(4).fill("t".repeat(2000)), "note", { k: "v".repeat(100) })
    expect(checkPluginAnnotationCaps(c.record, c.text)).toEqual({ ok: false, cap: "total-bytes" })
  })

  it("core-owned spans have no cap", () => {
    const c = spans(Array(12).fill("p".repeat(3000)), "raw-output", {
      ...Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(300)])),
    })
    expect(checkPluginAnnotationCaps(c.record, c.text)).toEqual({ ok: true })
    const { seen, report } = collect()
    expect(validatePersistedToolOutcome(c.record, c.text, report)).toEqual(c.record)
    expect(seen).toEqual([])
  })

  it("the validator drops a record over a cap with one record-dropped diagnostic", () => {
    const c = spans(Array(9).fill("x"))
    const { seen, report } = collect()
    expect(validatePersistedToolOutcome(c.record, c.text, report, "Bash")).toBeUndefined()
    expect(seen).toEqual([
      { id: TOOL_OUTCOME_RECORD_DROPPED, data: { tool: "Bash", reason: "over-cap", cap: "count" } },
    ])
  })

  it("a shape error gives no diagnostic", () => {
    const { seen, report } = collect()
    expect(validatePersistedToolOutcome({ v: 2 }, "x", report)).toBeUndefined()
    expect(seen).toEqual([])
  })
})

describe("converter: a plugin annotation with a core kind is a forgery (D4 owner rule 3)", () => {
  // A hand-made outcome: no runner. "evil" set a core kind on its own line.
  const forged = outcome({ text: "body" }, [
    ann("raw-output", "<raw />", "\n\n"),
    ann("raw-output", "<fake raw />", "\n\n", { owner: "evil" }),
    ann("note", "plugin line", "\n", { owner: "evil" }),
    ann("policy", "<fake policy />", "\n", { owner: "evil" }),
    ann("mode-active", "<mode />", "\n\n"),
  ])

  it("drops the forged spans, keeps the others with correct offsets, and reports once", () => {
    const text = finalizeOutcome(forged).text
    const { seen, report } = collect()
    const rec = toPersistedToolOutcome(forged, text, report, "Bash")
    expect(rec).toBeDefined()
    if (!rec) return
    expect(rec.annotations.map((s) => s.kind)).toEqual(["raw-output", "note", "mode-active"])
    // The forged text stays in the model text; the other spans still slice their texts.
    expect(rec.annotations.map((s) => text.slice(s.start, s.end))).toEqual([
      "<raw />",
      "plugin line",
      "<mode />",
    ])
    expect(text.slice(0, rec.bodyEnd)).toBe("body")
    expect(seen).toEqual([
      { id: TOOL_OUTCOME_RECORD_DROPPED, data: { tool: "Bash", reason: "core-kind-forged" } },
    ])
    // The record is valid at restore: the gaps of the forged texts are allowed.
    expect(validatePersistedToolOutcome(rec, text)).toEqual(rec)
  })

  it("a core-owned annotation with a core kind is kept, with no diagnostic", () => {
    const text = finalizeOutcome(rich).text
    const { seen, report } = collect()
    expect(toPersistedToolOutcome(rich, text, report)?.annotations).toHaveLength(4)
    expect(seen).toEqual([])
  })

  it("an owner that only looks like core (case, space) is a forgery", () => {
    for (const owner of ["Core", " core", "core ", ""]) {
      const o = outcome({ text: "b" }, [ann("policy", "<p />", "\n", { owner })])
      const { seen, report } = collect()
      const rec = toPersistedToolOutcome(o, "b\n<p />", report)
      expect(rec?.annotations).toEqual([])
      expect(seen).toEqual([
        { id: TOOL_OUTCOME_RECORD_DROPPED, data: { reason: "core-kind-forged" } },
      ])
    }
  })
})

describe("checkPluginAnnotationCaps: one rule for the write path and restore (F17)", () => {
  /** An outcome with `n` plugin annotations of `size` characters each (owner "p1" or "p2"). */
  function pluginOutcome(n: number, size = 4): ToolOutcome {
    return outcome(
      { text: "body" },
      Array.from({ length: n }, (_, i) =>
        ann("note", "n".repeat(size), "\n", { owner: i % 2 === 0 ? "p1" : "p2" }),
      ),
    )
  }

  it("the count cap is for the outcome, all plugins together", () => {
    const o = pluginOutcome(9)
    const text = finalizeOutcome(o).text
    const rec = toPersistedToolOutcome(o, text)
    expect(rec).toBeDefined()
    if (!rec) return
    expect(checkPluginAnnotationCaps(rec, text)).toEqual({ ok: false, cap: "count" })
  })

  it("8 plugin spans attach; the record is within the caps", () => {
    const o = pluginOutcome(8)
    const text = finalizeOutcome(o).text
    const block: { outcome?: PersistedToolOutcome } = {}
    const { seen, report } = collect()
    const rec = attachPersistedOutcome(block, o, text, report, "T")
    expect(rec?.annotations).toHaveLength(8)
    expect(block.outcome).toBe(rec)
    expect(seen).toEqual([])
  })

  it("10 plugin spans: no outcome on the block, undefined, ONE record-dropped", () => {
    const o = pluginOutcome(10)
    const text = finalizeOutcome(o).text
    const block: { outcome?: PersistedToolOutcome } = {
      outcome: { v: 1, bodyEnd: 0, annotations: [] },
    }
    const { seen, report } = collect()
    expect(attachPersistedOutcome(block, o, text, report, "T")).toBeUndefined()
    expect("outcome" in block).toBe(false)
    expect(seen).toEqual([
      { id: TOOL_OUTCOME_RECORD_DROPPED, data: { tool: "T", reason: "over-cap", cap: "count" } },
    ])
  })

  it("each cap at the write path gives its cap name", () => {
    const cases: [ToolOutcome, PluginAnnotationCap][] = [
      [pluginOutcome(1, 3000), "text-bytes"],
      [
        outcome({ text: "b" }, [
          ann("note", "x", "\n", {
            owner: "p",
            attrs: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, 1])),
          }),
        ]),
        "attr-keys",
      ],
      [
        outcome({ text: "b" }, [
          ann("note", "x", "\n", { owner: "p", attrs: { k: "v".repeat(300) } }),
        ]),
        "attr-value-bytes",
      ],
      [pluginOutcome(5, 1800), "total-bytes"],
    ]
    for (const [o, cap] of cases) {
      const { seen, report } = collect()
      expect(attachPersistedOutcome({}, o, finalizeOutcome(o).text, report)).toBeUndefined()
      expect(seen).toEqual([{ id: TOOL_OUTCOME_RECORD_DROPPED, data: { reason: "over-cap", cap } }])
    }
  })
})

describe("core span cap (F15b)", () => {
  it("has the value 4096", () => {
    expect(CORE_SPAN_TEXT_MAX_BYTES).toBe(4096)
  })

  it("a 10000-byte raw-output span: restore drops the outcome with one record-dropped", () => {
    const text = `body\n\n${"r".repeat(10_000)}`
    const rec = {
      v: 1,
      bodyEnd: 4,
      annotations: [{ kind: "raw-output", start: 6, end: text.length }],
    }
    const { seen, report } = collect()
    expect(validatePersistedToolOutcome(rec, text, report, "Bash")).toBeUndefined()
    expect(seen).toEqual([
      {
        id: TOOL_OUTCOME_RECORD_DROPPED,
        data: { tool: "Bash", reason: "over-cap", cap: "core-span-text" },
      },
    ])
  })

  it("a core span at 4096 UTF-8 bytes stays; one more byte drops it (UTF-8, not UTF-16)", () => {
    const at = `b\n${"é".repeat(2048)}` // 4096 UTF-8 bytes, 2048 UTF-16 units
    const atRec = {
      v: 1 as const,
      bodyEnd: 1,
      annotations: [{ kind: "policy", start: 2, end: at.length }],
    }
    expect(validatePersistedToolOutcome(atRec, at)).toEqual(atRec)
    const over = `${at}x`
    const overRec = {
      v: 1,
      bodyEnd: 1,
      annotations: [{ kind: "policy", start: 2, end: over.length }],
    }
    expect(validatePersistedToolOutcome(overRec, over)).toBeUndefined()
  })

  it("the write path applies the same cap (live == restored)", () => {
    const o = outcome({ text: "b" }, [ann("raw-output", "r".repeat(5000), "\n\n")])
    const block: { outcome?: PersistedToolOutcome } = {}
    const { seen, report } = collect()
    expect(attachPersistedOutcome(block, o, finalizeOutcome(o).text, report)).toBeUndefined()
    expect("outcome" in block).toBe(false)
    expect(seen).toEqual([
      { id: TOOL_OUTCOME_RECORD_DROPPED, data: { reason: "over-cap", cap: "core-span-text" } },
    ])
  })
})

describe("validator: data cap at restore (16000 bytes)", () => {
  it("a stored 5 MB data value is dropped; the rest of the record stays; one data-dropped", () => {
    const data = { blob: "d".repeat(5 * 1024 * 1024) }
    const stored = { v: 1, bodyEnd: 1, annotations: [], data, schema: { type: "object" } }
    const { seen, report } = collect()
    const back = validatePersistedToolOutcome(stored, "x", report, "T")
    expect(back).toEqual({ v: 1, bodyEnd: 1, annotations: [], schema: { type: "object" } })
    expect(seen).toEqual([
      {
        id: TOOL_OUTCOME_DATA_DROPPED,
        data: {
          tool: "T",
          field: "data",
          bytes: JSON.stringify(data).length,
          reason: "over-cap",
        },
      },
    ])
  })

  it("data at the cap stays", () => {
    const data = "a".repeat(TOOL_OUTCOME_DATA_INLINE_MAX_BYTES - 2)
    expect(
      validatePersistedToolOutcome({ v: 1, bodyEnd: 0, annotations: [], data }, "")?.data,
    ).toBe(data)
  })
})

describe("validator: a span offset inside a surrogate pair is a shape error", () => {
  // "😀" is one code point and two UTF-16 units (a surrogate pair).
  const text = "a😀b" // a=0, high=1, low=2, b=3

  it("rejects a start or an end between the two halves of an emoji", () => {
    const { seen, report } = collect()
    for (const span of [
      { kind: "note", start: 2, end: 3 },
      { kind: "note", start: 1, end: 2 },
      { kind: "note", start: 0, end: 2 },
    ]) {
      expect(
        validatePersistedToolOutcome({ v: 1, bodyEnd: 0, annotations: [span] }, text, report),
      ).toBeUndefined()
    }
    expect(seen).toEqual([])
  })

  it("accepts offsets at the edges of the pair", () => {
    const rec = { v: 1 as const, bodyEnd: 1, annotations: [{ kind: "note", start: 1, end: 3 }] }
    expect(validatePersistedToolOutcome(rec, text)).toEqual(rec)
    expect(text.slice(1, 3)).toBe("😀")
  })
})

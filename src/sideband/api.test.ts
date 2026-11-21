/**
 * Tests of `createSidebandApi`. The stub codec has a wire form that is not
 * XML: `{{kind|k=v;k=v|body}}`. So the read functions of core prove that they
 * use only `parse` spans and know no format.
 */

import { describe, expect, it } from "bun:test"

import { createSidebandApi, NO_SIDEBAND } from "./api.ts"
import { createPluginSidebandContext } from "./context.ts"
import {
  SidebandCodecMissingError,
  SidebandKindDuplicateError,
  SidebandKindInvalidError,
  SidebandKindUnknownError,
} from "./errors.ts"
import { createSidebandRegistry } from "./registry.ts"
import type { SidebandCodec, SidebandKind, SidebandNode, SidebandRegistry } from "./types.ts"

const STUB_RE = /\{\{([a-z-]+)\|([^|]*)\|([^}]*)\}\}/g

function stubCodec(withOptional: boolean): SidebandCodec {
  const codec: SidebandCodec = {
    id: "stub-braces",
    render: (k, m) =>
      `{{${k.kind}|${Object.entries(m.attrs ?? {})
        .map(([a, v]) => `${a}=${v}`)
        .join(";")}|${m.body ?? ""}}}`,
    parse: (text) => {
      const out: SidebandNode[] = []
      for (const m of text.matchAll(STUB_RE)) {
        const attrs: Record<string, string> = {}
        for (const pair of (m[2] ?? "").split(";").filter(Boolean)) {
          const [a, v] = pair.split("=")
          attrs[a ?? ""] = v ?? ""
        }
        const start = m.index ?? 0
        out.push({
          kind: m[1] ?? "",
          attrs,
          body: m[3] ?? "",
          selfClosing: false,
          form: "v2",
          span: { start, end: start + m[0].length },
        })
      }
      return out
    },
    scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
    neutralize: (t) => t.replaceAll("{{", "{ {"),
    example: (k, m) => `{{${k.kind}|ex|${m?.body ?? "..."}}}`,
  }
  if (withOptional) {
    codec.name = (k) => `N:${k.kind}`
    codec.trailingStart = (text) => {
      const i = text.indexOf("\n\n{{")
      return i < 0 ? text.length : i
    }
  }
  return codec
}

function kind(over: Partial<SidebandKind> = {}): SidebandKind {
  return {
    kind: "note",
    owner: "",
    direction: "to-model",
    placement: "tool-result",
    attrs: {
      count: { type: "int" },
      ok: { type: "bool" },
      lvl: { type: "enum", values: ["a"] },
    },
    body: "text",
    trust: "harness",
    summary: "s",
    ...over,
  }
}

function registry(codec?: SidebandCodec): SidebandRegistry {
  const r = createSidebandRegistry()
  r.register(kind(), "p")
  r.register(
    kind({
      kind: "ack",
      direction: "from-model",
      placement: "inline",
      attrs: {},
    }),
    "p",
  )
  if (codec) r.setCodec(() => codec, "c")
  r.freeze()
  return r
}

describe("createSidebandApi with a non-XML codec", () => {
  const api = createSidebandApi(registry(stubCodec(false)))

  it("is ready and renders through the codec", () => {
    expect(api.ready).toBe(true)
    expect(api.render("note", { attrs: { count: 2 }, body: "b" })).toBe("{{note|count=2|b}}")
    expect(api.render("ack")).toBe("{{ack||}}")
  })

  it("throws SidebandKindUnknownError for an unknown kind", () => {
    expect(() => api.render("nope")).toThrow(SidebandKindUnknownError)
    expect(() => api.name("nope")).toThrow(SidebandKindUnknownError)
  })

  it("finds, filters and tests nodes", () => {
    const text = "x {{note||a}} y {{ack||}} {{other||}}"
    expect(api.find(text).map((n) => n.kind)).toEqual(["note", "ack", "other"])
    expect(api.find(text, { kinds: ["ack"] }).map((n) => n.kind)).toEqual(["ack"])
    expect(api.find(text, { direction: "from-model" }).map((n) => n.kind)).toEqual(["ack"])
    expect(api.find(text, { placement: "tool-result" }).map((n) => n.kind)).toEqual(["note"])
    expect(api.has(text, { kinds: ["other"] })).toBe(true)
    expect(api.has("plain", {})).toBe(false)
    expect(api.startsWith("  \n{{ack||}} x")).toBe(true)
    expect(api.startsWith("x {{ack||}}")).toBe(false)
  })

  it("replace keeps offsets, removes with empty text, keeps with undefined", () => {
    const text = "A{{note||1}}B{{ack||}}C{{note||22}}D"
    const out = api.replace(text, (n) =>
      n.kind === "ack" ? undefined : n.body === "1" ? "<one>" : "",
    )
    expect(out).toBe("A<one>B{{ack||}}CD")
    expect(api.strip(text, { kinds: ["note"] })).toBe("AB{{ack||}}CD")
  })

  it("attrs gives typed values and drops a bad or undeclared value", () => {
    const [n] = api.find("{{note|count=7;ok=true;lvl=zz;extra=1|}}")
    expect(api.attrs(n as SidebandNode)).toEqual({ count: 7, ok: true })
    const [m] = api.find("{{note|count=x;ok=no;lvl=a|}}")
    expect(api.attrs(m as SidebandNode)).toEqual({ lvl: "a" })
    const [u] = api.find("{{other|a=1|}}")
    expect(api.attrs(u as SidebandNode)).toEqual({})
  })

  it("trailing finds the region at the end with parse (no trailingStart)", () => {
    const text = "body {{note||x}} more\n\n{{note||a}}\n\n{{ack||}}\n"
    const t = api.trailing(text)
    expect(t.nodes.map((n) => n.body)).toEqual(["a", ""])
    expect(text.slice(0, t.bodyEnd)).toBe("body {{note||x}} more")
    expect(api.trailing("no region").bodyEnd).toBe(9)
  })

  it("name defaults to the kind name; example and neutralize use the codec", () => {
    expect(api.name("note")).toBe("note")
    expect(api.example("note")).toBe("{{note|ex|...}}")
    expect(api.neutralize("{{x")).toBe("{ {x")
    expect(api.kinds({ direction: "from-model" }).map((k) => k.kind)).toEqual(["ack"])
    expect(api.kinds().length).toBe(2)
  })
})

describe("createSidebandApi with the optional codec members", () => {
  const api = createSidebandApi(registry(stubCodec(true)))

  it("uses name and trailingStart of the codec", () => {
    expect(api.name("note")).toBe("N:note")
    const text = "body\n\n{{note||a}}"
    const t = api.trailing(text)
    expect(t.bodyEnd).toBe(4)
    expect(t.nodes.map((n) => [n.kind, n.span.start])).toEqual([["note", 6]])
  })

  it("trailingStart is a hint: a hint that finds only the last part of the region still gives the whole region", () => {
    // The hint knows only `note` (like the real hint, which does not know
    // `raw-output`). The region is `ack` + `note`.
    const c = stubCodec(true)
    c.trailingStart = (text) => {
      const i = text.lastIndexOf("\n\n{{note")
      return i < 0 ? text.length : i
    }
    const partial = createSidebandApi(registry(c))
    const text = "body\n\n{{ack||}}\n\n{{note||a}}"
    const t = partial.trailing(text)
    expect(t.bodyEnd).toBe(4)
    expect(t.nodes.map((n) => [n.kind, n.span.start])).toEqual([
      ["ack", 6],
      ["note", 17],
    ])
    // A long body before the region does not change the result.
    const long = `${"x".repeat(50_000)}\n\n{{ack||}}\n\n{{note||a}}`
    expect(partial.trailing(long).bodyEnd).toBe(50_000)
  })

  it("trailingStart is a hint: a wrong or late hint falls back to parse", () => {
    // Hint correct: the nodes after it cover the text to its end.
    const ok = "body\n\n{{note||a}}\n\n{{ack||}}\n"
    expect(api.trailing(ok).bodyEnd).toBe(4)
    expect(api.trailing(ok).nodes.map((n) => n.kind)).toEqual(["note", "ack"])
    // Hint wrong: a match of the probe, but no node after it.
    const wrong = "body {{note||x}}\n\n{{broken"
    expect(api.trailing(wrong)).toEqual({ bodyEnd: wrong.length, nodes: [] })
    // Hint wrong: the probe is in the body, then text follows the node.
    const gap = "a\n\n{{note||x}} more text"
    expect(api.trailing(gap)).toEqual({ bodyEnd: gap.length, nodes: [] })
    // Hint too late: the hint does not know this join, so it gives the text end.
    const late = "body\n{{ack||}} {{note||a}}"
    const t = api.trailing(late)
    expect(t.bodyEnd).toBe(4)
    expect(t.nodes.map((n) => n.kind)).toEqual(["ack", "note"])
    expect(api.trailing("plain").bodyEnd).toBe(5)
  })
})

describe("strip lenient, leadingKind and kindInfo", () => {
  /** The stub with `stripLenient` and `leadingNode`: a `{{kind` part with no `}}` counts. */
  function lenientCodec(calls: unknown[]): SidebandCodec {
    return {
      ...stubCodec(false),
      stripLenient: (text, opts) => {
        calls.push(opts ?? {})
        return text.replace(/\{\{[a-z-]+(\|[^}]*)?(\}\})?/g, opts?.replacement ?? "")
      },
      leadingNode: (text) => {
        const m = /^\s*\{\{([a-z-]+)/.exec(text)
        if (!m) return undefined
        const start = text.indexOf("{{")
        return node(m[1] ?? "", start, start + 2 + (m[1] ?? "").length)
      },
    }
  }

  it("lenient calls the codec stripLenient with kinds, keepBody and replacement", () => {
    const calls: unknown[] = []
    const api = createSidebandApi(registry(lenientCodec(calls)))
    expect(api.strip("a {{note b", { lenient: true })).toBe("a  b")
    expect(
      api.strip("a {{note b", {
        lenient: true,
        replacement: "_",
        keepBody: true,
      }),
    ).toBe("a _ b")
    expect(api.strip("a {{ack b", { lenient: true, direction: "from-model" })).toBe("a  b")
    expect(calls).toEqual([{}, { keepBody: true, replacement: "_" }, { kinds: ["ack"] }])
    // Not lenient: the normal strip (complete nodes only), with the replacement.
    expect(api.strip("a {{note||x}} {{ack b", { replacement: " " })).toBe("a   {{ack b")
  })

  it("lenient falls back to the normal strip when the codec has no stripLenient", () => {
    const api = createSidebandApi(registry(stubCodec(false)))
    expect(api.strip("a {{note||x}} {{note b", { lenient: true })).toBe("a  {{note b")
  })

  it("leadingKind uses leadingNode; the codec decides the kind", () => {
    const api = createSidebandApi(registry(lenientCodec([])))
    expect(api.leadingKind("  {{ack")).toBe("ack")
    expect(api.leadingKind("{{other")).toBe("other")
    expect(api.leadingKind("x {{note")).toBeUndefined()
    expect(api.leadingKind("")).toBeUndefined()
  })

  it("leadingKind falls back to the parse spans", () => {
    const api = createSidebandApi(registry(stubCodec(false)))
    expect(api.leadingKind(" \n{{note||a}} x")).toBe("note")
    expect(api.leadingKind("{{note")).toBeUndefined()
    expect(api.leadingKind("x {{note||a}}")).toBeUndefined()
    expect(api.leadingKind("{{other||}}")).toBe("other")
  })

  it("kindInfo gives the direction and placement of a registered kind", () => {
    const api = createSidebandApi(registry(stubCodec(false)))
    expect(api.kindInfo("ack")).toEqual({
      direction: "from-model",
      placement: "inline",
    })
    expect(api.kindInfo("nope")).toBeUndefined()
    expect(createSidebandApi(registry()).kindInfo("note")).toEqual({
      direction: "to-model",
      placement: "tool-result",
    })
  })

  it("no codec: strip gives the input and leadingKind gives undefined", () => {
    const api = createSidebandApi(registry())
    expect(api.strip("{{note b", { lenient: true })).toBe("{{note b")
    expect(api.leadingKind("{{note||a}}")).toBeUndefined()
    expect(NO_SIDEBAND.leadingKind("{{note||a}}")).toBeUndefined()
    expect(NO_SIDEBAND.kindInfo("note")).toBeUndefined()
  })
})

/** A codec whose `parse` gives fixed nodes (for nesting). */
function fixedCodec(nodes: SidebandNode[]): SidebandCodec {
  return { ...stubCodec(false), parse: () => nodes }
}

function node(kind: string, start: number, end: number): SidebandNode {
  return {
    kind,
    attrs: {},
    body: "",
    selfClosing: false,
    form: "v2",
    span: { start, end },
  }
}

describe("find and replace with nested nodes", () => {
  // "0123456789": parent [1,9), children [2,4) and [5,7), grandchild [5,6).
  const text = "0123456789"
  const nodes = [node("c", 5, 7), node("g", 5, 6), node("p", 1, 9), node("c", 2, 4)]
  const api = createSidebandApi(registry(fixedCodec(nodes)))

  it("find gives only the top-level nodes in order, or all with nested", () => {
    expect(api.find(text).map((n) => n.kind)).toEqual(["p"])
    expect(api.find(text, { nested: true }).map((n) => n.span.start)).toEqual([1, 2, 5, 5])
  })

  it("replace calls fn on the parent first and removes the parent with its children", () => {
    const seen: string[] = []
    const out = api.replace(
      text,
      (n) => {
        seen.push(n.kind)
        return n.kind === "p" ? "P" : undefined
      },
      { nested: true },
    )
    expect(out).toBe("0P9")
    expect(seen).toEqual(["p"])
  })

  it("replace goes into the children of a kept parent", () => {
    const seen: string[] = []
    const out = api.replace(
      text,
      (n) => {
        seen.push(`${n.kind}${n.span.start}`)
        return n.kind === "c" ? "" : undefined
      },
      { nested: true },
    )
    expect(out).toBe("014789")
    expect(seen).toEqual(["p1", "c2", "c5"])
  })

  it("keeps the first of two crossing nodes", () => {
    const cross = createSidebandApi(registry(fixedCodec([node("b", 3, 8), node("a", 1, 5)])))
    expect(cross.replace(text, () => "")).toBe("056789")
    expect(cross.find(text).map((n) => n.kind)).toEqual(["a", "b"])
  })
})

describe("createSidebandApi with no codec", () => {
  it("renders empty text, is not ready, and sends one diagnostic for each kind", () => {
    const seen: string[] = []
    const api = createSidebandApi(registry(), {
      diagnostics: { warn: (id, _m, data) => seen.push(`${id} ${data?.kind}`) },
    })
    expect(api.ready).toBe(false)
    expect(api.render("note", { body: "b" })).toBe("")
    expect(api.render("note")).toBe("")
    expect(api.example("ack")).toBe("")
    expect(seen).toEqual(["sideband.render-dropped note", "sideband.render-dropped ack"])
  })

  it("reads nothing and gives the input back", () => {
    const api = createSidebandApi(registry())
    expect(api.find("{{note||a}}")).toEqual([])
    expect(api.has("{{note||a}}")).toBe(false)
    expect(api.strip("{{note||a}}")).toBe("{{note||a}}")
    expect(api.replace("x", () => "y")).toBe("x")
    expect(api.neutralize("{{x")).toBe("{{x")
    expect(api.trailing("x")).toEqual({ bodyEnd: 1, nodes: [] })
    const out: string[] = []
    const s = api.scanner()
    s.onText((t) => out.push(t))
    s.write("abc")
    s.end()
    expect(out).toEqual(["abc"])
  })

  it("NO_SIDEBAND is empty", () => {
    expect(NO_SIDEBAND.ready).toBe(false)
    expect(NO_SIDEBAND.kinds()).toEqual([])
    // No codec comes first: a bare core has no kind and no codec, so render gives "".
    expect(NO_SIDEBAND.render("x")).toBe("")
    expect(NO_SIDEBAND.has("x")).toBe(false)
  })

  it("name gives the kind string with no codec, also for an unknown kind", () => {
    expect(NO_SIDEBAND.name("x")).toBe("x")
    expect(createSidebandApi(registry()).name("note")).toBe("note")
  })
})

describe("plugin context", () => {
  it("is the API plus parse, and throws with no codec", () => {
    const ctx = createPluginSidebandContext(registry())
    expect(ctx.ready).toBe(false)
    expect(() => ctx.render("note", {})).toThrow(SidebandCodecMissingError)
    const live = createPluginSidebandContext(registry(stubCodec(false)))
    expect(live.ready).toBe(true)
    expect(live.has("{{note||}}")).toBe(true)
    expect(live.parse("{{note||}}").length).toBe(1)
  })
})

describe("registry core kind names (D1 revised)", () => {
  const core = kind({ kind: "policy" })

  it("any plugin can declare a core kind name", () => {
    const r = createSidebandRegistry()
    r.register(core, "owner")
    expect(r.kind("policy")?.owner).toBe("owner")
  })

  it("a second plugin with the same core kind name is a duplicate", () => {
    const r = createSidebandRegistry()
    r.register(core, "owner")
    expect(() => r.register(core, "other")).toThrow(SidebandKindDuplicateError)
    expect(r.kind("policy")?.owner).toBe("owner")
  })

  it("owner core is still rejected", () => {
    const r = createSidebandRegistry()
    try {
      r.register(core, "core")
      throw new Error("unreachable")
    } catch (e) {
      expect(e).toBeInstanceOf(SidebandKindInvalidError)
      expect((e as SidebandKindInvalidError).rule).toBe("core-owner")
    }
  })
})

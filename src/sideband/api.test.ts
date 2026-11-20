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
    attrs: { count: { type: "int" }, ok: { type: "bool" }, lvl: { type: "enum", values: ["a"] } },
    body: "text",
    trust: "harness",
    summary: "s",
    ...over,
  }
}

function registry(codec?: SidebandCodec): SidebandRegistry {
  const r = createSidebandRegistry()
  r.register(kind(), "p")
  r.register(kind({ kind: "ack", direction: "from-model", placement: "inline", attrs: {} }), "p")
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

/** A codec whose `parse` gives fixed nodes (for nesting). */
function fixedCodec(nodes: SidebandNode[]): SidebandCodec {
  return { ...stubCodec(false), parse: () => nodes }
}

function node(kind: string, start: number, end: number): SidebandNode {
  return { kind, attrs: {}, body: "", selfClosing: false, form: "v2", span: { start, end } }
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

describe("registry coreKindOwners", () => {
  const core = kind({ kind: "policy" })

  it("a plugin in the owner set can declare a core kind", () => {
    const r = createSidebandRegistry({ coreKindOwners: new Set(["owner"]) })
    r.register(core, "owner")
    expect(r.kind("policy")?.owner).toBe("owner")
  })

  it("a plugin out of the owner set is still rejected", () => {
    const r = createSidebandRegistry({ coreKindOwners: new Set(["owner"]) })
    try {
      r.register(core, "other")
      throw new Error("unreachable")
    } catch (e) {
      expect(e).toBeInstanceOf(SidebandKindInvalidError)
      expect((e as SidebandKindInvalidError).rule).toBe("core-kind")
    }
  })

  it("the owner set does not allow owner core", () => {
    const r = createSidebandRegistry({ coreKindOwners: new Set(["core"]) })
    expect(() => r.register(core, "core")).toThrow(SidebandKindInvalidError)
  })
})

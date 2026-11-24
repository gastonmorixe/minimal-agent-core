/**
 * Tests of the display members of the sideband API (`hasDisplay`,
 * `displayNode`, `display`). The stub codec reads `[kind:id]` as a
 * self-closing node and `((body))` as a `box` node around its body. The kind
 * `fake` stands for any plugin kind: core knows no kind name.
 */

import { describe, expect, it } from "bun:test"

import type { SidebandDisplayHandler } from "@minimal-agent/core/plugin-api/types/plugin"
import { displayWidth } from "@minimal-agent/core/plugin-api/utils/term-width"

import { createSidebandApi, NO_SIDEBAND, type SidebandApiRegistry } from "./api.ts"
import { cleanDisplayLabel, DISPLAY_LABEL_CELLS, type SidebandDisplayEntry } from "./display.ts"
import { SidebandCodecMissingError } from "./errors.ts"
import type { SidebandCodec, SidebandKind, SidebandNode } from "./types.ts"

const NODE_RE = /\{([a-z]+):([^}]*)\}/g
const BOX_RE = /\(\(([^)]*)\)\)/g

const codec: SidebandCodec = {
  id: "stub",
  render: (k, m) => `{${k.kind}:${String(m.attrs?.id ?? "")}}`,
  parse: (text) => {
    const out: SidebandNode[] = []
    for (const m of text.matchAll(NODE_RE)) {
      const start = m.index ?? 0
      out.push({
        kind: m[1] ?? "",
        attrs: { id: m[2] ?? "" },
        selfClosing: true,
        form: "v2",
        span: { start, end: start + m[0].length },
      })
    }
    for (const m of text.matchAll(BOX_RE)) {
      const start = m.index ?? 0
      out.push({
        kind: "box",
        attrs: {},
        body: m[1] ?? "",
        selfClosing: false,
        form: "v2",
        span: { start, end: start + m[0].length },
      })
    }
    return out
  },
  scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
  neutralize: (t) => t.replaceAll("[", "[ "),
  example: () => "",
}

const decl = (name: string): SidebandKind => ({
  kind: name,
  owner: "owner-plugin",
  direction: "to-model",
  placement: "inline",
  attrs: { id: { type: "string" } },
  body: "none",
  trust: "untrusted",
  summary: "s",
})

interface Setup {
  handlers?: Record<string, SidebandDisplayHandler>
  host?: boolean
  noCodec?: boolean
}

function setup(s: Setup = {}) {
  const kinds = [decl("fake"), decl("other"), decl("box")]
  const warns: Array<Record<string, unknown>> = []
  const entries = new Map<string, SidebandDisplayEntry>()
  for (const [k, fn] of Object.entries(s.handlers ?? {})) {
    entries.set(k, { owner: "owner-plugin", fn, host: s.host === true })
  }
  const scopes: Array<string | undefined> = []
  const registry: SidebandApiRegistry = {
    kind: (n) => kinds.find((k) => k.kind === n),
    kinds: () => kinds,
    codec: () => codec,
    display: (k) => entries.get(k),
  }
  const api = createSidebandApi(s.noCodec === true ? { ...registry, codec: noCodec } : registry, {
    diagnostics: { warn: (source, _m, data) => warns.push({ source, ...data }) },
    displayHost: (id) => ({ capabilities: [], id }) as never,
    displayScope: (sid, fn) => {
      scopes.push(sid)
      return fn()
    },
  })
  return { api, warns, scopes }
}

function noCodec(): SidebandCodec {
  throw new SidebandCodecMissingError()
}

const label: SidebandDisplayHandler = (n) => ({ label: `[F #${n.attrs.id}]`, text: "body" })

describe("sideband display", () => {
  it("hasDisplay false with no handler", () => {
    const { api } = setup({ handlers: { fake: label } })
    expect(api.hasDisplay("fake")).toBe(true)
    expect(api.hasDisplay("other")).toBe(false)
    expect(api.hasDisplay("nope")).toBe(false)
    const r = api.display("a {other:1} b", { mode: "full" })
    expect(r).toEqual({ segments: [{ type: "text", text: "a {other:1} b" }], changed: false })
  })

  it("label is cleaned and cut to 80 cells", () => {
    const esc = String.fromCodePoint(0x1b)
    const raw = `${esc}[31mred${esc}[0m\tline\none\u0000\u200b\u2028x${esc}]0;title\u0007`
    const { api } = setup({ handlers: { fake: () => ({ label: raw }) } })
    const node = api.find("{fake:1}")[0] as SidebandNode
    expect(api.displayNode(node, { mode: "label" })?.label).toBe("red line one x")
    expect(cleanDisplayLabel("w".repeat(200))).toHaveLength(DISPLAY_LABEL_CELLS)
    expect(cleanDisplayLabel("w".repeat(200)).endsWith("...")).toBe(true)
    // Wide chars count 2 cells.
    expect(displayWidth(cleanDisplayLabel("\u4e00".repeat(100)))).toBeLessThanOrEqual(
      DISPLAY_LABEL_CELLS,
    )
    // An empty label after the clean is no display.
    const empty = setup({ handlers: { fake: () => ({ label: " \u0007 " }) } })
    expect(empty.api.displayNode(node, { mode: "label" })).toBeUndefined()
  })

  it("text dropped in label mode", () => {
    const { api } = setup({
      handlers: { fake: () => ({ label: "L", text: "t", truncated: true }) },
    })
    const node = api.find("{fake:1}")[0] as SidebandNode
    expect(api.displayNode(node, { mode: "label" })).toEqual({ label: "L" })
    expect(api.displayNode(node, { mode: "full" })).toEqual({
      label: "L",
      text: "t",
      truncated: true,
    })
  })

  it("missing drops the text", () => {
    const { api } = setup({ handlers: { fake: () => ({ label: "L", text: "t", missing: true }) } })
    const node = api.find("{fake:1}")[0] as SidebandNode
    expect(api.displayNode(node, { mode: "full" })).toEqual({ label: "L", missing: true })
  })

  it("a throw warns one time and gives undefined", () => {
    const { api, warns } = setup({
      handlers: {
        fake: () => {
          throw new Error("boom")
        },
      },
    })
    const r = api.display("{fake:1} {fake:2}", { mode: "full" })
    expect(r.changed).toBe(false)
    expect(api.displayNode(api.find("{fake:3}")[0] as SidebandNode, { mode: "label" })).toBe(
      undefined,
    )
    expect(warns).toEqual([
      {
        source: "sideband.display-failed",
        pluginId: "owner-plugin",
        kind: "fake",
        reason: "error",
      },
    ])
  })

  it("a thenable result gives undefined", () => {
    let rejected = false
    const { api, warns } = setup({
      handlers: {
        fake: () => {
          const p = Promise.reject(new Error("late"))
          p.catch(() => {
            rejected = true
          })
          return p as never
        },
        other: () => ({ then: () => {} }) as never,
      },
    })
    expect(api.displayNode(api.find("{fake:1}")[0] as SidebandNode, { mode: "full" })).toBe(
      undefined,
    )
    expect(api.display("{other:1}", { mode: "full" }).changed).toBe(false)
    expect(warns.map((w) => [w.kind, w.reason])).toEqual([
      ["fake", "async"],
      ["other", "async"],
    ])
    return Promise.resolve().then(() => expect(rejected).toBe(true))
  })

  it("a bad result warns bad-result", () => {
    const { api, warns } = setup({ handlers: { fake: () => ({ text: "no label" }) as never } })
    expect(api.display("{fake:1}", { mode: "full" }).changed).toBe(false)
    expect(warns.map((w) => w.reason)).toEqual(["bad-result"])
  })

  it("a result getter that throws warns error and never throws", () => {
    const bad = {
      get label(): string {
        throw new Error("boom")
      },
    }
    const { api, warns } = setup({ handlers: { fake: () => bad as never } })
    const node = api.find("{fake:1}")[0] as SidebandNode
    expect(() => api.displayNode(node, { mode: "full" })).not.toThrow()
    expect(api.displayNode(node, { mode: "full" })).toBeUndefined()
    expect(api.display("a {fake:2} b", { mode: "full" }).changed).toBe(false)
    expect(warns.map((w) => [w.kind, w.reason])).toEqual([["fake", "error"]])
  })

  it("code-point spans with astral chars", () => {
    const { api } = setup({ handlers: { fake: label } })
    const text = "\u{1F600}a {fake:x1} \u{1F600}{fake:y} z"
    const r = api.display(text, { mode: "label" })
    expect(r.changed).toBe(true)
    expect(r.segments.map((s) => s.type)).toEqual(["text", "node", "text", "node", "text"])
    const nodes = r.segments.filter((s) => s.type === "node")
    const cps = Array.from(text)
    for (const n of nodes) {
      if (n.type !== "node") continue
      expect(cps.slice(n.cp.start, n.cp.end).join("")).toBe(
        text.slice(n.node.span.start, n.node.span.end),
      )
    }
    expect(nodes[0]?.type === "node" ? nodes[0].cp : undefined).toEqual({ start: 3, end: 12 })
    // The segments join back to the input.
    const joined = r.segments
      .map((s) => (s.type === "text" ? s.text : text.slice(s.node.span.start, s.node.span.end)))
      .join("")
    expect(joined).toBe(text)
  })

  it("nested node is not displayed", () => {
    const { api } = setup({ handlers: { fake: label } })
    const r = api.display("((in {fake:1} box)) {fake:2}", { mode: "full" })
    expect(r.changed).toBe(true)
    const nodes = r.segments.filter((s) => s.type === "node")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.type === "node" ? nodes[0].node.attrs.id : "").toBe("2")
    expect(r.segments[0]).toEqual({ type: "text", text: "((in {fake:1} box)) " })
  })

  it("a node with no display stays in a text segment, kinds option limits", () => {
    const { api } = setup({ handlers: { fake: label, other: () => undefined } })
    const r = api.display("{other:1} {fake:2}", { mode: "full" })
    expect(r.segments[0]).toEqual({ type: "text", text: "{other:1} " })
    expect(api.display("{fake:2}", { mode: "full", kinds: ["other"] }).changed).toBe(false)
  })

  it("the handler gets sid, mode, maxBytes, the read slice and the host only with host:true", () => {
    const seen: unknown[] = []
    const spy: SidebandDisplayHandler = (_n, ctx) => {
      seen.push({
        sid: ctx.sid,
        mode: ctx.mode,
        maxBytes: ctx.maxBytes,
        host: ctx.host,
        neutral: ctx.sideband.neutralize("[x"),
        render: "render" in ctx.sideband,
      })
      return { label: "L" }
    }
    const withHost = setup({ handlers: { fake: spy }, host: true })
    withHost.api.display("{fake:1}", { mode: "full", sid: "s1", maxBytes: 9 })
    expect(withHost.scopes).toEqual(["s1"])
    const noHost = setup({ handlers: { fake: spy } })
    noHost.api.display("{fake:1}", { mode: "label" })
    expect(noHost.scopes).toEqual([undefined])
    expect(seen).toEqual([
      {
        sid: "s1",
        mode: "full",
        maxBytes: 9,
        host: { capabilities: [], id: "owner-plugin" },
        neutral: "[ x",
        render: false,
      },
      {
        sid: undefined,
        mode: "label",
        maxBytes: undefined,
        host: undefined,
        neutral: "[ x",
        render: false,
      },
    ])
  })

  it("no codec gives one text segment", () => {
    const { api } = setup({ handlers: { fake: label }, noCodec: true })
    expect(api.hasDisplay("fake")).toBe(true)
    expect(api.display("{fake:1}", { mode: "full" })).toEqual({
      segments: [{ type: "text", text: "{fake:1}" }],
      changed: false,
    })
  })

  it("NO_SIDEBAND has the members", () => {
    expect(NO_SIDEBAND.hasDisplay("fake")).toBe(false)
    expect(NO_SIDEBAND.display("x", { mode: "full" })).toEqual({
      segments: [{ type: "text", text: "x" }],
      changed: false,
    })
    const n: SidebandNode = {
      kind: "fake",
      attrs: {},
      selfClosing: true,
      form: "v2",
      span: { start: 0, end: 1 },
    }
    expect(NO_SIDEBAND.displayNode(n, { mode: "label" })).toBeUndefined()
  })
})

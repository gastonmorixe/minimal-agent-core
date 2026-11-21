/**
 * `createSidebandApi` over the real codec of the sibling plugins checkout
 * (`test-utils/sideband-fixture.ts`). Round trips only: this file holds no
 * wire form.
 */

import { describe, expect, it } from "bun:test"

import { fixtureSideband, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import type { SidebandKind } from "./types.ts"

const KIND: SidebandKind = {
  kind: "fixture-note",
  owner: "",
  direction: "to-model",
  placement: "tool-result",
  attrs: { count: { type: "int" }, level: { type: "enum", values: ["warn", "final"] } },
  body: "text",
  trust: "harness",
  summary: "fixture kind",
}

describe.skipIf(!sidebandFixturePresent())("sideband API on the real codec", () => {
  const sb = fixtureSideband({ extraKinds: [[KIND, "fixture-plugin"]] })

  it("render, find, attrs and strip round trip", () => {
    expect(sb.ready).toBe(true)
    const tag = sb.render("fixture-note", { attrs: { count: 3, level: "warn" }, body: "hi" })
    expect(tag).not.toBe("")
    const text = `body\n\n${tag}`
    const [node] = sb.find(text, { kinds: ["fixture-note"] })
    expect(node?.body).toBe("hi")
    expect(sb.attrs(node as NonNullable<typeof node>)).toEqual({ count: 3, level: "warn" })
    expect(sb.trailing(text).bodyEnd).toBe(4)
    expect(sb.strip(text)).toBe("body\n\n")
    expect(sb.startsWith(tag)).toBe(true)
  })

  it("throws for an unknown kind", () => {
    expect(() => sb.render("no-such-kind")).toThrow()
  })
})

describe.skipIf(!sidebandFixturePresent())("trailing on the real codec and the core kinds", () => {
  const sb = fixtureSideband()

  it("gives the whole region raw-output + output-preview + mode-active (the hint misses raw-output)", () => {
    const raw = sb.render("raw-output", {
      attrs: { path: "/tmp/x.raw", size: "8.6kB", sha256: "c2" },
    })
    const preview = sb.render("output-preview", {
      attrs: { shown: 10, total: 14, tool: "Bash" },
      body: "hint",
    })
    const mode = sb.render("mode-active", { attrs: { id: "ask", since: "2026-11-21" } })
    expect([raw, preview, mode]).not.toContain("")
    const text = `1\n2\n3\n\n${raw}\n\n${preview}\n\n${mode}`
    const t = sb.trailing(text)
    expect(t.bodyEnd).toBe(5)
    expect(t.nodes.map((n) => n.kind)).toEqual(["raw-output", "output-preview", "mode-active"])
    expect(sb.trailing(`1\n\n${raw}\n\n${preview}`).bodyEnd).toBe(1)
  })
})

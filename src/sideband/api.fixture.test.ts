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

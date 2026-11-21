/**
 * `createSidebandApi` over the real codec of the sibling plugins checkout
 * (`test-utils/sideband-fixture.ts`). Round trips only: this file holds no
 * wire form.
 */

import { describe, expect, it } from "bun:test"

import type { ToolAnnotation } from "../../plugin-api/src/types/tool-outcome.ts"
import { finalizeOutcome } from "../loops/tool-outcome-finalize.ts"
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

describe.skipIf(!sidebandFixturePresent())(
  "trailing: one bodyEnd rule (the tool round join)",
  () => {
    const sb = fixtureSideband()
    const raw = sb.render("raw-output", { attrs: { path: "/p", size: "1", sha256: "x" } })
    const preview = sb.render("output-preview", { attrs: { shown: 1, total: 2 } })
    const mode = sb.render("mode-active", { attrs: { id: "ask", since: "s" } })
    const all = { kinds: sb.kinds().map((k) => k.kind) }
    const cut = (t: string, q?: Parameters<typeof sb.trailing>[1]) =>
      t.slice(0, sb.trailing(t, q).bodyEnd)

    it("a body that ends with a line feed keeps it, with one node or two", () => {
      const body = "file1\nfile2\n"
      expect(cut(`${body}\n\n${preview}`)).toBe(body)
      expect(cut(`${body}\n\n${raw}\n\n${preview}`)).toBe(body)
    })

    it("a kinds filter gives the same cut as no filter", () => {
      for (const t of [`foo\n\n\n${preview}`, `foo\n\n\n${raw}\n\n${preview}`, `foo\n\n\n${raw}`]) {
        expect(cut(t)).toBe("foo\n")
        expect(cut(t, { kinds: ["raw-output", "output-preview"] })).toBe("foo\n")
        expect(cut(t, all)).toBe("foo\n")
      }
    })

    it("equals the persisted bodyEnd of finalizeOutcome", () => {
      const ann = (kind: string, text: string, joinWhenEmpty?: boolean): ToolAnnotation => ({
        kind,
        text,
        join: "\n\n",
        owner: "core",
        ...(joinWhenEmpty === undefined ? {} : { joinWhenEmpty }),
      })
      const sets: ToolAnnotation[][] = [
        [ann("output-preview", preview)],
        [ann("raw-output", raw), ann("output-preview", preview)],
        [ann("raw-output", raw), ann("output-preview", preview), ann("mode-active", mode, false)],
        [ann("mode-active", mode, false)],
      ]
      for (const body of ["file1\nfile2\n", "foo\n\n", "x", " ", "a \n", ""]) {
        for (const annotations of sets) {
          const fin = finalizeOutcome({ body: { text: body }, annotations })
          expect(sb.trailing(fin.text).bodyEnd).toBe(fin.bodyEnd)
          expect(sb.trailing(fin.text, all).bodyEnd).toBe(fin.bodyEnd)
        }
      }
    })

    it("a long body: the tail window gives the same result as a full parse", () => {
      const body = `${"x".repeat(400_000)}\n`
      const t = `${body}\n\n${raw}\n\n${preview}`
      const r = sb.trailing(t)
      expect(r.bodyEnd).toBe(body.length)
      expect(r.nodes.map((n) => [n.kind, t.slice(n.span.start, n.span.end)])).toEqual([
        ["raw-output", raw],
        ["output-preview", preview],
      ])
      // White space to the window start: the full parse finds the earlier node.
      const spaced = `body\n\n${raw}${" ".repeat(400_000)}${preview}`
      expect(sb.trailing(spaced).bodyEnd).toBe(4)
      expect(sb.trailing(spaced).nodes.map((n) => n.kind)).toEqual(["raw-output", "output-preview"])
    })

    it.skipIf(process.env.CI !== undefined)(
      "perf: no filter is not slower than 1.5x the filtered path (3.7MB body, 2 tags)",
      () => {
        const body = Array.from({ length: 200_000 }, (_, i) => `line <b>${i}</b>`).join("\n")
        const t = `${body}\n\n${raw}\n\n${preview}`
        const best = (f: () => unknown): number => {
          let min = Number.POSITIVE_INFINITY
          for (let i = 0; i < 5; i++) {
            const s = performance.now()
            f()
            min = Math.min(min, performance.now() - s)
          }
          return min
        }
        const plain = best(() => sb.trailing(t))
        const filtered = best(() => sb.trailing(t, all))
        const full = best(() => sb.find(t, { legacyText: true }))
        // 0.5 ms slack: both paths take less than 1 ms, so timer noise counts.
        expect(plain).toBeLessThanOrEqual(1.5 * filtered + 0.5)
        // The tail window does not parse the body.
        expect(plain).toBeLessThanOrEqual(1.5 * full)
      },
    )
  },
)

/**
 * Tests for the pure config overlay renderer.
 *
 * @module config/lib/render.test
 */

import { describe, expect, it } from "bun:test"

import { stripSgr } from "./palette.ts"
import { type RenderModel, type RenderRow, render } from "./render.ts"

const rows: RenderRow[] = [
  { type: "section", label: "Model & reasoning" },
  {
    type: "field",
    label: "model",
    valueText: "(cli/env/default)",
    dirty: false,
    unset: true,
    affordance: "⏎ edit",
  },
  {
    type: "field",
    label: "effort",
    valueText: "high",
    dirty: true,
    unset: false,
    affordance: "←/→",
  },
  { type: "action", label: "Save", tone: "save" },
  { type: "action", label: "Close", tone: "close" },
]

function model(over: Partial<RenderModel> = {}): RenderModel {
  return {
    path: "/home/u/.minimal-agent/config.jsonc",
    rows,
    selectedSelectableIndex: 0,
    dirtyCount: 1,
    phase: { kind: "browse" },
    error: null,
    cols: 100,
    maxRows: 8,
    ...over,
  }
}

const plain = (lines: string[]): string => lines.map(stripSgr).join("\n")

describe("render — structure", () => {
  it("renders a header with the path and an unsaved chip", () => {
    const out = plain(render(model()))
    expect(out).toContain("config")
    expect(out).toContain(".minimal-agent/config.jsonc")
    expect(out).toContain("1 unsaved")
  })

  it("shows (saved) when there are no staged edits", () => {
    const out = plain(render(model({ dirtyCount: 0 })))
    expect(out).toContain("(saved)")
  })

  it("draws a top divider rule right under the header (common chrome)", () => {
    const out = render(model())
    // Line 0 = header, line 1 = the full-width rule, then content.
    const ruleLine = stripSgr(out[1]!)
    expect(ruleLine).toMatch(/^\s*\u2500{4,}\s*$/)
  })

  it("renders section headers, fields, and action rows", () => {
    const out = plain(render(model()))
    expect(out).toContain("MODEL & REASONING")
    expect(out).toContain("model")
    expect(out).toContain("effort")
    expect(out).toContain("Save")
    expect(out).toContain("Close")
  })

  it("draws the selection arrow on the selected row", () => {
    const out0 = render(model({ selectedSelectableIndex: 0 }))
    expect(stripSgr(out0.find((l) => l.includes("model"))!)).toContain("►")
  })

  it("browse hint shows nav chips; edit hint shows typing chips", () => {
    expect(plain(render(model()))).toContain("←/→ change")
    const editing = plain(
      render(
        model({
          selectedSelectableIndex: 0,
          phase: { kind: "edit", label: "model", draft: "claude-x" },
        }),
      ),
    )
    expect(editing).toContain("type to edit")
    expect(editing).toContain("claude-x")
  })
})

describe("render — error + width", () => {
  it("renders a parse-error banner instead of rows", () => {
    const out = plain(render(model({ error: "Unexpected token" })))
    expect(out).toContain("parse error: Unexpected token")
    expect(out).not.toContain("MODEL & REASONING")
  })

  it("never emits a line wider than cols", () => {
    const lines = render(model({ cols: 40 }))
    for (const l of lines) {
      expect(stripSgr(l).length).toBeLessThanOrEqual(40)
    }
  })

  it("windows long row lists and shows a 'more' affordance", () => {
    const many: RenderRow[] = [{ type: "section", label: "S" }]
    for (let i = 0; i < 20; i++) {
      many.push({
        type: "field",
        label: `f${i}`,
        valueText: "x",
        dirty: false,
        unset: false,
        affordance: "",
      })
    }
    const out = plain(render(model({ rows: many, maxRows: 5, selectedSelectableIndex: 0 })))
    expect(out).toMatch(/↓ \d+ more/)
  })
})

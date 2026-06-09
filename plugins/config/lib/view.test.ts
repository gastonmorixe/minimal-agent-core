/**
 * Tests for the view-model bridge (ConfigModel + FSM state → rows + render).
 *
 * @module config/lib/view.test
 */

import { describe, expect, it } from "bun:test"

import type { State } from "./fsm.ts"
import { ConfigModel, type FsDeps } from "./model.ts"
import type { Field } from "./schema.ts"
import { effectiveValue, formatValue, fsmRows, renderModel } from "./view.ts"

const FIELDS: Field[] = [
  {
    id: "effort",
    label: "effort",
    help: "h",
    kind: "enum",
    path: ["effort"],
    choices: ["low", "high"],
    section: "A",
    defaultHint: "high",
  },
  {
    id: "autoAsk",
    label: "autoAsk",
    help: "h",
    kind: "boolean",
    path: ["autoAsk"],
    section: "A",
    defaultHint: "on",
  },
  {
    id: "model",
    label: "model",
    help: "h",
    kind: "string",
    path: ["model"],
    section: "B",
    defaultHint: "(default)",
  },
]

function fakeFs(initial: string | null): FsDeps {
  let cur = initial
  return {
    path: "/fake/config.jsonc",
    read: () => cur,
    write: (t) => {
      cur = t
    },
  }
}

function loadModel(json: string | null): ConfigModel {
  return ConfigModel.load(fakeFs(json), { fields: FIELDS })
}

function openState(
  over: Partial<Extract<State, { kind: "open" }>> = {},
): Extract<State, { kind: "open" }> {
  return { kind: "open", selectedIndex: 0, scrollOffset: 0, phase: { kind: "browse" }, ...over }
}

describe("effectiveValue", () => {
  it("prefers a staged value over disk", () => {
    const m = loadModel(`{ "effort": "high" }`)
    m.set("effort", "low")
    expect(effectiveValue(m.value(FIELDS[0]!))).toBe("low")
  })

  it("a staged clear reads as undefined", () => {
    const m = loadModel(`{ "effort": "high" }`)
    m.clear("effort")
    expect(effectiveValue(m.value(FIELDS[0]!))).toBeUndefined()
  })
})

describe("fsmRows", () => {
  it("emits a field row per field then 3 action rows", () => {
    const m = loadModel(`{}`)
    const rows = fsmRows(m)
    expect(rows.filter((r) => r.type === "field")).toHaveLength(3)
    const actions = rows.filter((r) => r.type === "action")
    expect(actions.map((a) => (a as { action: string }).action)).toEqual([
      "save",
      "revert",
      "close",
    ])
  })

  it("carries fieldKind, choices, and effective value", () => {
    const m = loadModel(`{ "effort": "high" }`)
    const first = fsmRows(m)[0]!
    expect(first).toMatchObject({
      type: "field",
      fieldId: "effort",
      fieldKind: "enum",
      choices: ["low", "high"],
      effective: "high",
    })
  })
})

describe("formatValue", () => {
  it("shows 'unset → hint' for missing values", () => {
    expect(formatValue(FIELDS[0]!, undefined)).toEqual({ text: "unset → high", unset: true })
  })
  it("renders booleans + lists + scalars", () => {
    expect(formatValue(FIELDS[1]!, true)).toEqual({ text: "true", unset: false })
    const listField: Field = { ...FIELDS[2]!, kind: "string-list" }
    expect(formatValue(listField, ["a", "b"])).toEqual({ text: "a, b", unset: false })
    expect(formatValue(FIELDS[2]!, "claude")).toEqual({ text: "claude", unset: false })
  })
})

describe("renderModel", () => {
  it("interleaves section headers and threads dirty count", () => {
    const m = loadModel(`{ "effort": "high" }`)
    m.set("effort", "low")
    const rm = renderModel(m, openState(), 100, 8)
    const sections = rm.rows
      .filter((r) => r.type === "section")
      .map((r) => (r as { label: string }).label)
    expect(sections).toEqual(["A", "B"])
    expect(rm.dirtyCount).toBe(1)
    expect(rm.path).toBe("/fake/config.jsonc")
  })

  it("projects an edit phase with the field label + draft", () => {
    const m = loadModel(`{ "model": "claude" }`)
    const rm = renderModel(
      m,
      openState({ phase: { kind: "edit", fieldId: "model", fieldKind: "string", draft: "gpt" } }),
      100,
      8,
    )
    expect(rm.phase).toEqual({ kind: "edit", label: "model", draft: "gpt" })
  })

  it("passes through a parse error", () => {
    const m = loadModel(`{ broken`)
    const rm = renderModel(m, openState(), 100, 8)
    expect(rm.error).not.toBeNull()
  })
})

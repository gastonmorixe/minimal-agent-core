/**
 * Tests for the pure config-overlay FSM.
 *
 * @module config/lib/fsm.test
 */

import { describe, expect, it } from "bun:test"

import {
  CLOSED,
  cycleBoolean,
  cycleEnum,
  draftToEffect,
  type Effect,
  type Row,
  type State,
  transition,
  valueToDraft,
} from "./fsm.ts"

const rows: Row[] = [
  {
    type: "field",
    fieldId: "effort",
    fieldKind: "enum",
    choices: ["low", "high"],
    effective: undefined,
  },
  { type: "field", fieldId: "autoAsk", fieldKind: "boolean", effective: undefined },
  { type: "field", fieldId: "model", fieldKind: "string", effective: "claude" },
  { type: "action", action: "save" },
  { type: "action", action: "revert" },
  { type: "action", action: "close" },
]
const ctx = { rows }

function open(): Extract<State, { kind: "open" }> {
  const r = transition(CLOSED, { kind: "open" }, ctx)
  if (r.state.kind !== "open") throw new Error("expected open")
  return r.state
}

const kinds = (effs: Effect[]): string[] => effs.map((e) => e.kind)

describe("open / close", () => {
  it("open → open state at index 0, browse phase, repaint", () => {
    const r = transition(CLOSED, { kind: "open" }, ctx)
    expect(r.state.kind).toBe("open")
    if (r.state.kind !== "open") throw new Error()
    expect(r.state.selectedIndex).toBe(0)
    expect(r.state.phase.kind).toBe("browse")
    expect(kinds(r.effects)).toContain("repaint")
  })

  it("Escape closes and halts", () => {
    const r = transition(open(), { kind: "key", name: "Escape" }, ctx)
    expect(r.state.kind).toBe("closed")
    expect(kinds(r.effects)).toEqual(["close", "halt"])
  })

  it("explicit close event closes", () => {
    expect(transition(open(), { kind: "close" }, ctx).state.kind).toBe("closed")
  })
})

describe("browse navigation", () => {
  it("ArrowDown/Up move selection and halt", () => {
    let s = open()
    let r = transition(s, { kind: "key", name: "ArrowDown" }, ctx)
    s = r.state as Extract<State, { kind: "open" }>
    expect(s.selectedIndex).toBe(1)
    expect(kinds(r.effects)).toContain("halt")
    r = transition(s, { kind: "key", name: "ArrowUp" }, ctx)
    s = r.state as Extract<State, { kind: "open" }>
    expect(s.selectedIndex).toBe(0)
  })

  it("clamps at both ends", () => {
    let s = open()
    const r = transition(s, { kind: "key", name: "ArrowUp" }, ctx)
    expect((r.state as Extract<State, { kind: "open" }>).selectedIndex).toBe(0)
    // walk to the bottom
    for (let i = 0; i < 20; i++) {
      s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
        State,
        { kind: "open" }
      >
    }
    expect(s.selectedIndex).toBe(rows.length - 1)
  })
})

describe("enum + boolean cycling in browse", () => {
  it("ArrowRight on enum stages the first choice", () => {
    const r = transition(open(), { kind: "key", name: "ArrowRight" }, ctx)
    expect(r.effects[0]).toEqual({ kind: "stage-set", fieldId: "effort", value: "low" })
  })

  it("ArrowLeft on enum from unset wraps to the last choice", () => {
    const r = transition(open(), { kind: "key", name: "ArrowLeft" }, ctx)
    expect(r.effects[0]).toEqual({ kind: "stage-set", fieldId: "effort", value: "high" })
  })

  it("cycleEnum walks unset → choices → back to unset", () => {
    expect(cycleEnum("f", ["a", "b"], undefined, 1)).toEqual({
      kind: "stage-set",
      fieldId: "f",
      value: "a",
    })
    expect(cycleEnum("f", ["a", "b"], "a", 1)).toEqual({
      kind: "stage-set",
      fieldId: "f",
      value: "b",
    })
    expect(cycleEnum("f", ["a", "b"], "b", 1)).toEqual({ kind: "stage-clear", fieldId: "f" })
  })

  it("cycleBoolean walks unset → true → false → unset", () => {
    expect(cycleBoolean("f", undefined, 1)).toEqual({
      kind: "stage-set",
      fieldId: "f",
      value: true,
    })
    expect(cycleBoolean("f", true, 1)).toEqual({ kind: "stage-set", fieldId: "f", value: false })
    expect(cycleBoolean("f", false, 1)).toEqual({ kind: "stage-clear", fieldId: "f" })
  })
})

describe("entering + leaving edit mode", () => {
  it("Enter on a string field enters edit, primes buffer with current value", () => {
    let s = open()
    // move to the model row (index 2)
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    const r = transition(s, { kind: "key", name: "Enter" }, ctx)
    const st = r.state as Extract<State, { kind: "open" }>
    expect(st.phase.kind).toBe("edit")
    if (st.phase.kind !== "edit") throw new Error()
    expect(st.phase.fieldId).toBe("model")
    // Seeds the draft with the current value (no prompt-buffer prime — the
    // overlay owns input; the draft renders inline).
    expect(st.phase.draft).toBe("claude")
    expect(kinds(r.effects)).not.toContain("set-buffer")
  })

  it("char events append to the draft while editing", () => {
    let s = open()
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    // Enter edit on `model`; current value is "claude" (from CONFIG below).
    s = transition(s, { kind: "key", name: "Enter" }, ctx).state as Extract<State, { kind: "open" }>
    s = transition(s, { kind: "char", ch: "-" }, ctx).state as Extract<State, { kind: "open" }>
    s = transition(s, { kind: "char", ch: "x" }, ctx).state as Extract<State, { kind: "open" }>
    const st = s.phase
    if (st.kind !== "edit") throw new Error()
    expect(st.draft).toBe("claude-x")
  })

  it("Backspace trims the draft while editing", () => {
    let s = open()
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "Enter" }, ctx).state as Extract<State, { kind: "open" }>
    const r = transition(s, { kind: "key", name: "Backspace" }, ctx)
    const st = (r.state as Extract<State, { kind: "open" }>).phase
    if (st.kind !== "edit") throw new Error()
    expect(st.draft).toBe("claud") // "claude" minus one
    expect(kinds(r.effects)).toContain("halt")
  })

  it("legacy buffer events still set the draft whole (back-compat)", () => {
    let s = open()
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "Enter" }, ctx).state as Extract<State, { kind: "open" }>
    const r = transition(s, { kind: "buffer", text: "gpt-5.5" }, ctx)
    const st = r.state as Extract<State, { kind: "open" }>
    if (st.phase.kind !== "edit") throw new Error()
    expect(st.phase.draft).toBe("gpt-5.5")
  })

  it("Enter commits the draft as a stage-set and returns to browse", () => {
    let s = open()
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "Enter" }, ctx).state as Extract<State, { kind: "open" }>
    s = transition(s, { kind: "buffer", text: "gpt-5.5" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    const r = transition(s, { kind: "key", name: "Enter" }, ctx)
    expect(r.effects).toContainEqual({ kind: "stage-set", fieldId: "model", value: "gpt-5.5" })
    expect(kinds(r.effects)).not.toContain("set-buffer")
    expect((r.state as Extract<State, { kind: "open" }>).phase.kind).toBe("browse")
  })

  it("Escape in edit cancels without staging", () => {
    let s = open()
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
      State,
      { kind: "open" }
    >
    s = transition(s, { kind: "key", name: "Enter" }, ctx).state as Extract<State, { kind: "open" }>
    const r = transition(s, { kind: "key", name: "Escape" }, ctx)
    expect(kinds(r.effects)).not.toContain("stage-set")
    expect(kinds(r.effects)).not.toContain("set-buffer")
    expect((r.state as Extract<State, { kind: "open" }>).phase.kind).toBe("browse")
  })

  it("empty committed draft clears the key", () => {
    expect(draftToEffect("model", "string", "   ")).toEqual({
      kind: "stage-clear",
      fieldId: "model",
    })
  })

  it("string-list draft parses on space/comma", () => {
    expect(draftToEffect("formatterArgs", "string-list", "--a, --b  --c")).toEqual({
      kind: "stage-set",
      fieldId: "formatterArgs",
      value: ["--a", "--b", "--c"],
    })
  })
})

describe("action rows", () => {
  function selectAction(action: string): Extract<State, { kind: "open" }> {
    let s = open()
    const idx = rows.findIndex((r) => r.type === "action" && r.action === action)
    for (let i = 0; i < idx; i++) {
      s = transition(s, { kind: "key", name: "ArrowDown" }, ctx).state as Extract<
        State,
        { kind: "open" }
      >
    }
    return s
  }

  it("Enter on save emits a save effect", () => {
    const r = transition(selectAction("save"), { kind: "key", name: "Enter" }, ctx)
    expect(kinds(r.effects)).toContain("save")
  })

  it("Enter on revert emits revert-all", () => {
    const r = transition(selectAction("revert"), { kind: "key", name: "Enter" }, ctx)
    expect(kinds(r.effects)).toContain("revert-all")
  })

  it("Enter on close closes the overlay", () => {
    const r = transition(selectAction("close"), { kind: "key", name: "Enter" }, ctx)
    expect(r.state.kind).toBe("closed")
  })

  it("Left/Right on an action row is an inert halt", () => {
    const r = transition(selectAction("save"), { kind: "key", name: "ArrowRight" }, ctx)
    expect(kinds(r.effects)).toEqual(["halt"])
  })
})

describe("valueToDraft", () => {
  it("serializes lists with commas, scalars as strings, unset as empty", () => {
    expect(valueToDraft("string-list", ["a", "b"])).toBe("a, b")
    expect(valueToDraft("number", 2)).toBe("2")
    expect(valueToDraft("string", undefined)).toBe("")
  })
})

describe("keys are ignored when closed", () => {
  it("no effects for a key while closed", () => {
    expect(transition(CLOSED, { kind: "key", name: "ArrowDown" }, ctx).effects).toEqual([])
  })
})

/**
 * Tests for the effect applier (the shell core).
 *
 * @module config/lib/runtime.test
 */

import { describe, expect, it } from "bun:test"

import type { Effect, State } from "./fsm.ts"
import { parseJsonc } from "./mini-jsonc.ts"
import { ConfigModel, type FsDeps } from "./model.ts"
import { type ApplyDeps, applyEffects } from "./runtime.ts"
import type { Field } from "./schema.ts"

const FIELDS: Field[] = [
  {
    id: "effort",
    label: "effort",
    help: "h",
    kind: "enum",
    path: ["effort"],
    choices: ["low", "high"],
    section: "A",
  },
  { id: "model", label: "model", help: "h", kind: "string", path: ["model"], section: "A" },
]

function mk(json: string | null): { model: ConfigModel; fs: { current: string | null } } {
  const box = { current: json }
  const fs: FsDeps = {
    path: "/fake/config.jsonc",
    read: () => box.current,
    write: (t) => {
      box.current = t
    },
  }
  return { model: ConfigModel.load(fs, { fields: FIELDS }), fs: box }
}

function deps(
  model: ConfigModel,
  state: State,
  emits: Array<{ ch: string; p: unknown }>,
): ApplyDeps {
  return {
    emit: (ch, p) => emits.push({ ch, p }),
    cols: 100,
    maxRows: 8,
    getState: () => state,
    model,
  }
}

const open: Extract<State, { kind: "open" }> = {
  kind: "open",
  selectedIndex: 0,
  scrollOffset: 0,
  phase: { kind: "browse" },
}

describe("applyEffects", () => {
  it("halt sets the halt flag", () => {
    const { model } = mk(`{}`)
    const emits: Array<{ ch: string; p: unknown }> = []
    const r = applyEffects([{ kind: "halt" }], deps(model, open, emits))
    expect(r.halt).toBe(true)
  })

  it("stage-set mutates the model and repaint emits a footer", () => {
    const { model } = mk(`{ "effort": "high" }`)
    const emits: Array<{ ch: string; p: unknown }> = []
    const effects: Effect[] = [
      { kind: "stage-set", fieldId: "effort", value: "low" },
      { kind: "repaint" },
      { kind: "halt" },
    ]
    const r = applyEffects(effects, deps(model, open, emits))
    expect(r.halt).toBe(true)
    expect(model.value(FIELDS[0]!).dirty).toBe(true)
    const footer = emits.find((e) => e.ch === "editor.footer.set")
    expect(footer).toBeDefined()
    expect(Array.isArray((footer!.p as { lines: string[] }).lines)).toBe(true)
  })

  it("set-buffer reports the value (caller applies it; no bus emit here)", () => {
    const { model } = mk(`{}`)
    const emits: Array<{ ch: string; p: unknown }> = []
    const r = applyEffects([{ kind: "set-buffer", text: "claude" }], deps(model, open, emits))
    expect(r.setBuffer).toBe("claude")
    expect(emits.find((e) => e.ch === "editor.buffer.set")).toBeUndefined()
  })

  it("close clears footer, releases overlay ownership, and flags closed", () => {
    const { model } = mk(`{}`)
    const emits: Array<{ ch: string; p: unknown }> = []
    const r = applyEffects([{ kind: "close" }, { kind: "halt" }], deps(model, open, emits))
    expect(r.closed).toBe(true)
    expect(r.halt).toBe(true)
    expect(emits).toContainEqual({ ch: "editor.footer.set", p: { lines: [] } })
    // Releases modal input ownership so the host restores the prompt + cursor.
    expect(emits).toContainEqual({ ch: "editor.overlay.close", p: { owner: "config" } })
    // No footer repaint when closed even if repaint was present.
  })

  it("save writes the file and reports the saved text", () => {
    const { model, fs } = mk(`{ "effort": "high" }`)
    model.set("effort", "low")
    const emits: Array<{ ch: string; p: unknown }> = []
    const r = applyEffects([{ kind: "save" }, { kind: "repaint" }], deps(model, open, emits))
    expect(r.saved).toBeDefined()
    expect(parseJsonc(fs.current!)).toEqual({ effort: "low" })
  })

  it("save error is surfaced, not thrown", () => {
    const { model } = mk(`{ broken`)
    const emits: Array<{ ch: string; p: unknown }> = []
    const r = applyEffects([{ kind: "save" }], deps(model, open, emits))
    expect(r.saveError).toBeDefined()
  })

  it("revert-all drops staged edits", () => {
    const { model } = mk(`{ "effort": "high" }`)
    model.set("effort", "low")
    expect(model.dirtyCount()).toBe(1)
    applyEffects(
      [{ kind: "revert-all" }],
      deps(model, open, [] as Array<{ ch: string; p: unknown }>),
    )
    expect(model.dirtyCount()).toBe(0)
  })
})

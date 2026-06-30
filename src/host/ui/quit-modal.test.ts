import { describe, expect, test } from "bun:test"

import { QuitModal } from "./quit-modal.ts"

function renderJoined(m: QuitModal, width = 40): string {
  return m.render(width).join("\n")
}

describe("QuitModal", () => {
  test("default selection is No", () => {
    const m = new QuitModal()
    const out = renderJoined(m)
    expect(out).toContain("❮ No ❯")
    expect(out).toContain("[ Yes ]")
  })

  test("← selects Yes", () => {
    const m = new QuitModal()
    expect(m.onKey({ name: "left" })).toBe("stay")
    const out = renderJoined(m)
    expect(out).toContain("❮ Yes ❯")
    expect(out).toContain("[ No ]")
  })

  test("→ from Yes goes back to No", () => {
    const m = new QuitModal()
    m.onKey({ name: "left" })
    m.onKey({ name: "right" })
    const out = renderJoined(m)
    expect(out).toContain("❮ No ❯")
  })

  test("Tab toggles selection", () => {
    const m = new QuitModal()
    m.onKey({ name: "tab" })
    expect(renderJoined(m)).toContain("❮ Yes ❯")
    m.onKey({ name: "tab" })
    expect(renderJoined(m)).toContain("❮ No ❯")
  })

  test("Enter on default (No) returns false", () => {
    const m = new QuitModal()
    expect(m.onKey({ name: "enter" })).toEqual({ close: true, result: false })
  })

  test("Enter after ← (Yes) returns true", () => {
    const m = new QuitModal()
    m.onKey({ name: "left" })
    expect(m.onKey({ name: "enter" })).toEqual({ close: true, result: true })
  })

  test("y/Y always returns true", () => {
    const m1 = new QuitModal()
    expect(m1.onKey({ name: "char", ch: "y" })).toEqual({ close: true, result: true })
    const m2 = new QuitModal()
    m2.onKey({ name: "left" }) // selected Yes
    expect(m2.onKey({ name: "char", ch: "Y" })).toEqual({ close: true, result: true })
  })

  test("n/N always returns false", () => {
    const m1 = new QuitModal()
    m1.onKey({ name: "left" }) // Yes selected
    expect(m1.onKey({ name: "char", ch: "n" })).toEqual({ close: true, result: false })
    const m2 = new QuitModal()
    expect(m2.onKey({ name: "char", ch: "N" })).toEqual({ close: true, result: false })
  })

  test("Escape returns false", () => {
    const m = new QuitModal()
    m.onKey({ name: "left" }) // even on Yes
    expect(m.onKey({ name: "escape" })).toEqual({ close: true, result: false })
  })

  test("unknown key returns stay, no state change", () => {
    const m = new QuitModal()
    const before = renderJoined(m)
    expect(m.onKey({ name: "char", ch: "x" })).toBe("stay")
    expect(m.onKey({ name: "ctrl", ch: "A" })).toBe("stay")
    expect(m.onKey({ name: "up" })).toBe("stay")
    expect(m.onKey({ name: "down" })).toBe("stay")
    expect(renderJoined(m)).toBe(before)
  })

  test("rowsHint is 3 and render produces exactly 3 rows", () => {
    const m = new QuitModal()
    expect(m.rowsHint()).toBe(3)
    expect(m.render(40).length).toBe(3)
    expect(m.render(80).length).toBe(3)
  })
})

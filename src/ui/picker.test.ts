import { describe, expect, test } from "bun:test"

import { Picker, type PickerItem } from "./picker.ts"

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

const mkItems = (n: number, disabledIdx: number[] = []): PickerItem<number>[] =>
  Array.from({ length: n }, (_, i) => ({
    label: `item-${i}`,
    value: i,
    disabled: disabledIdx.includes(i),
  }))

describe("Picker", () => {
  test("initial selectedIndex defaults to 0", () => {
    const p = new Picker({ items: mkItems(3) })
    expect(p.selectedIndex).toBe(0)
  })

  test("initial selectedIndex respects opts.initial", () => {
    const p = new Picker({ items: mkItems(5), initial: 2 })
    expect(p.selectedIndex).toBe(2)
  })

  test("down advances, clamped at last", () => {
    const p = new Picker({ items: mkItems(3) })
    p.onKey({ name: "down" })
    expect(p.selectedIndex).toBe(1)
    p.onKey({ name: "down" })
    p.onKey({ name: "down" })
    p.onKey({ name: "down" })
    expect(p.selectedIndex).toBe(2)
  })

  test("up retreats, clamped at first", () => {
    const p = new Picker({ items: mkItems(3), initial: 2 })
    p.onKey({ name: "up" })
    expect(p.selectedIndex).toBe(1)
    p.onKey({ name: "up" })
    p.onKey({ name: "up" })
    expect(p.selectedIndex).toBe(0)
  })

  test("pagedown moves by pageSize, clamped", () => {
    const p = new Picker({ items: mkItems(20), pageSize: 5 })
    p.onKey({ name: "pagedown" })
    expect(p.selectedIndex).toBe(5)
    p.onKey({ name: "pagedown" })
    expect(p.selectedIndex).toBe(10)
    p.onKey({ name: "pagedown" })
    p.onKey({ name: "pagedown" })
    p.onKey({ name: "pagedown" })
    expect(p.selectedIndex).toBe(19)
  })

  test("pageup moves by pageSize, clamped", () => {
    const p = new Picker({ items: mkItems(20), pageSize: 5, initial: 19 })
    p.onKey({ name: "pageup" })
    expect(p.selectedIndex).toBe(14)
  })

  test("home/end skip leading/trailing disabled", () => {
    const p = new Picker({ items: mkItems(6, [0, 1, 5]), initial: 3 })
    p.onKey({ name: "home" })
    expect(p.selectedIndex).toBe(2)
    p.onKey({ name: "end" })
    expect(p.selectedIndex).toBe(4)
  })

  test("up/down skip disabled items", () => {
    const p = new Picker({ items: mkItems(5, [1, 2]), initial: 0 })
    p.onKey({ name: "down" })
    expect(p.selectedIndex).toBe(3)
    p.onKey({ name: "up" })
    expect(p.selectedIndex).toBe(0)
  })

  test("enter on enabled item returns its value", () => {
    const p = new Picker({ items: mkItems(3), initial: 1 })
    const res = p.onKey({ name: "enter" })
    expect(res).toEqual({ close: true, result: 1 })
  })

  test("enter on no-items picker returns null", () => {
    const p = new Picker<number>({ items: [] })
    const res = p.onKey({ name: "enter" })
    expect(res).toEqual({ close: true, result: null })
  })

  test("escape returns null", () => {
    const p = new Picker({ items: mkItems(3), initial: 1 })
    const res = p.onKey({ name: "escape" })
    expect(res).toEqual({ close: true, result: null })
  })

  test("render includes title, cursor, label, hint; rowsHint matches", () => {
    const items: PickerItem<string>[] = [
      { label: "Alpha", hint: "5m ago", value: "a" },
      { label: "Beta", hint: "1h ago", value: "b" },
    ]
    const p = new Picker({
      title: "Pick one",
      footer: "Esc to cancel",
      items,
      initial: 1,
    })
    const rows = p.render(40)
    expect(rows.length).toBe(p.rowsHint())
    const plain = rows.map(stripAnsi)
    expect(plain[0]).toContain("Pick one")
    expect(plain[1]).toBe("")
    // First item: not selected
    expect(plain[2]).toContain("Alpha")
    expect(plain[2]).toContain("5m ago")
    expect(plain[2]?.startsWith("  ")).toBe(true)
    // Second item: selected
    expect(plain[3]).toContain("❯ ")
    expect(plain[3]).toContain("Beta")
    expect(plain[3]).toContain("1h ago")
    // Footer
    expect(plain[plain.length - 1]).toContain("Esc to cancel")
  })

  test("render: disabled items appear dimmed (ANSI dim sequence)", () => {
    const p = new Picker({ items: mkItems(3, [2]) })
    const rows = p.render(30)
    // The disabled item row should contain dim escape
    const disabledRow = rows.find((r) => stripAnsi(r).includes("item-2"))
    expect(disabledRow).toBeDefined()
    expect(disabledRow!).toContain("\x1b[2m")
  })
})

import { describe, expect, it } from "bun:test"

import {
  createStyleSlots,
  TERMINAL_CODE_NAMES,
  TERMINAL_PALETTE_NAMES,
  TERMINAL_STYLE_NAMES,
  type TerminalKit,
} from "@minimal-agent/core/plugin-api/utils/style-slots"

/** A fake kit that marks text with brackets, so no escape byte is needed. */
function fakeKit(): TerminalKit {
  const codes = Object.fromEntries(TERMINAL_CODE_NAMES.map((k) => [k, `<${k}>`]))
  const styles = Object.fromEntries(
    TERMINAL_STYLE_NAMES.map((k) => [k, (s: string) => `[${k}:${s}]`]),
  )
  const palette = Object.fromEntries(TERMINAL_PALETTE_NAMES.map((k) => [k, `{${k}}`]))
  return {
    codes,
    styles,
    palette,
    bgRgb: (r, g, b) => `<bg ${r},${g},${b}>`,
    renderUnifiedDiff: (patch, title) => `[diff ${title ?? ""}]${patch}`,
  } as TerminalKit
}

describe("style-slots", () => {
  it("starts plain: no code, no style, the patch unchanged", () => {
    const slots = createStyleSlots()
    expect(slots.installed()).toBe(false)
    for (const k of TERMINAL_CODE_NAMES) expect(slots.codes[k]).toBe("")
    for (const k of TERMINAL_PALETTE_NAMES) expect(slots.palette[k]).toBe("")
    for (const k of TERMINAL_STYLE_NAMES) expect(slots.styles[k]("x")).toBe("x")
    expect(slots.bgRgb(1, 2, 3)).toBe("")
    expect(slots.renderUnifiedDiff("@@ -1 +1 @@", "t")).toBe("@@ -1 +1 @@")
    expect(slots.color(true, slots.codes.BOLD, "x")).toBe("x")
  })

  it("install fills every slot from the kit, reset makes them plain again", () => {
    const slots = createStyleSlots()
    slots.install(fakeKit())
    expect(slots.installed()).toBe(true)
    expect(slots.codes.DIM).toBe("<DIM>")
    expect(slots.palette.red).toBe("{red}")
    expect(slots.styles.dim("x")).toBe("[dim:x]")
    expect(slots.bgRgb(1, 2, 3)).toBe("<bg 1,2,3>")
    expect(slots.renderUnifiedDiff("p", "t")).toBe("[diff t]p")
    expect(slots.color(true, slots.codes.BOLD, "x")).toBe("<BOLD>x<RESET>")
    expect(slots.color(false, slots.codes.BOLD, "x")).toBe("x")
    slots.reset()
    expect(slots.installed()).toBe(false)
    expect(slots.codes.DIM).toBe("")
    expect(slots.styles.dim("x")).toBe("x")
  })

  it("keeps the same slot objects, so a reader that holds them sees install", () => {
    const slots = createStyleSlots()
    const { styles } = slots
    slots.install(fakeKit())
    expect(styles.bold("x")).toBe("[bold:x]")
  })
})

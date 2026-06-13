import { describe, expect, it } from "bun:test"

import { ANSI_CODES, ansiStyle, attr, bgRgb, color, combo, fg } from "./ansi.ts"
import { PALETTE } from "./palette.ts"

describe("ansi helpers", () => {
  it("wraps foreground colors with a foreground reset", () => {
    expect(fg(PALETTE.red)("x")).toBe("\x1b[31mx\x1b[39m")
  })

  it("wraps attributes with their paired close code", () => {
    expect(attr("\x1b[2m", "\x1b[22m")("x")).toBe("\x1b[2mx\x1b[22m")
  })

  it("wraps compound styles with one explicit close sequence", () => {
    expect(combo("\x1b[1;32m", "\x1b[22;39m")("x")).toBe("\x1b[1;32mx\x1b[22;39m")
  })

  it("keeps the shared style helper byte-compatible with the previous host c palette", () => {
    expect(ansiStyle.dim("x")).toBe("\x1b[2mx\x1b[22m")
    expect(ansiStyle.bold("x")).toBe("\x1b[1mx\x1b[22m")
    expect(ansiStyle.inverse("x")).toBe("\x1b[7mx\x1b[27m")
    expect(ansiStyle.red("x")).toBe("\x1b[31mx\x1b[39m")
    expect(ansiStyle.white("x")).toBe("\x1b[37mx\x1b[39m")
    expect(ansiStyle.gray("x")).toBe("\x1b[90mx\x1b[39m")
    expect(ansiStyle.boldGreen("x")).toBe("\x1b[1;32mx\x1b[22;39m")
    expect(ansiStyle.boldWhite("x")).toBe("\x1b[1;37mx\x1b[0m")
    expect(ansiStyle.boldBrightWhite("x")).toBe("\x1b[1;97mx\x1b[22;39m")
    expect(ansiStyle.faintWhite("x")).toBe("\x1b[2;37mx\x1b[22;39m")
    expect(ansiStyle.pink("x")).toBe("\x1b[38;5;199mx\x1b[39m")
    expect(ansiStyle.violet("x")).toBe("\x1b[38;2;180;140;255mx\x1b[39m")
    expect(ansiStyle.dimViolet("x")).toBe("\x1b[2;38;2;180;140;255mx\x1b[22;39m")
  })

  it("exposes shared raw SGR constants for renderers that need explicit resets", () => {
    expect(ANSI_CODES.RESET).toBe("\x1b[0m")
    expect(ANSI_CODES.BG_RESET).toBe("\x1b[49m")
    expect(ANSI_CODES.ERASE_LINE).toBe("\x1b[2K")
    expect(ANSI_CODES.BOLD).toBe("\x1b[1m")
    expect(ANSI_CODES.DIM).toBe("\x1b[2m")
    expect(ANSI_CODES.INVERSE).toBe("\x1b[7m")
    expect(ANSI_CODES.INVERSE_CLOSE).toBe("\x1b[27m")
    expect(ANSI_CODES.BRIGHT_BLACK).toBe("\x1b[90m")
    expect(ANSI_CODES.DARK_GRAY).toBe("\x1b[38;5;240m")
    expect(ANSI_CODES.LIGHT_GRAY).toBe("\x1b[38;5;246m")
  })

  it("conditionally colors text with a full reset", () => {
    expect(color(true, ANSI_CODES.BOLD, "x")).toBe("\x1b[1mx\x1b[0m")
    expect(color(false, ANSI_CODES.BOLD, "x")).toBe("x")
  })

  it("builds truecolor background open sequences", () => {
    expect(bgRgb(55, 45, 85)).toBe("\x1b[48;2;55;45;85m")
  })
})

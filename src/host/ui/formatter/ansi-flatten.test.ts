/**
 * Flattening a streaming formatter's repaint choreography into the final
 * static rows a framed block can safely gutter.
 *
 * @module host/ui/formatter/ansi-flatten.test
 */

import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../../terminal/term-width.ts"

import { flattenAnsiToLines } from "./ansi-flatten.ts"

const ESC = "\u001B["

describe("flattenAnsiToLines", () => {
  it("returns plain lines unchanged", () => {
    expect(flattenAnsiToLines("alpha\nbeta\ngamma")).toEqual(["alpha", "beta", "gamma"])
  })

  it("keeps SGR styling inline so color survives the frame", () => {
    const styled = `${ESC}1mBold${ESC}0m tail`
    const lines = flattenAnsiToLines(styled)
    expect(lines).toEqual([styled])
    expect(stripAnsi(lines[0] as string)).toBe("Bold tail")
  })

  it("collapses a carriage-return repaint to the final text", () => {
    expect(flattenAnsiToLines("draft\rfinal")).toEqual(["final"])
  })

  it("replays cursor-up plus erase-line as a replaced row, not a duplicate", () => {
    // mdstream's core move: reprint a paragraph once its closing token lands.
    const stream = `partial para\n${ESC}1A\r${ESC}2Kfinal para\n`
    expect(flattenAnsiToLines(stream)).toEqual(["final para"])
  })

  it("erases from the cursor to end of line with CSI 0K", () => {
    expect(flattenAnsiToLines(`abcdef\r${ESC}3C${ESC}0K`)).toEqual(["abc"])
  })

  it("drops rows below the cursor on CSI 0J", () => {
    const stream = `keep\nstale one\nstale two${ESC}2F${ESC}0J`
    // CSI 2F parks the cursor at row 0 column 0, so erase-to-end wipes all.
    expect(flattenAnsiToLines(stream)).toEqual([])
  })

  it("keeps rows above the cursor when CSI 0J erases downward", () => {
    const stream = `keep\nstale one\nstale two${ESC}1F${ESC}0J`
    expect(flattenAnsiToLines(stream)).toEqual(["keep"])
  })

  it("clears the whole screen on CSI 2J", () => {
    expect(flattenAnsiToLines(`old\nrows\n${ESC}2Jfresh`)).toEqual(["fresh"])
  })

  it("overwrites in place rather than inserting", () => {
    expect(flattenAnsiToLines(`aaaa\r${ESC}1Cbb`)).toEqual(["abba"])
  })

  it("pads when a write lands past the end of a short row", () => {
    expect(flattenAnsiToLines(`ab\r${ESC}4Cz`)).toEqual(["ab  z"])
  })

  it("honors backspace as cursor motion", () => {
    expect(flattenAnsiToLines("abcX\bY")).toEqual(["abcY"])
  })

  it("drops trailing blank rows the renderer leaves behind", () => {
    expect(flattenAnsiToLines("only\n\n\n")).toEqual(["only"])
  })

  it("preserves interior blank rows between paragraphs", () => {
    expect(flattenAnsiToLines("one\n\ntwo")).toEqual(["one", "", "two"])
  })

  it("emits no bare escape fragments for any sequence it consumes", () => {
    const stream = `${ESC}1mHead${ESC}0m\n${ESC}1A\r${ESC}2K${ESC}1mHead v2${ESC}0m\nbody\n`
    const lines = flattenAnsiToLines(stream)
    expect(lines.map(stripAnsi)).toEqual(["Head v2", "body"])
    for (const line of lines) expect(line).not.toMatch(/\u001B\[[0-9;]*[A-DGJKSTfH]/u)
  })

  it("ignores OSC sequences instead of leaking their payload", () => {
    expect(flattenAnsiToLines(`\u001B]0;window title\u0007visible`)).toEqual(["visible"])
  })

  it("drops a truncated escape at the end of a stream", () => {
    expect(flattenAnsiToLines(`text${ESC}1`)).toEqual(["text"])
  })

  it("returns an empty list for empty input", () => {
    expect(flattenAnsiToLines("")).toEqual([])
  })

  it("flattens a realistic markdown repaint into frame-safe rows", () => {
    // Heading streams, then the list is repainted twice as items arrive.
    const stream = [
      `${ESC}1m## Goal${ESC}0m\n`,
      "- draft item\n",
      `${ESC}1A\r${ESC}2K- first item\n`,
      "- second draft\n",
      `${ESC}1A\r${ESC}2K- second item\n`,
    ].join("")
    const lines = flattenAnsiToLines(stream)
    expect(lines.map(stripAnsi)).toEqual(["## Goal", "- first item", "- second item"])
    // Every row must be gutter-safe: no motion escapes, no embedded newline.
    for (const line of lines) {
      expect(line).not.toContain("\n")
      expect(line).not.toContain("\r")
    }
  })
})

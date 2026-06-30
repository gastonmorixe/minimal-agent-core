/**
 * Tests for {@link reopenFrameCloser}: the tiny view helper that turns a
 * tool-block's trailing `╰` closer back into a `│` continuation so an appended
 * diagnostics panel can own the final `╰`. Keeps the two blocks visually fused
 * into one frame instead of producing a double-closer.
 */
import { describe, expect, it } from "bun:test"

import { c } from "../style/ansi.ts"

import { isOuterFrameClose, reopenFrameCloser } from "./format.ts"

describe("reopenFrameCloser", () => {
  it("swaps a dimCyan ╰ closer for a dimCyan │ continuation", () => {
    const closer = `  ${c.dimCyan("╰")} ${c.dim("1 replacement")}`
    const reopened = reopenFrameCloser(closer)
    expect(reopened).toBe(`  ${c.dimCyan("│")} ${c.dim("1 replacement")}`)
    // and the result is no longer recognized as an outer-frame close
    expect(isOuterFrameClose(closer)).toBe(true)
    expect(isOuterFrameClose(reopened)).toBe(false)
  })

  it("handles a bare ╰ closer (no body)", () => {
    const closer = `  ${c.dimCyan("╰")}`
    expect(reopenFrameCloser(closer)).toBe(`  ${c.dimCyan("│")}`)
  })

  it("leaves a non-closer line unchanged", () => {
    const body = `  ${c.dimCyan("│")} ${c.dim("some body")}`
    expect(reopenFrameCloser(body)).toBe(body)
  })
})

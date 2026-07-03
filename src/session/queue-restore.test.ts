/**
 * Unit tests for `formatRestoredMessages` : the ordinal formatter used
 * when dequeued / aborted submit-queue messages are returned to the
 * editor prompt.
 *
 * Pins the feature contract:
 *   - 0 non-empty messages → ""
 *   - exactly 1 → verbatim (no numbering)
 *   - \>1 → "1. … / 2. … / N. …" with continuation lines indented
 *   - empty / whitespace-only entries dropped before counting
 */
import { describe, expect, it } from "bun:test"

import { formatRestoredMessages } from "./queue-restore.ts"

describe("formatRestoredMessages", () => {
  it("empty list → empty string", () => {
    expect(formatRestoredMessages([])).toBe("")
  })

  it("single message → verbatim, no numbering", () => {
    expect(formatRestoredMessages(["just one"])).toBe("just one")
  })

  it("single multi-line message → verbatim (newlines preserved, no indent)", () => {
    expect(formatRestoredMessages(["line a\nline b"])).toBe("line a\nline b")
  })

  it("two messages → 1. / 2. ordinal list", () => {
    expect(formatRestoredMessages(["first", "second"])).toBe("1. first\n2. second")
  })

  it("three messages → 1. / 2. / 3.", () => {
    expect(formatRestoredMessages(["a", "b", "c"])).toBe("1. a\n2. b\n3. c")
  })

  it("preserves submission order (FIFO)", () => {
    expect(formatRestoredMessages(["zebra", "apple", "mango"])).toBe("1. zebra\n2. apple\n3. mango")
  })

  it("indents continuation lines under the ordinal marker", () => {
    // `1. ` is 3 cells wide → continuation lines indent by 3 spaces.
    expect(formatRestoredMessages(["fix the bug\nat width 80", "then format"])).toBe(
      "1. fix the bug\n   at width 80\n2. then format",
    )
  })

  it("indent width tracks the ordinal width (10+ → 4 spaces)", () => {
    const texts = Array.from({ length: 10 }, (_, i) => (i === 9 ? "tenth\nwrapped" : `m${i + 1}`))
    const out = formatRestoredMessages(texts)
    // The 10th item's marker is `10. ` (4 cells) so its continuation
    // line indents by 4 spaces.
    expect(out).toContain("10. tenth\n    wrapped")
  })

  it("drops empty / whitespace-only entries before counting", () => {
    // One real + one synthetic (empty) item → restores as a SINGLE
    // verbatim message, not a one-item numbered list.
    expect(formatRestoredMessages(["real", ""])).toBe("real")
    expect(formatRestoredMessages(["", "  ", "\n"])).toBe("")
    expect(formatRestoredMessages(["", "a", "  ", "b"])).toBe("1. a\n2. b")
  })

  it("does not mutate the input array", () => {
    const input = ["a", "b"]
    formatRestoredMessages(input)
    expect(input).toEqual(["a", "b"])
  })
})

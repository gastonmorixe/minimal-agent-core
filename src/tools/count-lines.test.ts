/**
 * `countLines` is the allocation-free line counter used on the tool-output
 * hot path. `truncateToolOutput` runs on the FULL (potentially multi-MB)
 * tool body on the synchronous critical section; the old code did
 * `output.split("\n").length`, which allocates an array of EVERY line just
 * to read its length and then throws it away in the common under-budget
 * case. On a big Fetch body that allocation + GC churn is felt as a UI
 * stall (Bug 4). `countLines` counts newline-delimited segments by scanning
 * for `\n`, allocating nothing.
 *
 * Contract: for every input, `countLines(s) === s.split("\n").length`
 * exactly (including the empty-string edge: `"".split("\n").length === 1`,
 * but truncation treats "" as 0 lines separately, so we pin the raw
 * split-equivalence here and let the caller keep its empty-string guard).
 */
import { describe, expect, it } from "bun:test"

import { countLines } from "./truncation.ts"

describe("countLines === split(\\n).length", () => {
  const cases = [
    "",
    "a",
    "a\n",
    "\n",
    "\n\n",
    "a\nb",
    "a\nb\n",
    "a\nb\nc",
    "line one\nline two\nline three\n",
    "trailing\n\n\n",
    "\nleading",
    "no newlines at all here",
    "unicode ✓ café 日本語\nsecond ✓ line",
  ]
  for (const s of cases) {
    it(`matches for ${JSON.stringify(s)}`, () => {
      expect(countLines(s)).toBe(s.split("\n").length)
    })
  }

  it("matches for a large many-line body", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i}`).join("\n")
    expect(countLines(big)).toBe(big.split("\n").length)
    expect(countLines(big)).toBe(50_000)
  })

  it("matches for a large single-line body (no newlines)", () => {
    const big = "x".repeat(2_000_000)
    expect(countLines(big)).toBe(1)
    expect(countLines(big)).toBe(big.split("\n").length)
  })
})

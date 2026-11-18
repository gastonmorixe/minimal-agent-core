import { describe, expect, it } from "bun:test"

import { EMPTY_SYNTHETIC_TEXT } from "../agent/synthetic-text.ts"

import { MAX_TOOL_OUTPUT_LINE_CHARS } from "./truncation.ts"
import { clampLinesCounted, truncateToolOutputParts } from "./truncation-parts.ts"

const CAP = 8192
const EMOJI = "\u{1F600}"
const HIGH = "\uD83D"
const LOW = "\uDE00"
const LONE_HIGH_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/
const LONE_LOW_RE = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const LONE_HIGH_ALL = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g
const LONE_LOW_ALL = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g

/** Number of lone surrogates in `s`. */
function loneCount(s: string): number {
  return (s.match(LONE_HIGH_ALL)?.length ?? 0) + (s.match(LONE_LOW_ALL)?.length ?? 0)
}

// copy of f3e7099 for the byte-equality proof
function oldClampLinesCounted(
  output: string,
  maxChars: number,
): { text: string; longLines: number; longLineIndexes: number[] } {
  if (output.length === 0 || output.length <= maxChars) {
    return { text: output, longLines: 0, longLineIndexes: [] }
  }
  const longLineIndexes: number[] = []
  let index = 0
  let out = ""
  let start = 0
  let first = true
  while (true) {
    const nl = output.indexOf("\n", start)
    const end = nl === -1 ? output.length : nl
    let line = output.slice(start, end)
    if (line.length > maxChars) {
      const cut = line.length - maxChars
      line = `${line.slice(0, maxChars)}...(+${cut}ch)`
      longLineIndexes.push(index)
    }
    index++
    if (!first) out += "\n"
    out += line
    first = false
    if (nl === -1) break
    start = nl + 1
  }
  return { text: out, longLines: longLineIndexes.length, longLineIndexes }
}

/** Split the marker off a clamped line: the kept text and the removed count. */
function splitMarker(line: string): { kept: string; removed: number } {
  const at = line.lastIndexOf("...(+")
  const m = /^\.\.\.\(\+(\d+)ch\)$/.exec(line.slice(at))
  if (at < 0 || !m) throw new Error(`no marker in line of length ${line.length}`)
  return { kept: line.slice(0, at), removed: Number(m[1]) }
}

describe("clampLinesCounted: surrogate pairs at the cap", () => {
  it("cap is 8192 (the tests below depend on it)", () => {
    expect(MAX_TOOL_OUTPUT_LINE_CHARS).toBe(CAP)
  })

  it("a pair that straddles the cap: cut one unit less, no lone surrogate", () => {
    const line = `${"a".repeat(CAP - 1)}${EMOJI}${"b".repeat(10)}`
    const r = clampLinesCounted(line, CAP)
    const { kept, removed } = splitMarker(r.text)
    expect(kept.length).toBe(CAP - 1)
    expect(kept).toBe("a".repeat(CAP - 1))
    expect(LONE_HIGH_RE.test(kept)).toBe(false)
    expect(LONE_LOW_RE.test(kept)).toBe(false)
    expect(removed).toBe(line.length - (CAP - 1))
    expect(r.text).toBe(`${"a".repeat(CAP - 1)}...(+${line.length - (CAP - 1)}ch)`)
    expect(r.longLines).toBe(1)
    expect(r.longLineIndexes).toEqual([0])
    // The old function kept a lone high surrogate here.
    expect(oldClampLinesCounted(line, CAP).text).not.toBe(r.text)
  })

  it("a pair that ends exactly at the cap: same as the old function", () => {
    const line = `${"a".repeat(CAP - 2)}${EMOJI}${"b".repeat(10)}`
    const r = clampLinesCounted(line, CAP)
    expect(r).toEqual(oldClampLinesCounted(line, CAP))
    const { kept, removed } = splitMarker(r.text)
    expect(kept.length).toBe(CAP)
    expect(kept.endsWith(EMOJI)).toBe(true)
    expect(removed).toBe(10)
  })

  it("a pair fully after the cap: same as the old function", () => {
    const line = `${"a".repeat(CAP)}${EMOJI}${"b".repeat(10)}`
    const r = clampLinesCounted(line, CAP)
    expect(r).toEqual(oldClampLinesCounted(line, CAP))
    expect(splitMarker(r.text).removed).toBe(12)
  })

  it("a lone high surrogate at the cap edge, next unit not low: same as old (kept on purpose)", () => {
    const line = `${"a".repeat(CAP - 1)}${HIGH}a${"b".repeat(10)}`
    const r = clampLinesCounted(line, CAP)
    expect(r).toEqual(oldClampLinesCounted(line, CAP))
    const { kept, removed } = splitMarker(r.text)
    expect(kept.length).toBe(CAP)
    expect(kept.endsWith(HIGH)).toBe(true)
    expect(removed).toBe(11)
  })

  it("a lone low surrogate at the cap edge: same as old", () => {
    for (const col of [CAP - 2, CAP - 1, CAP]) {
      const line = `${"a".repeat(col)}${LOW}${"b".repeat(10)}`
      expect(clampLinesCounted(line, CAP)).toEqual(oldClampLinesCounted(line, CAP))
    }
  })

  it("small caps: maxChars 1 and 0 keep the old behavior", () => {
    for (const max of [0, 1]) {
      for (const line of [`${EMOJI}abc`, `a${EMOJI}`, "abc", `${HIGH}${LOW}${HIGH}${LOW}`]) {
        const out = `${line}\n${line}`
        const got = clampLinesCounted(out, max)
        if (max === 1 && line.startsWith(EMOJI)) {
          // High at index 0, low at index 1: a pair straddles a cap of 1.
          expect(got.text).toBe(`...(+${line.length}ch)\n...(+${line.length}ch)`)
        } else {
          expect(got).toEqual(oldClampLinesCounted(out, max))
        }
      }
    }
  })
})

/** A small seeded PRNG (mulberry32). No Math.random. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** True when a cut line has a high surrogate at maxChars-1 and a low one at maxChars. */
function splitsPair(line: string, max: number): boolean {
  if (line.length <= max || max < 1) return false
  const hi = line.charCodeAt(max - 1)
  const lo = line.charCodeAt(max)
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff
}

/** Check one case against the old function. Returns true for a split case. */
function checkCase(output: string, max: number): boolean {
  const oldR = oldClampLinesCounted(output, max)
  const newR = clampLinesCounted(output, max)
  expect(newR.longLines).toBe(oldR.longLines)
  expect(newR.longLineIndexes).toEqual(oldR.longLineIndexes)
  const srcLines = output.split("\n")
  const hasSplit =
    output.length > max && oldR.longLineIndexes.some((i) => splitsPair(srcLines[i], max))
  if (!hasSplit) {
    expect(newR.text).toBe(oldR.text)
    return false
  }
  expect(newR.text).not.toBe(oldR.text)
  const oldLines = oldR.text.split("\n")
  const newLines = newR.text.split("\n")
  expect(newLines.length).toBe(oldLines.length)
  for (let i = 0; i < srcLines.length; i++) {
    if (!oldR.longLineIndexes.includes(i)) {
      expect(newLines[i]).toBe(oldLines[i])
      continue
    }
    const src = srcLines[i]
    const o = splitMarker(oldLines[i])
    const n = splitMarker(newLines[i])
    if (!splitsPair(src, max)) {
      expect(newLines[i]).toBe(oldLines[i])
      continue
    }
    expect(n.kept.length).toBe(max - 1)
    expect(n.kept).toBe(src.slice(0, max - 1))
    expect(n.removed).toBe(src.length - n.kept.length)
    expect(o.kept.length).toBe(max)
    expect(loneCount(n.kept)).toBe(loneCount(o.kept) - 1)
  }
  return true
}

describe("clampLinesCounted: fuzz against the old function", () => {
  const ALPHABET = ["a", "b", "\n", EMOJI, "\u00e9", HIGH, LOW, "\r\n"]

  it("small caps (2..12): equal to old except at a split pair", () => {
    const rng = makeRng(0xc0ffee)
    let splits = 0
    const total = 4000
    for (let n = 0; n < total; n++) {
      const max = 2 + Math.floor(rng() * 11)
      const len = Math.floor(rng() * 40)
      let s = ""
      for (let k = 0; k < len; k++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)]
      if (checkCase(s, max)) splits++
    }
    // The generator must reach the split case a lot.
    expect(splits).toBeGreaterThan(100)
  })

  it("real cap (8192): emoji and lone surrogates at columns 8188..8195", () => {
    const rng = makeRng(0x5eed1234)
    const tokens = [EMOJI, EMOJI, HIGH, LOW, `${HIGH}a`, `a${LOW}`, `${LOW}${HIGH}`]
    let splits = 0
    const total = 4000
    for (let n = 0; n < total; n++) {
      const col = 8188 + Math.floor(rng() * 8)
      const token = tokens[Math.floor(rng() * tokens.length)]
      const tail = "b".repeat(Math.floor(rng() * 12))
      const long = `${"a".repeat(col)}${token}${tail}`
      const newlines = Math.floor(rng() * 4)
      const lines: string[] = []
      const slot = Math.floor(rng() * (newlines + 1))
      for (let k = 0; k <= newlines; k++) {
        lines.push(k === slot ? long : `short${k}${rng() < 0.3 ? EMOJI : ""}`)
      }
      if (checkCase(lines.join("\n"), CAP)) splits++
    }
    expect(splits).toBeGreaterThan(100)
  })
})

describe("truncateToolOutputParts: per-line clamp keeps no lone surrogate", () => {
  const ctx = { tool: "Read", startLine: 0 }

  it("a long non-ASCII line: kept has no lone surrogate, longLines is right", () => {
    const long = `${"a".repeat(CAP - 1)}${EMOJI}${"b".repeat(50)}`
    const output = `first\n${long}\nlast`
    const p = truncateToolOutputParts(output, ctx, EMPTY_SYNTHETIC_TEXT)
    expect(p.facts.longLines).toBe(1)
    expect(LONE_HIGH_RE.test(p.kept)).toBe(false)
    expect(LONE_LOW_RE.test(p.kept)).toBe(false)
    expect(p.kept).toBe(`first\n${"a".repeat(CAP - 1)}...(+${long.length - (CAP - 1)}ch)\nlast`)
  })

  it("an ASCII-only input is the same as the old clamp", () => {
    const output = `x\n${"a".repeat(CAP + 5)}\n${"b".repeat(CAP)}`
    const p = truncateToolOutputParts(output, ctx, EMPTY_SYNTHETIC_TEXT)
    expect(p.facts.longLines).toBe(1)
    expect(p.kept).toBe(oldClampLinesCounted(output, CAP).text)
  })
})

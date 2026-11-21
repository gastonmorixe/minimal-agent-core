import { describe, expect, it } from "bun:test"

import * as mod from "./token-estimate.ts"
import {
  type CharClassEstimatorParams,
  makeCharClassEstimator,
  makeCharRatioEstimator,
} from "./token-estimate.ts"

/** Test weights only. Core has no default: each test gives all weights. */
const PARAMS: CharClassEstimatorParams = {
  wordCharsPerToken: 4,
  shortWordMaxChars: 4,
  digitCharsPerToken: 3,
  punctCharsPerToken: 1,
  whitespaceCharsPerToken: 1,
  cjkCharsPerToken: 1,
  otherCharsPerToken: 2,
}

describe("plugin-api token-estimate exports", () => {
  it("has no default ratio and no default-ratio helper", () => {
    expect("DEFAULT_CHARS_PER_TOKEN" in mod).toBe(false)
    expect("estimateTokensFromText" in mod).toBe(false)
  })
})

describe("makeCharRatioEstimator", () => {
  it("estimates ceil(chars / ratio)", () => {
    const est = makeCharRatioEstimator(4)
    expect(est("")).toBe(0)
    expect(est("abcd")).toBe(1)
    expect(est("abcde")).toBe(2)
    expect(est("a".repeat(40))).toBe(10)
  })

  it("throws at construction on a ratio that is not a finite number > 0", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeCharRatioEstimator(bad)).toThrow(RangeError)
    }
    expect(() => makeCharRatioEstimator(undefined as unknown as number)).toThrow(RangeError)
  })
})

describe("makeCharClassEstimator", () => {
  const est = makeCharClassEstimator(PARAMS)

  it("gives 0 for the empty string", () => {
    expect(est("")).toBe(0)
  })

  it("ASCII prose: short words are one token, a single space is free", () => {
    // the(1) cat(1) sat(1) on(1) mat(1) "."(1) = 6
    expect(est("the cat sat on mat.")).toBe(6)
    // "internationalization" = 20 letters / 4 = 5
    expect(est("internationalization")).toBe(5)
  })

  it("code: punctuation and whitespace runs count", () => {
    // const(ceil 5/4=2) x(1) =(1) {(1) a(1) :(1) 1(1) }(1) ;(1) + "\n  "(3) = 13
    const code = "const x = {a: 1};\n  "
    expect(est(code)).toBe(13)
  })

  it("digits: groups of digitCharsPerToken", () => {
    expect(est("1234567")).toBe(3) // ceil(7/3)
    expect(est("123")).toBe(1)
  })

  it("CJK: about one token for each char", () => {
    expect(est("日本語のテキスト")).toBe(8)
    expect(est("한국어")).toBe(3)
  })

  it("emoji and other scripts use otherCharsPerToken on code points", () => {
    // Two emoji = 2 code points (4 UTF-16 units) / 2 = 1
    expect(est("😀😃")).toBe(1)
    expect(est("привет")).toBe(3) // 6 / 2
  })

  it("extra scripts override otherCharsPerToken", () => {
    const cyr = makeCharClassEstimator({
      ...PARAMS,
      scripts: [{ from: 0x0400, to: 0x04ff, charsPerToken: 3 }],
    })
    expect(cyr("привет")).toBe(2) // 6 / 3
  })

  it("scale multiplies the total and rounds up", () => {
    const scaled = makeCharClassEstimator({ ...PARAMS, scale: 1.5 })
    expect(scaled("internationalization")).toBe(Math.ceil(5 * 1.5))
  })

  it("is monotonic in length (same prefix, longer text)", () => {
    const sample =
      "Hello, world! 12345 日本語 😀 const f = (a) => a * 2;\n\tпривет résumé ".repeat(4)
    let prev = 0
    for (let i = 0; i <= sample.length; i++) {
      const n = est(sample.slice(0, i))
      expect(Number.isInteger(n)).toBe(true)
      expect(n).toBeGreaterThanOrEqual(prev)
      prev = n
    }
  })

  it("throws at construction on a weight that is not valid", () => {
    expect(() => makeCharClassEstimator({ ...PARAMS, wordCharsPerToken: 0 })).toThrow(RangeError)
    expect(() => makeCharClassEstimator({ ...PARAMS, cjkCharsPerToken: Number.NaN })).toThrow(
      RangeError,
    )
    expect(() => makeCharClassEstimator({ ...PARAMS, shortWordMaxChars: 1.5 })).toThrow(RangeError)
    expect(() => makeCharClassEstimator({ ...PARAMS, scale: -1 })).toThrow(RangeError)
    expect(() =>
      makeCharClassEstimator({ ...PARAMS, scripts: [{ from: 10, to: 5, charsPerToken: 1 }] }),
    ).toThrow(RangeError)
  })
})

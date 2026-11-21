/**
 * Provider-neutral token estimation BUILDING BLOCKS (pure, no defaults).
 *
 * Token estimation is a provider-to-model decision. Each provider plugin
 * knows the tokenizer family of its models and builds one
 * {@link TokenEstimator} for each `ModelEntry.estimateTokens`. This module
 * gives the plugins the building blocks only. It holds NO ratio, NO weight
 * and NO default: each number comes from the caller.
 *
 * - {@link makeCharRatioEstimator}: `ceil(chars / ratio)`. The ratio is required.
 * - {@link makeCharClassEstimator}: a char-class weighted heuristic (modelled
 *   on the `tokenx` approach). All weights are required.
 *
 * A model with no estimator has no estimate. Core then shows no count, or
 * uses a ratio-free upper bound where it must have a number (see
 * `src/llm/context-budget.ts`).
 *
 * The registry-bound lookup (`lookupTokenEstimator`, `estimateTokensForModel`)
 * is in `src/llm/token-estimate.ts`, because it reads the live model registry.
 *
 * @module llm/token-estimate
 */

/**
 * A function that estimates the token count of a piece of text. This is the
 * shape stored on `ModelEntry.estimateTokens`. It must return an integer, at least 0,
 * and `0` for the empty string.
 *
 * A model with `capabilities.outputTokensShareContextWindow: true` SHOULD
 * set an estimator. Without one, the `max_tokens` clamp uses the UTF-8 byte
 * count of the request as an upper bound of its input tokens. That bound is
 * approximately 3 to 4 times too high for English text and code, so the
 * clamp gives a much smaller `max_tokens` than the room that is left, and
 * on a large context it can go down to the floor (`MIN_OUTPUT_TOKENS`, 1024).
 */
export type TokenEstimator = (text: string) => number

/** Throws a `RangeError` when `value` is not a finite number greater than 0. */
function requirePositive(name: string, value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RangeError(
      `token-estimate: ${name} must be a finite number > 0 (got ${String(value)})`,
    )
  }
}

/**
 * Build a {@link TokenEstimator} from a fixed chars-per-token ratio.
 *
 * There is no default ratio. A ratio that is not a finite number greater than 0 is a
 * programmer error: the factory throws at construction (that is, at plugin
 * load), not at the first estimate.
 *
 * @param charsPerToken - Average UTF-16 code units for each token of the
 *   tokenizer family. Must be a finite number greater than 0.
 * @returns An estimator: `text => ceil(text.length / charsPerToken)`.
 * @throws RangeError when `charsPerToken` is not a finite number greater than 0.
 */
export function makeCharRatioEstimator(charsPerToken: number): TokenEstimator {
  requirePositive("charsPerToken", charsPerToken)
  return (text: string): number => {
    if (!text) return 0
    return Math.ceil(text.length / charsPerToken)
  }
}

/** One extra script for {@link CharClassEstimatorParams.scripts}. */
export interface CharClassScriptWeight {
  /** First code point of the range (inclusive). */
  readonly from: number
  /** Last code point of the range (inclusive). */
  readonly to: number
  /** Average code points for each token in this script. Finite, greater than 0. */
  readonly charsPerToken: number
}

/**
 * Weights of {@link makeCharClassEstimator}. ALL weights are REQUIRED: core
 * has no default. A provider plugin chooses them for each tokenizer family
 * (calibrate them on real data for that family).
 *
 * The estimator cuts the text into runs of one char class. Each run gives
 * `ceil(runLength / charsPerToken)` tokens, with the special cases that the
 * fields tell. The sum, times {@link scale}, rounded up, is the estimate.
 */
export interface CharClassEstimatorParams {
  /**
   * ASCII letter runs (`A-Z`, `a-z`) longer than {@link shortWordMaxChars}:
   * average letters for each token. Finite, greater than 0.
   */
  readonly wordCharsPerToken: number
  /**
   * An ASCII letter run of this length or shorter is ONE token (common short
   * words are one vocabulary entry). Integer, at least 0. `0` disables the rule.
   */
  readonly shortWordMaxChars: number
  /** ASCII digit runs (`0-9`): digits for each token (o200k groups 3). Finite, greater than 0. */
  readonly digitCharsPerToken: number
  /** ASCII punctuation and symbol runs: chars for each token. Finite, greater than 0. */
  readonly punctCharsPerToken: number
  /**
   * Whitespace runs (space, tab, CR, LF, FF, VT): chars for each token.
   * Finite, greater than 0. One plain space (U+0020) alone gives 0 tokens, because
   * BPE pre-tokenizers join it to the next word.
   */
  readonly whitespaceCharsPerToken: number
  /**
   * CJK ideographs, Hiragana, Katakana, Hangul and CJK punctuation: code
   * points for each token (about 1 for most tokenizers). Finite, greater than 0.
   */
  readonly cjkCharsPerToken: number
  /**
   * All other non-ASCII code points (Latin with diacritics, Cyrillic, Greek,
   * Arabic, emoji, ...) and ASCII control chars that no entry of
   * {@link scripts} covers: code points for each token. Finite, greater than 0.
   */
  readonly otherCharsPerToken: number
  /**
   * Optional extra scripts with their own weight (for example Cyrillic at
   * U+0400..U+04FF). The first range that contains a non-ASCII, non-CJK code
   * point wins. Absent: all such code points use {@link otherCharsPerToken}.
   */
  readonly scripts?: readonly CharClassScriptWeight[]
  /**
   * Optional multiplier on the total (for example `1.3` for a tokenizer that
   * gives 30% more tokens than the calibration family). Finite, greater than 0.
   * Absent: the total is not scaled.
   */
  readonly scale?: number
}

// Char classes of the scanner. Extra scripts use CLASS_SCRIPT0 + index.
const CLASS_NONE = 0
const CLASS_WORD = 1
const CLASS_DIGIT = 2
const CLASS_PUNCT = 3
const CLASS_SPACE = 4
const CLASS_CJK = 5
const CLASS_OTHER = 6
const CLASS_SCRIPT0 = 7

/** True for CJK ideographs, Kana, Hangul and CJK symbols/punctuation. */
function isCjk(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x2fdf) || // CJK radicals, Kangxi
    (cp >= 0x3000 && cp <= 0x30ff) || // CJK symbols, Hiragana, Katakana
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul compatibility Jamo
    (cp >= 0x31f0 && cp <= 0x4dbf) || // Katakana ext, enclosed, CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xff00 && cp <= 0xffef) || // half/full-width forms
    (cp >= 0x20000 && cp <= 0x3134f) // CJK ext B..G
  )
}

/**
 * Build a synchronous char-class weighted {@link TokenEstimator}.
 *
 * The approach follows `tokenx` (github.com/johannschopplich/tokenx): cut the
 * text into runs of ASCII letters, ASCII digits, ASCII punctuation,
 * whitespace, CJK, extra scripts and other code points, and weight each run.
 * It is pure and fast: one pass over the UTF-16 code units, no regex, no
 * allocation for each char, no dependency.
 *
 * There is no default weight. A weight that is not valid is a programmer
 * error: the factory throws at construction (that is, at plugin load).
 *
 * The result is an estimate, not a tokenizer. It is monotonic: a longer text
 * with the same prefix never gives fewer tokens.
 *
 * @param params - The weights (all required except `scripts` and `scale`).
 * @returns An estimator: `text => integer, at least 0`, `0` for `""`.
 * @throws RangeError when a weight is not valid.
 */
export function makeCharClassEstimator(params: CharClassEstimatorParams): TokenEstimator {
  requirePositive("wordCharsPerToken", params.wordCharsPerToken)
  requirePositive("digitCharsPerToken", params.digitCharsPerToken)
  requirePositive("punctCharsPerToken", params.punctCharsPerToken)
  requirePositive("whitespaceCharsPerToken", params.whitespaceCharsPerToken)
  requirePositive("cjkCharsPerToken", params.cjkCharsPerToken)
  requirePositive("otherCharsPerToken", params.otherCharsPerToken)
  if (!Number.isInteger(params.shortWordMaxChars) || params.shortWordMaxChars < 0) {
    throw new RangeError(
      `token-estimate: shortWordMaxChars must be an integer >= 0 (got ${String(params.shortWordMaxChars)})`,
    )
  }
  if (params.scale !== undefined) requirePositive("scale", params.scale)
  const scripts: CharClassScriptWeight[] = (params.scripts ?? []).map((s, i) => {
    requirePositive(`scripts[${i}].charsPerToken`, s.charsPerToken)
    if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from < 0 || s.to < s.from) {
      throw new RangeError(`token-estimate: scripts[${i}] must have integers 0 <= from <= to`)
    }
    return { from: s.from, to: s.to, charsPerToken: s.charsPerToken }
  })

  // Copy the weights into locals: the hot loop reads no params fields.
  const wordCpt = params.wordCharsPerToken
  const shortMax = params.shortWordMaxChars
  const digitCpt = params.digitCharsPerToken
  const punctCpt = params.punctCharsPerToken
  const spaceCpt = params.whitespaceCharsPerToken
  const cjkCpt = params.cjkCharsPerToken
  const otherCpt = params.otherCharsPerToken
  const scale = params.scale ?? 1
  const scriptCount = scripts.length

  /** Tokens of one run. `plainSpace` is true for a run of one U+0020. */
  const runTokens = (cls: number, len: number, plainSpace: boolean): number => {
    switch (cls) {
      case CLASS_NONE:
        return 0
      case CLASS_WORD:
        return len <= shortMax ? 1 : Math.ceil(len / wordCpt)
      case CLASS_DIGIT:
        return Math.ceil(len / digitCpt)
      case CLASS_PUNCT:
        return Math.ceil(len / punctCpt)
      case CLASS_SPACE:
        return plainSpace ? 0 : Math.ceil(len / spaceCpt)
      case CLASS_CJK:
        return Math.ceil(len / cjkCpt)
      case CLASS_OTHER:
        return Math.ceil(len / otherCpt)
      default:
        return Math.ceil(len / (scripts[cls - CLASS_SCRIPT0] as CharClassScriptWeight).charsPerToken)
    }
  }

  return (text: string): number => {
    if (!text) return 0
    let total = 0
    let runClass = CLASS_NONE
    let runLen = 0
    let runPlainSpace = false
    const n = text.length
    for (let i = 0; i < n; i++) {
      let cp = text.charCodeAt(i)
      let cls: number
      if (cp < 0x80) {
        if ((cp >= 0x61 && cp <= 0x7a) || (cp >= 0x41 && cp <= 0x5a)) cls = CLASS_WORD
        else if (cp >= 0x30 && cp <= 0x39) cls = CLASS_DIGIT
        else if (cp === 0x20 || (cp >= 0x09 && cp <= 0x0d)) cls = CLASS_SPACE
        else if (cp > 0x20 && cp < 0x7f) cls = CLASS_PUNCT
        else cls = CLASS_OTHER // ASCII control chars
      } else {
        // Join a surrogate pair into one code point.
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < n) {
          const lo = text.charCodeAt(i + 1)
          if (lo >= 0xdc00 && lo <= 0xdfff) {
            cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00)
            i++
          }
        }
        if (isCjk(cp)) cls = CLASS_CJK
        else {
          cls = CLASS_OTHER
          for (let s = 0; s < scriptCount; s++) {
            const sw = scripts[s] as CharClassScriptWeight
            if (cp >= sw.from && cp <= sw.to) {
              cls = CLASS_SCRIPT0 + s
              break
            }
          }
        }
      }
      if (cls === runClass) {
        runLen++
        runPlainSpace = false
      } else {
        total += runTokens(runClass, runLen, runPlainSpace)
        runClass = cls
        runLen = 1
        runPlainSpace = cp === 0x20
      }
    }
    total += runTokens(runClass, runLen, runPlainSpace)
    return Math.ceil(total * scale)
  }
}

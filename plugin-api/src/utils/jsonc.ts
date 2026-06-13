/**
 * Minimal JSONC (JSON with Comments) parser.
 *
 * Supports the two comment forms in the JSONC spec, plus trailing commas
 * (a common JSONC extension):
 *
 *   - Line comments:  `// ...` to end of line
 *   - Block comments: `/* ... *\/`
 *   - Trailing commas in objects and arrays
 *
 * Implementation is a single-pass character scanner that strips comments
 * and trailing commas to produce ordinary JSON, then defers to the
 * built-in `JSON.parse`. Strings are scanned with escape-awareness so
 * `"//"` inside a string value is preserved.
 *
 * Why not a dep? The whole stripper is under 50 lines and the project
 * prefers zero-dep where reasonable.
 */

/** Strip JSONC comments and trailing commas. Returns plain JSON text. */
export function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  const n = input.length

  while (i < n) {
    const c = input[i]
    const next = input[i + 1]

    // String literal: copy verbatim, respecting escapes.
    if (c === '"') {
      const start = i
      i++
      while (i < n) {
        const ch = input[i]
        if (ch === "\\") {
          i += 2
          continue
        }
        if (ch === '"') {
          i++
          break
        }
        i++
      }
      out += input.slice(start, i)
      continue
    }

    // Line comment: skip until newline (newline itself is preserved as
    // whitespace so line numbers in error messages stay aligned).
    if (c === "/" && next === "/") {
      i += 2
      while (i < n && input[i] !== "\n") i++
      continue
    }

    // Block comment: skip until `*/`. Replace with a single space so
    // tokens that were separated only by the comment don't fuse.
    if (c === "/" && next === "*") {
      i += 2
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2 // consume `*/` (or stop at EOF if unterminated)
      out += " "
      continue
    }

    out += c
    i++
  }

  // Strip trailing commas: `,` followed by optional whitespace then `}` or `]`.
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return out
}

/** Parse JSONC text. Throws on invalid JSON after comment stripping. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}

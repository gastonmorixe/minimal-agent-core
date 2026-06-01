/**
 * Minimal JSONC parser — strip comments + trailing commas, then
 * `JSON.parse`.
 *
 * Deliberately a local copy of the host's `src/jsonc.ts` logic (≈25 lines)
 * rather than an import, so the config plugin's pure `lib/` core has ZERO
 * coupling to agent internals — it interacts with the host only through the
 * command/handler context and the shared bus, per the plugin contract. The
 * core is therefore exhaustively unit-testable in isolation.
 *
 * Used here only as a validation safety-net: after a surgical edit, confirm
 * the produced text still parses so a bug never writes a broken config.
 *
 * @module config/lib/mini-jsonc
 */

/** Strip JSONC comments and trailing commas. Returns plain JSON text. */
export function stripJsonc(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    const c = input[i]
    const next = input[i + 1]
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
    if (c === "/" && next === "/") {
      i += 2
      while (i < n && input[i] !== "\n") i++
      continue
    }
    if (c === "/" && next === "*") {
      i += 2
      while (i < n && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 2
      out += " "
      continue
    }
    out += c
    i++
  }
  out = out.replace(/,(\s*[}\]])/g, "$1")
  return out
}

/** Parse JSONC text. Throws on invalid JSON after comment stripping. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text))
}

/**
 * Comment-preserving JSONC editor.
 *
 * The agent's `src/jsonc.ts` can READ jsonc (it strips comments then
 * `JSON.parse`s). It cannot WRITE while keeping the user's comments and
 * layout — round-tripping through `JSON.parse`/`JSON.stringify` discards
 * every `//` note the user wrote to remind themselves why a knob is set.
 * For a config editor that's unacceptable: the comments ARE the docs.
 *
 * This module performs *surgical* edits on the raw text. It locates a
 * top-level (or nested) key by scanning structure (string/comment aware)
 * and replaces just that key's value token, or inserts/removes the
 * key, touching nothing else. Comments, trailing commas, indentation, and
 * key order all survive.
 *
 * Scope + guarantees:
 *   - Object key paths only (`["plugins", "ma-fetch", "enabled"]`). Array
 *     index paths are out of scope (the config surface we edit is all
 *     objects). A path that descends through a non-object is created.
 *   - `setKeyPath` rewrites an existing key's value in place, or inserts a
 *     new `"key": value` member (creating intermediate objects as needed).
 *   - `removeKeyPath` deletes a key and its value, plus one adjacent comma,
 *     leaving the rest of the object well-formed.
 *   - Values are injected as compact JSON (`JSON.stringify(value)`); the
 *     surrounding whitespace/indent of the existing member is reused on
 *     rewrite, and inferred from siblings on insert.
 *   - The result is always parseable by `src/jsonc.ts`. We re-validate by
 *     stripping + `JSON.parse` and throw `JsoncEditError` if a bug produced
 *     malformed output, so a caller never writes a broken config.
 *
 * It is intentionally NOT a general JSON formatter. It does the minimum
 * mutation needed and bails (throwing `JsoncEditError`) on shapes it can't
 * safely edit (e.g. the root isn't an object), so the caller can fall back
 * to a full re-serialize with a warning rather than corrupt the file.
 *
 * Pure + dependency-free (no host imports) so it's exhaustively
 * unit-testable in isolation.
 *
 * @module config/lib/jsonc-edit
 */

import { parseJsonc } from "./mini-jsonc.ts"

/** Thrown when an edit cannot be performed safely on the given text. */
export class JsoncEditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "JsoncEditError"
  }
}

// ---------------------------------------------------------------------------
// Tokenizer-ish structural scanner
// ---------------------------------------------------------------------------

/**
 * Scan forward from `i` over insignificant text: whitespace + line and
 * block comments. Returns the index of the next significant char (or
 * `s.length` at EOF). Does not cross into strings (callers handle those).
 */
function skipTrivia(s: string, i: number): number {
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++
      continue
    }
    if (c === "/" && s[i + 1] === "/") {
      i += 2
      while (i < n && s[i] !== "\n") i++
      continue
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++
      i += 2
      continue
    }
    break
  }
  return i
}

/**
 * Given `s[i] === '"'`, return the index just past the closing quote.
 * Escape-aware. Throws if unterminated.
 */
function scanString(s: string, i: number): number {
  const n = s.length
  i++ // opening quote
  while (i < n) {
    const c = s[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === '"') return i + 1
    i++
  }
  throw new JsoncEditError("unterminated string literal")
}

/**
 * Scan one JSON value starting at significant char `i` (object, array,
 * string, number, true/false/null). Returns the index just past the value.
 * Comment/string-aware for compound values.
 */
function scanValue(s: string, i: number): number {
  const n = s.length
  const c = s[i]
  if (c === '"') return scanString(s, i)
  if (c === "{" || c === "[") return scanContainer(s, i)
  // Primitive: number / true / false / null. Read until a structural
  // terminator (`,`, `}`, `]`) or trivia start. We stop at the first char
  // that can't be part of a bare token.
  let j = i
  while (j < n) {
    const ch = s[j]
    if (
      ch === "," ||
      ch === "}" ||
      ch === "]" ||
      ch === " " ||
      ch === "\t" ||
      ch === "\r" ||
      ch === "\n" ||
      (ch === "/" && (s[j + 1] === "/" || s[j + 1] === "*"))
    ) {
      break
    }
    j++
  }
  if (j === i) throw new JsoncEditError(`expected a value at index ${i}`)
  return j
}

/** Scan a balanced `{...}` or `[...]`, string + comment aware. */
function scanContainer(s: string, i: number): number {
  const n = s.length
  const open = s[i]
  const close = open === "{" ? "}" : "]"
  let depth = 0
  while (i < n) {
    const c = s[i]
    if (c === '"') {
      i = scanString(s, i)
      continue
    }
    if (c === "/" && s[i + 1] === "/") {
      i += 2
      while (i < n && s[i] !== "\n") i++
      continue
    }
    if (c === "/" && s[i + 1] === "*") {
      i += 2
      while (i < n && !(s[i] === "*" && s[i + 1] === "/")) i++
      i += 2
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i + 1
    }
    i++
  }
  throw new JsoncEditError(`unbalanced ${open}${close}`)
}

interface Member {
  /** Index of the opening quote of the key. */
  keyStart: number
  /** Decoded key name. */
  key: string
  /** Index of the first significant char of the value. */
  valueStart: number
  /** Index just past the value. */
  valueEnd: number
}

/**
 * Parse the members of the object whose `{` is at `objOpen`. Returns the
 * member list plus the index of the matching `}`.
 */
function parseObjectMembers(s: string, objOpen: number): { members: Member[]; objClose: number } {
  const n = s.length
  const members: Member[] = []
  let i = objOpen + 1
  for (;;) {
    i = skipTrivia(s, i)
    if (i >= n) throw new JsoncEditError("unterminated object")
    if (s[i] === "}") return { members, objClose: i }
    if (s[i] !== '"') {
      throw new JsoncEditError(`expected a quoted key at index ${i}, found ${JSON.stringify(s[i])}`)
    }
    const keyStart = i
    const keyEnd = scanString(s, i)
    const key = JSON.parse(s.slice(keyStart, keyEnd)) as string
    i = skipTrivia(s, keyEnd)
    if (s[i] !== ":") throw new JsoncEditError(`expected ':' after key at index ${i}`)
    i = skipTrivia(s, i + 1)
    const valueStart = i
    const valueEnd = scanValue(s, i)
    members.push({ keyStart, key, valueStart, valueEnd })
    i = skipTrivia(s, valueEnd)
    if (s[i] === ",") {
      i++
      continue
    }
    if (s[i] === "}") return { members, objClose: i }
    throw new JsoncEditError(`expected ',' or '}' after value at index ${i}`)
  }
}

/** Find the root object's opening brace index, or throw. */
function findRootObject(s: string): number {
  const i = skipTrivia(s, 0)
  if (s[i] !== "{") throw new JsoncEditError("root value is not an object")
  return i
}

// ---------------------------------------------------------------------------
// Indentation inference
// ---------------------------------------------------------------------------

/** The indent (leading whitespace of the line) at byte index `i`. */
function lineIndentAt(s: string, i: number): string {
  const lineStart = s.lastIndexOf("\n", i - 1) + 1
  let j = lineStart
  while (j < s.length && (s[j] === " " || s[j] === "\t")) j++
  return s.slice(lineStart, j)
}

/** Guess the document's indent unit (e.g. "  ") from the first indented line. */
function guessIndentUnit(s: string): string {
  const m = /\n([ \t]+)\S/.exec(s)
  return m?.[1] ?? "  "
}

// ---------------------------------------------------------------------------
// Public: set a key path
// ---------------------------------------------------------------------------

/**
 * Set (or insert) the value at `path` in JSONC `text`, preserving comments
 * and layout. Returns the new text.
 *
 * @param text - Raw JSONC document. An empty/blank document becomes `{}` first.
 * @param path - Non-empty object key path, e.g. `["plugins","ma-fetch","enabled"]`.
 * @param value - Any JSON-serializable value to write at the path.
 * @throws JsoncEditError when the structure can't be edited safely.
 */
export function setKeyPath(text: string, path: string[], value: unknown): string {
  if (path.length === 0) throw new JsoncEditError("path must be non-empty")
  const base = text.trim().length === 0 ? "{}\n" : text
  const out = setKeyPathInObject(base, findRootObject(base), path, value)
  assertParseable(out)
  return out
}

function setKeyPathInObject(s: string, objOpen: number, path: string[], value: unknown): string {
  const [head, ...rest] = path
  if (head === undefined) throw new JsoncEditError("empty path segment")
  const { members, objClose } = parseObjectMembers(s, objOpen)
  const existing = members.find((m) => m.key === head)

  if (rest.length === 0) {
    // Leaf: rewrite or insert `head`.
    const literal = JSON.stringify(value)
    if (existing) {
      return s.slice(0, existing.valueStart) + literal + s.slice(existing.valueEnd)
    }
    return insertMember(s, objOpen, objClose, members, head, literal)
  }

  // Descend. If `head` exists and is an object, recurse into it.
  if (existing) {
    const vs = skipTrivia(s, existing.valueStart)
    if (s[vs] === "{") {
      return setKeyPathInObject(s, vs, rest, value)
    }
    // Existing non-object at an interior path: replace it wholesale with a
    // freshly-built nested object literal (compact). Rare in practice.
    const literal = JSON.stringify(buildNested(rest, value))
    return s.slice(0, existing.valueStart) + literal + s.slice(existing.valueEnd)
  }

  // `head` missing: insert a nested object literal carrying the rest.
  const literal = JSON.stringify(buildNested(rest, value))
  return insertMember(s, objOpen, objClose, members, head, literal)
}

/** Build a nested object `{rest[0]: {rest[1]: ... value}}`. */
function buildNested(path: string[], value: unknown): unknown {
  let acc: unknown = value
  for (let i = path.length - 1; i >= 0; i--) {
    acc = { [path[i] as string]: acc }
  }
  return acc
}

/**
 * Insert a new `"key": valueLiteral` member into the object. Reuses sibling
 * indentation when present; otherwise expands the object onto its own lines.
 */
function insertMember(
  s: string,
  objOpen: number,
  objClose: number,
  members: Member[],
  key: string,
  valueLiteral: string,
): string {
  const keyLiteral = JSON.stringify(key)
  const member = `${keyLiteral}: ${valueLiteral}`

  if (members.length > 0) {
    // Insert after the last member, matching its indentation. Add a comma
    // to the previous last member if it doesn't already have a trailing one.
    const last = members[members.length - 1]!
    const indent = lineIndentAt(s, last.keyStart)
    // Is there already a comma between last.valueEnd and objClose?
    const between = s.slice(last.valueEnd, objClose)
    const hasComma = /^\s*,/.test(between)
    if (hasComma) {
      // Find the comma position and insert after it (before any trailing
      // comment on that line we keep the comment attached to the prior line).
      const commaRel = between.indexOf(",")
      const commaAbs = last.valueEnd + commaRel
      return s.slice(0, commaAbs + 1) + `\n${indent}${member},` + s.slice(commaAbs + 1)
    }
    return s.slice(0, last.valueEnd) + `,\n${indent}${member}` + s.slice(last.valueEnd)
  }

  // Empty object `{}` (possibly with whitespace/comments inside). Expand it.
  const unit = guessIndentUnit(s)
  const outerIndent = lineIndentAt(s, objOpen)
  const inner = `\n${outerIndent}${unit}${member}\n${outerIndent}`
  return s.slice(0, objOpen + 1) + inner + s.slice(objClose)
}

// ---------------------------------------------------------------------------
// Public: remove a key path
// ---------------------------------------------------------------------------

/**
 * Remove the key at `path` (and its value) from JSONC `text`. Returns the
 * new text. A no-op (returns `text` unchanged) when the key is absent.
 *
 * Removes one adjacent comma so the surrounding object stays well-formed.
 * Comments on OTHER members are preserved; a trailing line comment on the
 * removed member's own line is removed with it.
 */
export function removeKeyPath(text: string, path: string[]): string {
  if (path.length === 0) throw new JsoncEditError("path must be non-empty")
  if (text.trim().length === 0) return text
  const out = removeKeyPathInObject(text, findRootObject(text), path)
  if (out !== text) assertParseable(out)
  return out
}

function removeKeyPathInObject(s: string, objOpen: number, path: string[]): string {
  const [head, ...rest] = path
  if (head === undefined) return s
  const { members } = parseObjectMembers(s, objOpen)
  const target = members.find((m) => m.key === head)
  if (!target) return s // absent → no-op

  if (rest.length > 0) {
    const vs = skipTrivia(s, target.valueStart)
    if (s[vs] !== "{") return s // can't descend; leave it
    return removeKeyPathInObject(s, vs, rest)
  }

  // Leaf removal. Decide deletion span [delStart, delEnd] based on layout.
  //
  //   - "own-line": only whitespace separates the key from the previous
  //     newline (or doc start). We delete the indent + member + the line's
  //     newline so no blank line is left behind.
  //   - "inline": something else shares the line (e.g. `{ "a": 1, "b": 2 }`).
  //     We delete just the member + one adjacent comma, never the shared line.
  //
  // `tailAfter(i)` consumes same-line trailing whitespace + an optional
  // line comment that belonged to the removed member.
  const { keyStart, valueEnd } = target
  let indentStart = keyStart
  while (indentStart > 0 && (s[indentStart - 1] === " " || s[indentStart - 1] === "\t")) {
    indentStart--
  }
  const ownLine = indentStart === 0 || s[indentStart - 1] === "\n"
  const tailAfter = (i: number): number => {
    const m = /^[ \t]*(\/\/[^\n]*)?/.exec(s.slice(i))
    return i + (m ? m[0].length : 0)
  }

  // Trailing comma? (significant chars only between value and the comma.)
  const afterVal = skipTriviaNoNewlineThenComma(s, valueEnd)
  if (afterVal !== -1) {
    // Member is followed by a comma: drop member + comma + own-line tail.
    let cut = tailAfter(afterVal + 1)
    if (ownLine && s[cut] === "\n") cut += 1
    const start = ownLine ? indentStart : keyStart
    return s.slice(0, start) + s.slice(cut)
  }

  // No trailing comma → this is the LAST (or sole) member. Try to drop the
  // PRECEDING comma so the new last member has no dangling separator. Scan
  // back over whitespace only; if a comment intervenes we simply leave the
  // comma (a trailing comma is valid JSONC, stripped on parse).
  let back = indentStart - 1
  while (
    back >= 0 &&
    (s[back] === " " || s[back] === "\t" || s[back] === "\n" || s[back] === "\r")
  ) {
    back--
  }
  let delEnd = tailAfter(valueEnd)
  if (ownLine && s[delEnd] === "\n") delEnd += 1
  if (back >= 0 && s[back] === ",") {
    return s.slice(0, back) + s.slice(delEnd)
  }

  // Sole member: collapse to an empty object body.
  const start = ownLine ? indentStart : keyStart
  return s.slice(0, start) + s.slice(delEnd)
}

/**
 * From `i` (just past a value), skip same-line spaces/tabs and return the
 * index of a following `,`, or `-1` if the next significant char isn't a
 * comma (i.e. the member is the last one). Newlines and comments before a
 * comma are tolerated (a comma can sit on the next line).
 */
function skipTriviaNoNewlineThenComma(s: string, i: number): number {
  const j = skipTrivia(s, i)
  return s[j] === "," ? j : -1
}

// ---------------------------------------------------------------------------
// Safety net
// ---------------------------------------------------------------------------

/** Throw if the produced text no longer parses as JSONC. */
function assertParseable(s: string): void {
  try {
    parseJsonc(s)
  } catch (e) {
    throw new JsoncEditError(
      `edit produced unparseable JSONC: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

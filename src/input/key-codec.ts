/**
 * Pure terminal key-sequence codec shared by the two raw-stdin consumers
 * ({@link RawInput} in `src/input.ts` and the `EditorController` key
 * dispatcher in `src/editor/key-dispatch.ts`).
 *
 * Covers the two "modified key" encodings modern terminals emit once we
 * enable them at startup:
 *
 *   - kitty keyboard protocol CSI-u sequences (`\x1b[<code>;<mods>u`),
 *     optionally carrying associated text code points;
 *   - xterm `modifyOtherKeys=2` sequences (`\x1b[27;<mods>;<code>~`).
 *
 * Everything in this module is a pure function of its string input - no
 * terminal state, no timers - so both consumers parse identically and the
 * functions are trivially unit-testable.
 *
 * @module input/key-codec
 */

/**
 * A decoded modified-key event: the key's Unicode code point, the kitty /
 * xterm modifier bitfield (1-based; see {@link hasModifier}), the kitty
 * event type (1 = press, 2 = repeat, 3 = release), and the associated
 * text code points (kitty flag 16), when present.
 */
export type ParsedKey = {
  code: number
  modifiers: number
  eventType: number
  text: string | null
}

/**
 * Parse a kitty CSI-u key sequence (`\x1b[<code>[:alts];<mods>[:event][;<text>]u`).
 * Returns `null` when `seq` is not a well-formed CSI-u key.
 */
export function parseCsiUKey(seq: string): ParsedKey | null {
  if (!seq.endsWith("u")) return null
  const body = seq.slice(2, -1)
  const fields = body.split(";")
  const code = Number(fields[0]?.split(":")[0] ?? "")
  if (!Number.isInteger(code)) return null
  const modParts = fields[1]?.split(":") ?? []
  const modifiers = modParts[0] ? Number(modParts[0]) : 1
  const eventType = modParts[1] ? Number(modParts[1]) : 1
  if (!Number.isInteger(modifiers) || modifiers < 1) return null
  if (!Number.isInteger(eventType) || eventType < 1) return null
  return {
    code,
    modifiers,
    eventType,
    text: parseTextCodePoints(fields[2]),
  }
}

/**
 * Parse an xterm `modifyOtherKeys` sequence (`\x1b[27;<mods>;<code>~`).
 * Returns `null` when `seq` is not a well-formed modifyOtherKeys event.
 */
export function parseXtermOtherKey(seq: string): ParsedKey | null {
  if (!seq.endsWith("~")) return null
  const body = seq.slice(2, -1)
  const fields = body.split(";")
  if (fields.length < 3 || fields[0] !== "27") return null
  const modifiers = Number(fields[1])
  const code = Number(fields[2])
  if (!Number.isInteger(code) || !Number.isInteger(modifiers) || modifiers < 1) return null
  return { code, modifiers, eventType: 1, text: null }
}

/**
 * Decode a kitty associated-text field (colon-separated decimal code
 * points) into a string. Returns `null` for an absent/empty/malformed
 * field.
 */
export function parseTextCodePoints(field?: string): string | null {
  if (!field) return null
  const codePoints: number[] = []
  for (const part of field.split(":")) {
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0) return null
    codePoints.push(value)
  }
  return codePoints.length > 0 ? String.fromCodePoint(...codePoints) : null
}

/**
 * Test a kitty/xterm modifier bitfield for one modifier bit
 * (0 = shift, 1 = alt, 2 = ctrl). The wire encoding is 1-based, hence
 * the `- 1`.
 */
export function hasModifier(modifiers: number, bit: number): boolean {
  return ((modifiers - 1) & (1 << bit)) !== 0
}

/**
 * True when `char` (a single code point) is a printable character:
 * at or above SPACE and not DEL.
 */
export function isPrintableChar(char: string): boolean {
  const cp = char.codePointAt(0)
  return cp !== undefined && cp >= 0x20 && char !== "\x7f"
}

/** Code-point form of {@link isPrintableChar}. */
export function isPrintableCodePoint(cp: number): boolean {
  return cp >= 0x20 && cp !== 0x7f
}

/**
 * Index of the final byte of a CSI sequence starting at `input[0]`
 * (`ESC [`): the first byte in `0x40..0x7e` at position 2 or later. Returns
 * `null` while the sequence is still incomplete (caller waits for more
 * bytes).
 */
export function findCsiEnd(input: string): number | null {
  for (let i = 2; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code >= 0x40 && code <= 0x7e) return i
  }
  return null
}

/**
 * Length of the longest strict prefix of `pattern` that `text` ends
 * with. Used to hold back a partial bracketed-paste terminator that
 * straddles two stdin chunks.
 */
export function trailingPrefixLength(text: string, pattern: string): number {
  const max = Math.min(text.length, pattern.length - 1)
  for (let len = max; len > 0; len--) {
    if (text.endsWith(pattern.slice(0, len))) return len
  }
  return 0
}

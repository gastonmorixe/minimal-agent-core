/**
 * Plain-text check for manifest strings that help prints to a terminal
 * (SPEC-HELP R-3). Shared by `manifest-cli.ts` (the `cli` block and
 * host-mode `args`/`examples`) and `manifest-host-mode.ts` (host-mode
 * `description`, R-19).
 *
 * @module plugins/manifest-text
 */

/**
 * True when `code` (one UTF-16 unit) is a character that help text must not
 * hold:
 *
 * - C0 controls U+0000 to U+001F (ESC, newline, tab, ...) and DEL U+007F.
 * - C1 controls U+0080 to U+009F. U+009B is the 8-bit CSI, and some
 *   terminals act on it like `ESC [`.
 *   Source: https://unicode.org/charts/PDF/U0080.pdf
 * - Bidi formatting characters, which can reorder text on screen
 *   (CVE-2021-42574, "Trojan Source"): LRE, RLE, PDF, LRO, RLO
 *   (U+202A to U+202E), LRI, RLI, FSI, PDI (U+2066 to U+2069), and the
 *   marks LRM U+200E, RLM U+200F, ALM U+061C.
 *   Source: https://www.unicode.org/reports/tr9/
 */
export function isUnsafeTextCode(code: number): boolean {
  if (code < 0x20) return true
  if (code >= 0x7f && code <= 0x9f) return true
  if (code >= 0x202a && code <= 0x202e) return true
  if (code >= 0x2066 && code <= 0x2069) return true
  return code === 0x200e || code === 0x200f || code === 0x061c
}

/** True when `s` holds at least one character that {@link isUnsafeTextCode} rejects. */
export function hasUnsafeTextChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (isUnsafeTextCode(s.charCodeAt(i))) return true
  }
  return false
}

/**
 * Check one plain-text value (R-3).
 *
 * @param raw - The raw value.
 * @param max - Max length in UTF-16 units.
 * @param nonEmpty - When true, the empty string is an error.
 * @returns `undefined` when `raw` is valid plain text, else the error text.
 */
export function plainTextError(raw: unknown, max: number, nonEmpty = true): string | undefined {
  if (typeof raw !== "string") return "must be a string"
  if (nonEmpty && raw.length === 0) return "must not be empty"
  if (raw.length > max) return `longer than ${max} characters`
  if (hasUnsafeTextChar(raw)) {
    return "control or bidi characters (ESC, newline, tab, DEL, C1, bidi marks) are not allowed"
  }
  return undefined
}

/**
 * Pure version comparison for {@link BinarySpec.version} tokens.
 *
 * Two shapes are accepted, chosen so the host NEVER has to execute a binary
 * to learn how it compares:
 *
 *   1. Bare integer ("1733345678"). The recommended CI naming, an epoch
 *      second count baked into the artifact filename. Monotonic by build time.
 *   2. Dotted numeric ("0.1.6", "1.2"). Classic semver-ish. Compared
 *      field-by-field, missing trailing fields treated as 0.
 *
 * Mixed shapes: an all-digit token (no dots) is treated as a single integer
 * field, so "1733345678" > "0.1.6" (a 10-digit epoch dwarfs any dotted
 * release). That is intentional: once CI moves to epoch naming, every epoch
 * build sorts above legacy dotted tags, which is the desired migration order.
 *
 * @module binaries/version
 */

/** A parsed, comparable version. */
interface ParsedVersion {
  /** Numeric fields, left to right. Non-numeric tokens contribute 0. */
  fields: number[]
}

/**
 * Parse a version token into numeric fields. Strips a leading `v`. Splits on
 * `.`; each field keeps only its leading run of digits (so "1-rc2" → 1).
 * Returns `null` when there is no numeric content at all (e.g. "latest"),
 * which the caller treats as "incomparable / unknown".
 */
export function parseVersion(token: string): ParsedVersion | null {
  const trimmed = token.trim().replace(/^v/i, "")
  if (trimmed.length === 0) return null
  const parts = trimmed.split(".")
  const fields: number[] = []
  let sawDigit = false
  for (const p of parts) {
    const m = p.match(/^\d+/)
    if (m) {
      sawDigit = true
      // Use Number (not parseInt) capped via Number.MAX_SAFE: a 10-digit
      // epoch (≈1.7e9) is far under MAX_SAFE_INTEGER (9e15), so precision is
      // exact for any realistic token.
      fields.push(Number(m[0]))
    } else {
      fields.push(0)
    }
  }
  return sawDigit ? { fields } : null
}

/**
 * Compare two version tokens.
 *
 * @returns negative if `a < b`, 0 if equal, positive if `a > b`. When either
 *   token is unparseable, returns `NaN` so the caller can decide (the store
 *   treats an unparseable installed version as `"unknown-version"` → reinstall).
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return Number.NaN
  const len = Math.max(pa.fields.length, pb.fields.length)
  for (let i = 0; i < len; i++) {
    const av = pa.fields[i] ?? 0
    const bv = pb.fields[i] ?? 0
    if (av !== bv) return av < bv ? -1 : 1
  }
  return 0
}

/**
 * Is `candidate` strictly newer than `installed`? Unparseable inputs → false
 * (the store handles the "unknown installed version" case separately, by
 * forcing a reinstall rather than relying on this predicate).
 */
export function isNewer(candidate: string, installed: string): boolean {
  const cmp = compareVersions(candidate, installed)
  return Number.isNaN(cmp) ? false : cmp > 0
}

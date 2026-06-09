/**
 * Bullet parser, id generation, and format helpers for the `memory` plugin.
 *
 * Memory files are line-oriented markdown. Each "bullet" is a line of the form
 *
 *     - [#<id>] [<iso-ts>] [session:<sid>] body
 *
 * with `[#<id>]`, `[<iso-ts>]`, and `[session:<sid>]` all optional, and `body`
 * being free text (single line). Older files (pre-v0.3) and hand-edited
 * bullets may be missing any subset of those fields, including all three;
 * the loader has always treated memory files as opaque text, so legacy
 * shapes coexist freely with new shapes in the same file.
 *
 * ## Id format
 *
 * Two regimes:
 *
 * - **Persistent** (global, project): `<base36-millis>-<rand4hex>`
 *   e.g. `lwq8tg-a8f3`. Sortable by `Date.now()` (millisecond precision)
 *   so lexicographic sort = chronological sort. Random tail prevents
 *   ms-collision and makes ids opaque to the eye (so the model is less
 *   tempted to reason about timestamps).
 *
 * - **Short-term** (per-session scratchpad): a small auto-incrementing
 *   integer (`1`, `2`, `3`, …). The "next id" is `max-seen-int + 1`
 *   across the live file — never reuses an int even after deletes, so
 *   ids stay stable across the session.
 *
 * Legacy bullets (no `[#id]` prefix) get a synthetic id of the form
 * `legacy:<sha12>` derived from the *full raw line*. That hash includes
 * any timestamp/session prefix, so two bullets with identical bodies but
 * different metadata get distinct ids — important for delete/edit by id
 * to land on the right line.
 *
 * @module memory/lib/parse
 */

import { createHash, randomBytes } from "node:crypto"

// ---------------------------------------------------------------------------
// Bullet model
// ---------------------------------------------------------------------------

/**
 * A parsed bullet from a memory file.
 *
 * `isLegacy === true` when the line did NOT carry an `[#id]` prefix; in
 * that case `id` is a synthetic `legacy:<sha12>` derived from the raw
 * line (so the model can still address legacy bullets by id without
 * touching the file).
 */
export interface Bullet {
  /** `lwq8tg-a8f3` (persistent), `3` (short-term int as string), or `legacy:<sha12>`. */
  id: string
  /** ISO 8601 (local time, with offset). `null` for legacy lines that lack a timestamp. */
  ts: string | null
  /** Session UUID (no `session:` prefix). `null` when the bullet was saved without a sid. */
  sid: string | null
  /** Free-text body. Always single-line; multi-line bodies are collapsed by `formatBullet`. */
  body: string
  /** True when the line had no `[#id]` prefix and `id` is `legacy:<sha12>`. */
  isLegacy: boolean
  /**
   * The raw line as read from the file (without the trailing newline).
   * Preserved verbatim so `serializeFile` can write back unchanged for
   * lines we didn't mutate (idempotent round-trip).
   */
  raw: string
}

/**
 * Input shape for `formatBullet`. The body may be multi-line (it'll be
 * collapsed to one line); ts/sid are optional; an explicit id is
 * required (the caller decides on the id strategy — the parser is dumb).
 */
export interface BulletInput {
  id: string
  ts: string | null
  sid: string | null
  body: string
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

// Anchored regexes for the three optional prefix fields. We try each in
// turn, advancing the cursor through the line — much simpler to reason
// about than one giant regex with optional groups.
const ID_RE = /^\[#([^\]]+)\]\s+/
const TS_RE = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2})\]\s+/
const SID_RE = /^\[session:([^\]]+)\]\s+/

const BULLET_PREFIX_RE = /^-\s+/

/**
 * Parse a single line. Returns `null` if the line isn't a bullet (blank
 * line, header, indented continuation, etc.). The caller decides what
 * to do with non-bullet lines — typically: preserve verbatim.
 *
 * Lines with a trailing `\n` are accepted; the newline is stripped from
 * `raw`.
 */
export function parseBullet(line: string): Bullet | null {
  const raw = line.replace(/\n$/, "")
  const m = BULLET_PREFIX_RE.exec(raw)
  if (!m) return null

  let rest = raw.slice(m[0].length)

  // Try [#id]
  let id: string | null = null
  const idM = ID_RE.exec(rest)
  if (idM) {
    id = idM[1]
    rest = rest.slice(idM[0].length)
  }

  // Try [<iso-ts>]
  let ts: string | null = null
  const tsM = TS_RE.exec(rest)
  if (tsM) {
    ts = tsM[1]
    rest = rest.slice(tsM[0].length)
  }

  // Try [session:<sid>]
  let sid: string | null = null
  const sidM = SID_RE.exec(rest)
  if (sidM) {
    sid = sidM[1]
    rest = rest.slice(sidM[0].length)
  }

  const body = rest

  // If no [#id] prefix was found, synthesize a legacy id from the
  // full raw line so the model can still address it. We hash the raw
  // line (after stripping the leading "- " bullet prefix and trailing
  // whitespace) so visually-identical bullets in the same file get the
  // same id — but two bullets with different ts/sid metadata still
  // produce different ids, which is what you want for edit/remove.
  if (id === null) {
    return {
      id: legacyIdFor(raw),
      ts,
      sid,
      body,
      isLegacy: true,
      raw,
    }
  }
  return { id, ts, sid, body, isLegacy: false, raw }
}

/**
 * Parse a whole memory file's contents into bullets, in source order.
 *
 * Non-bullet lines are silently skipped. Use {@link parseFileWithLines}
 * if you need to round-trip non-bullet content (the store does).
 */
export function parseFile(content: string): Bullet[] {
  const out: Bullet[] = []
  for (const line of content.split("\n")) {
    const b = parseBullet(line)
    if (b !== null) out.push(b)
  }
  return out
}

/**
 * Variant of {@link parseFile} that returns ALL lines, with each one
 * tagged either as a parsed bullet or as "other" content (blank lines,
 * headers, continuation prose). The store uses this so `edit`/`remove`
 * can rewrite the file losslessly — non-bullet lines round-trip
 * verbatim.
 *
 * The trailing empty string from `split("\n")` on a `\n`-terminated
 * file is preserved as an `other` entry with `raw === ""` so the
 * serializer can re-emit the trailing newline.
 */
export function parseFileWithLines(content: string): FileLine[] {
  const out: FileLine[] = []
  const parts = content.split("\n")
  for (const line of parts) {
    const b = parseBullet(line)
    if (b !== null) out.push({ kind: "bullet", bullet: b, raw: line })
    else out.push({ kind: "other", raw: line })
  }
  return out
}

/** Tagged union for lossless file round-trip. */
export type FileLine =
  | { kind: "bullet"; bullet: Bullet; raw: string }
  | { kind: "other"; raw: string }

/**
 * Serialize `FileLine[]` back to a string. Idempotent with
 * `parseFileWithLines` for any unmodified file: parse → serialize
 * yields the same bytes.
 *
 * To mutate a bullet, replace the `bullet` field on its `FileLine` and
 * update `raw` via `formatBullet(bullet)` — `serializeFile` always
 * writes `raw`, never re-derives it from `bullet`. This means non-edit
 * lines round-trip exactly even if their original formatting differs
 * from what `formatBullet` would produce.
 */
export function serializeFile(lines: FileLine[]): string {
  return lines.map((l) => l.raw).join("\n")
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Render a bullet to its canonical line form (no trailing newline).
 *
 * Optional fields are emitted only when present; multi-line bodies are
 * collapsed to a single line (whitespace runs → single space) so each
 * bullet stays compact and the model is gently nudged toward short,
 * actionable notes.
 */
export function formatBullet(b: BulletInput): string {
  const parts: string[] = ["-"]
  parts.push(`[#${b.id}]`)
  if (b.ts) parts.push(`[${b.ts}]`)
  if (b.sid) parts.push(`[session:${b.sid}]`)
  const body = b.body.replace(/\s+/g, " ").trim()
  parts.push(body)
  return parts.join(" ")
}

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

/**
 * Generate a fresh persistent id of the form `<base36-millis>-<rand4hex>`.
 *
 * Sortable lexicographically because base36 of `Date.now()` preserves
 * the numeric ordering of millisecond timestamps within a fixed digit
 * count (and grows length-monotonically across digit boundaries, which
 * happen on multi-year scales — irrelevant for any realistic memory
 * file lifetime).
 *
 * The 4-hex-char (16-bit) random tail makes intra-millisecond
 * collisions astronomically unlikely (1/65536 per save inside the same
 * ms), and gives the id an opaque feel so the model doesn't try to
 * decompose it.
 */
export function newPersistentId(
  now: () => number = Date.now,
  rand: () => Buffer = () => randomBytes(2),
): string {
  const millis = now().toString(36)
  const tail = rand().toString("hex")
  return `${millis}-${tail}`
}

/**
 * Synthetic id for a legacy (untagged) bullet. Hashes the full raw line
 * so visually-identical bullets in the same file get the same id, but
 * differing-metadata-same-body bullets get distinct ids.
 *
 * Format: `legacy:<sha12>` — 12 hex chars (48 bits) is plenty for the
 * small per-file domain (legacy bullets number in the dozens, not
 * millions).
 */
export function legacyIdFor(rawLine: string): string {
  const h = createHash("sha256").update(rawLine).digest("hex")
  return `legacy:${h.slice(0, 12)}`
}

/**
 * Compute the next short-term integer id given a list of bullets.
 *
 * Returns 1 for an empty list. Ignores legacy and non-integer ids
 * (only `id` strings that match `^\d+$` count). Always returns
 * `max + 1` — never reuses gaps left by deletes, so ids stay stable
 * across the session and the model can rely on referring to id 3 even
 * after id 2 was removed.
 */
export function nextShortTermId(bullets: readonly Bullet[]): number {
  let max = 0
  for (const b of bullets) {
    if (/^\d+$/.test(b.id)) {
      const n = Number.parseInt(b.id, 10)
      if (n > max) max = n
    }
  }
  return max + 1
}

// ---------------------------------------------------------------------------
// Local-time ISO 8601 helper (re-exported here so the store/CLI can use
// it without depending on the inline-tag handler).
// ---------------------------------------------------------------------------

/**
 * Local-time ISO 8601 string with seconds and timezone offset, e.g.
 * `2026-05-05T21:06:20-04:00`.
 *
 * Mirrors the env-info plugin's `date_iso` field so timestamps in
 * saved memories are grep-able against session-start snapshots.
 *
 * `Date.prototype.toISOString()` always emits UTC (`Z`) — we want local
 * time so a memory bullet reads naturally to the user without timezone
 * conversion.
 *
 * (Duplicated from `handlers/memory.ts` for now; the inline-tag handler
 * will be retargeted at this copy in Phase 3 and the original will
 * become a thin re-export.)
 */
export function localIsoSeconds(d: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0")
  const yyyy = d.getFullYear()
  const mm = pad(d.getMonth() + 1)
  const dd = pad(d.getDate())
  const hh = pad(d.getHours())
  const mi = pad(d.getMinutes())
  const ss = pad(d.getSeconds())
  const offMin = -d.getTimezoneOffset()
  const sign = offMin >= 0 ? "+" : "-"
  const absMin = Math.abs(offMin)
  const oh = pad(Math.floor(absMin / 60))
  const om = pad(absMin % 60)
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${oh}:${om}`
}

/**
 * Session title lines in the sidecar `index-meta.jsonl` (title plugin SPEC
 * §3d). A title line has `kind: "title"`, the `sid` of the session, and a
 * `source` (`ai`, `user` or `derived`). The last line wins for each
 * `(sid, source)`, in file order. A sidecar tombstone of the sid removes
 * the earlier title lines of that sid. Readers that do not know this kind
 * skip it (the reader `parseMetaText` keeps only the kinds that it knows).
 */

import { appendFileSync, readFileSync } from "node:fs"

import type {
  SessionTitleRecordView,
  SessionTitleState,
  SessionTitleUsage,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"

import { defaultSessionsDir, indexMetaFilePath, isIndexTombstoneRecord } from "./session-store.ts"

// The title contract types have one source: the plugin-api leaf
// (`plugin-api/types/host-capabilities`). Core uses the same types, so the
// record that core writes and the view that plugins read cannot drift.
export type {
  SessionTitleState,
  TitleSource,
} from "@minimal-agent/core/plugin-api/types/host-capabilities"

/** Token usage and cost of the model call that made an `ai` title. */
export type IndexTitleUsage = SessionTitleUsage

/**
 * A title line in the sidecar `index-meta.jsonl`. The same type as the
 * plugin-api `SessionTitleRecordView`. `v` is {@link INDEX_TITLE_VERSION};
 * a reader ignores a line with a higher version. The title has at most
 * {@link TITLE_MAX_CHARS} chars after {@link sanitizeTitle}; an empty title
 * on a `user` line clears the user title.
 */
export type IndexTitleRecord = SessionTitleRecordView

/** The current {@link IndexTitleRecord.v}. */
export const INDEX_TITLE_VERSION = 1

/** The maximum length of a title, in chars (code points), after sanitize. */
export const TITLE_MAX_CHARS = 80

const TITLE_SOURCES: ReadonlySet<unknown> = new Set(["ai", "user", "derived"])

/** The maximum length of the `model` and `provider` strings of a title line. */
export const TITLE_ID_MAX_CHARS = 128

/** The maximum size of one sidecar line, in UTF-8 bytes (one `O_APPEND` write, SPEC §3d). */
export const INDEX_META_MAX_LINE_BYTES = 4096

/** A finite number at or above zero (`JSON.stringify` writes `null` for NaN/Infinity). */
function isCount(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0
}

/** True when `u` is a usage object with finite, non-negative numbers only. */
export function isIndexTitleUsage(u: unknown): u is IndexTitleUsage {
  if (typeof u !== "object" || u === null) return false
  const r = u as Partial<Record<keyof IndexTitleUsage, unknown>>
  return (
    isCount(r.inputTokens) &&
    isCount(r.outputTokens) &&
    (r.costUsd === undefined || isCount(r.costUsd))
  )
}

function isIdString(s: unknown): boolean {
  return s === undefined || (typeof s === "string" && s.length <= TITLE_ID_MAX_CHARS)
}

/**
 * True when a parsed line is a valid title line of a known version
 * (`v` is an integer from 1 to {@link INDEX_TITLE_VERSION}).
 */
export function isIndexTitleRecord(line: unknown): line is IndexTitleRecord {
  if (typeof line !== "object" || line === null) return false
  const r = line as Partial<Record<keyof IndexTitleRecord, unknown>>
  return (
    r.kind === "title" &&
    typeof r.v === "number" &&
    Number.isInteger(r.v) &&
    r.v >= 1 &&
    r.v <= INDEX_TITLE_VERSION &&
    typeof r.sid === "string" &&
    r.sid.length > 0 &&
    typeof r.title === "string" &&
    Array.from(r.title).length <= TITLE_MAX_CHARS &&
    TITLE_SOURCES.has(r.source) &&
    typeof r.at === "string" &&
    isIdString(r.model) &&
    isIdString(r.provider) &&
    (r.usage === undefined || isIndexTitleUsage(r.usage))
  )
}

// C0 and C1 control chars, DEL, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control chars are the target
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g
// B2: zero-width (U+200B-200D), LRM/RLM (U+200E-200F), bidi embedding and
// override (U+202A-202E), bidi isolate (U+2066-2069) and BOM (U+FEFF). They
// can spoof a `ma sessions` row. They are removed (not a space).
const INVISIBLE_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
const OUTER_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["\u201c", "\u201d"],
  ["\u2018", "\u2019"],
  ["\u00ab", "\u00bb"],
]

/** A harness `<ma::…>` tag (open, close or self-closing); a tag with no `>` runs to the end. */
const MA_TAG = /<\/?ma::[^>]*>?/g

/**
 * Clean a title: `<ma::…>` tags and control chars become a space, runs of
 * whitespace become one space, trim, remove one pair of outer quotes, then
 * cap at {@link TITLE_MAX_CHARS} code points (and trim again). The result
 * can be empty: the caller rejects an empty title.
 */
export function sanitizeTitle(raw: string): string {
  let s = raw
    .replace(INVISIBLE_CHARS, "")
    .replace(MA_TAG, " ")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
  for (const [open, close] of OUTER_QUOTES) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim()
      break
    }
  }
  const chars = Array.from(s)
  if (chars.length > TITLE_MAX_CHARS) s = chars.slice(0, TITLE_MAX_CHARS).join("").trimEnd()
  return s
}

/** A sidecar line: any JSON record with a `kind`. */
export interface IndexMetaLine {
  kind: string
}

/**
 * Append one line to the sidecar `index-meta.jsonl` of `dir`. One
 * `appendFileSync` call with one line: the file is opened with `O_APPEND`,
 * so the line goes to the end as one write (the same as
 * `appendIndexSummary`). Keep lines small (below 4 KiB). Best-effort:
 * returns `false` on an error, never throws.
 *
 * @param line - A JSON-serializable record with a `kind` (for example an
 *   {@link IndexTitleRecord}).
 * @param dir - The sessions dir. Default: `defaultSessionsDir()`.
 */
export function appendIndexMeta(line: IndexMetaLine, dir: string = defaultSessionsDir()): boolean {
  try {
    appendFileSync(indexMetaFilePath(dir), `${JSON.stringify(line)}\n`)
    return true
  } catch {
    return false
  }
}

/**
 * The merged title state of `sid` from the sidecar text: the last valid
 * title line of each source, after the last sidecar tombstone of the sid.
 * A `user` line with an empty title means "no user title": `user` is then
 * absent.
 */
export function parseTitleState(sid: string, metaText: string): SessionTitleState {
  let state: SessionTitleState = {}
  for (const raw of metaText.split("\n")) {
    if (raw.length === 0) continue
    let rec: unknown
    try {
      rec = JSON.parse(raw)
    } catch {
      continue
    }
    if (isIndexTombstoneRecord(rec)) {
      if (rec.sid === sid) state = {}
    } else if (isIndexTitleRecord(rec) && rec.sid === sid) {
      state[rec.source] = rec
    }
  }
  if (state.user !== undefined && state.user.title.length === 0) delete state.user
  return state
}

/**
 * Read the merged title state of `sid` from `index-meta.jsonl` of `dir`
 * (see {@link parseTitleState}). A missing or unreadable file gives `{}`.
 */
export function readTitleState(sid: string, dir: string = defaultSessionsDir()): SessionTitleState {
  let text: string
  try {
    text = readFileSync(indexMetaFilePath(dir), "utf-8")
  } catch {
    return {}
  }
  return parseTitleState(sid, text)
}

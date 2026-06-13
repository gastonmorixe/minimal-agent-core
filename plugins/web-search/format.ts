/**
 * Render a `SearchResponse` into the two surfaces the handler returns:
 *
 *   - `text`  — compact list, suitable for the model (returned in `content`).
 *   - `ansi`  — same list with terminal color, shown in the transcript via
 *               `display`. Skipped when `ansi: false`.
 *   - `json`  — structured shape for the model when it asked for `format=json`,
 *               and for the CLI's `-f json` mode.
 *
 * Formatting choices:
 *   - Title trimmed to ~120 chars (most are shorter; rare overflow looks bad).
 *   - Snippet trimmed to ~240 chars on one logical line.
 *   - URL never trimmed (the model needs the canonical link).
 *   - Source defaults to URL hostname when the provider didn't supply one.
 *
 * Uses only the leaf plugin-api ANSI constants, so formatter stays usable from
 * the CLI and from any future provider-only test harness without host imports.
 *
 * @module web-search/format
 */

import { ANSI_CODES } from "@minimal-agent/plugin-api/utils/ansi"
import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"

import type { SearchHit, SearchResponse } from "./providers/types.ts"

const TITLE_MAX = 120
const SNIPPET_MAX = 240

const { BOLD, DIM, ITALIC, RESET, UNDERLINE } = ANSI_CODES
const FG_CYAN = PALETTE.cyan
const FG_GREY = "\x1b[90m"

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1).trimEnd()}…`
}

/** Single-line, no embedded newlines — keep snippets terminal-friendly. */
function flatten(s: string): string {
  return s.replace(/\s+/g, " ").trim()
}

/** Source: provider-supplied or URL hostname fallback. */
function deriveSource(hit: SearchHit): string {
  if (hit.source) return hit.source
  try {
    return new URL(hit.url).hostname
  } catch {
    return ""
  }
}

/**
 * Compact text format — one block per hit, two-or-three lines each.
 *
 *   [1] Title — source · age
 *       https://url
 *       Snippet trimmed to ~240 chars…
 */
export function formatText(response: SearchResponse, opts: { ansi?: boolean } = {}): string {
  const ansi = opts.ansi ?? false
  const b = (s: string) => (ansi ? `${BOLD}${s}${RESET}` : s)
  const dim = (s: string) => (ansi ? `${DIM}${s}${RESET}` : s)
  const grey = (s: string) => (ansi ? `${FG_GREY}${s}${RESET}` : s)
  const cyan = (s: string) => (ansi ? `${FG_CYAN}${s}${RESET}` : s)
  const url = (s: string) => (ansi ? `${DIM}${UNDERLINE}${s}${RESET}` : s)
  const it = (s: string) => (ansi ? `${ITALIC}${s}${RESET}` : s)

  const header = `${b("WebSearch")}${grey(`[${response.provider}/${response.type}]`)} ${it(`"${response.query}"`)} — ${response.hits.length} result${response.hits.length === 1 ? "" : "s"}`
  if (response.hits.length === 0) {
    return `${header}\n\n${dim("(no results)")}\n`
  }

  const blocks: string[] = []
  for (let i = 0; i < response.hits.length; i++) {
    const h = response.hits[i]
    const num = grey(`[${i + 1}]`)
    const title = b(clip(flatten(h.title), TITLE_MAX))
    const source = deriveSource(h)
    const meta: string[] = []
    if (source) meta.push(cyan(source))
    if (h.age) meta.push(grey(h.age))
    const metaLine = meta.length ? ` — ${meta.join(grey(" · "))}` : ""
    const lines = [`${num} ${title}${metaLine}`, `    ${url(h.url)}`]
    if (h.snippet) {
      lines.push(`    ${clip(flatten(h.snippet), SNIPPET_MAX)}`)
    }
    blocks.push(lines.join("\n"))
  }
  return `${header}\n\n${blocks.join("\n\n")}\n`
}

/** Structured shape returned to the model when `format=json`. */
export interface JsonShape {
  query: string
  provider: string
  type: string
  hits: Array<{
    title: string
    url: string
    snippet?: string
    age?: string
    source?: string
  }>
}

/** Shape a search response as the structured JSON variant of the tool output. */
export function formatJson(response: SearchResponse): JsonShape {
  return {
    query: response.query,
    provider: response.provider,
    type: response.type,
    hits: response.hits.map((h) => ({
      title: h.title,
      url: h.url,
      ...(h.snippet ? { snippet: clip(flatten(h.snippet), SNIPPET_MAX) } : {}),
      ...(h.age ? { age: h.age } : {}),
      ...(h.source || deriveSource(h) ? { source: h.source ?? deriveSource(h) } : {}),
    })),
  }
}

/** Pretty-printed JSON string suitable for the CLI's `-f json` mode. */
export function formatJsonString(response: SearchResponse): string {
  return `${JSON.stringify(formatJson(response), null, 2)}\n`
}

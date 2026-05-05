/**
 * Tool-call handler for `WebSearch`.
 *
 * Pipeline:
 *   1. Validate tool input (query non-empty, types correct, enum values valid).
 *   2. Load config (`~/.minimal-agent/config.jsonc`, `plugins["web-search"]`).
 *   3. Merge per-call args over `defaults`.
 *   4. Build provider chain, run it.
 *   5. Format the response per `format` (`text` default | `json`).
 *   6. Return `{ content, display, is_error? }`.
 *
 * `display` (transcript) is always the ANSI text rendering — even when the
 * model asked for `json` — so the user sees a pretty list regardless of how
 * the model wants to consume the data.
 *
 * `content` (sent back to the model) is the format the model requested.
 *
 * Errors:
 *   - Input validation failure → `is_error: true` with a human-readable msg.
 *   - All providers failed → `is_error: true`, listing each failure plus
 *     a hint about `BRAVE_API_KEY` when the only failure was "not configured".
 *
 * @module web-search/handlers/web_search
 */

import type { TUIContext, TUIResult } from "../../../src/plugins/types.ts"
import { loadWebSearchConfig, type WebSearchConfig } from "../config.ts"
import { formatJsonString, formatText } from "../format.ts"
import { buildChain, runChain, WebSearchAllFailedError } from "../providers/registry.ts"
import type { SearchOptions, SearchType } from "../providers/types.ts"

const VALID_TYPES = new Set<SearchType>(["web", "news"])
const VALID_SAFESEARCH = new Set(["off", "moderate", "strict"])
const VALID_FORMATS = new Set(["text", "json"])

interface ParsedInput {
  query: string
  type: SearchType
  count?: number
  offset?: number
  freshness?: string
  country?: string
  lang?: string
  safesearch?: "off" | "moderate" | "strict"
  format: "text" | "json"
}

/** Validate tool input. Returns either parsed values or an error message. */
function validateInput(raw: Record<string, unknown>): { ok: true; value: ParsedInput } | { ok: false; error: string } {
  if (typeof raw.query !== "string" || raw.query.trim().length === 0) {
    return { ok: false, error: "`query` is required and must be a non-empty string" }
  }
  const query = raw.query.trim()
  if (query.length > 400) {
    return { ok: false, error: "`query` exceeds 400 characters" }
  }

  let type: SearchType = "web"
  if (raw.type !== undefined) {
    if (typeof raw.type !== "string" || !VALID_TYPES.has(raw.type as SearchType)) {
      return { ok: false, error: `\`type\` must be one of: ${[...VALID_TYPES].join(", ")}` }
    }
    type = raw.type as SearchType
  }

  let count: number | undefined
  if (raw.count !== undefined) {
    if (typeof raw.count !== "number" || !Number.isFinite(raw.count) || raw.count < 1 || raw.count > 20) {
      return { ok: false, error: "`count` must be an integer between 1 and 20" }
    }
    count = Math.floor(raw.count)
  }

  let offset: number | undefined
  if (raw.offset !== undefined) {
    if (typeof raw.offset !== "number" || !Number.isFinite(raw.offset) || raw.offset < 0) {
      return { ok: false, error: "`offset` must be a non-negative integer" }
    }
    offset = Math.floor(raw.offset)
  }

  for (const k of ["freshness", "country", "lang"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") {
      return { ok: false, error: `\`${k}\` must be a string` }
    }
  }

  let safesearch: ParsedInput["safesearch"]
  if (raw.safesearch !== undefined) {
    if (typeof raw.safesearch !== "string" || !VALID_SAFESEARCH.has(raw.safesearch)) {
      return { ok: false, error: `\`safesearch\` must be one of: ${[...VALID_SAFESEARCH].join(", ")}` }
    }
    safesearch = raw.safesearch as ParsedInput["safesearch"]
  }

  let format: "text" | "json" = "text"
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string" || !VALID_FORMATS.has(raw.format)) {
      return { ok: false, error: `\`format\` must be one of: ${[...VALID_FORMATS].join(", ")}` }
    }
    format = raw.format as "text" | "json"
  }

  return {
    ok: true,
    value: {
      query,
      type,
      count,
      offset,
      freshness: raw.freshness as string | undefined,
      country: raw.country as string | undefined,
      lang: raw.lang as string | undefined,
      safesearch,
      format,
    },
  }
}

/** Merge config defaults with parsed input → final SearchOptions. */
function mergeOptions(input: ParsedInput, config: WebSearchConfig): SearchOptions {
  const d = config.defaults
  return {
    type: input.type ?? d.type ?? "web",
    count: input.count ?? d.count ?? 10,
    offset: input.offset ?? d.offset,
    freshness: input.freshness ?? d.freshness,
    country: input.country ?? d.country,
    lang: input.lang ?? d.lang,
    safesearch: input.safesearch ?? d.safesearch,
  }
}

/** Render an actionable error from `WebSearchAllFailedError`. */
function renderAllFailed(err: WebSearchAllFailedError): string {
  if (err.failures.length === 0) {
    return "WebSearch: no providers configured. Set `plugins[\"web-search\"].providers` in ~/.minimal-agent/config.jsonc."
  }
  const lines = ["WebSearch: all providers failed:"]
  let onlyMissingKey = true
  for (const f of err.failures) {
    lines.push(`  - ${f.providerId}: ${f.message}`)
    if (f.kind !== "not_configured") onlyMissingKey = false
  }
  if (onlyMissingKey) {
    lines.push("")
    lines.push("Hint: set BRAVE_API_KEY in your environment, or add an `apiKey` to")
    lines.push("plugins[\"web-search\"].brave in ~/.minimal-agent/config.jsonc.")
  }
  return lines.join("\n")
}

/** Default export: the tool handler invoked by the plugin loader. */
export default async function webSearchHandler(ctx: TUIContext): Promise<TUIResult> {
  if (ctx.trigger.type !== "tool") {
    return { kind: "tool_result", content: "WebSearch: wrong trigger type", is_error: true }
  }

  const v = validateInput(ctx.trigger.input)
  if (!v.ok) {
    return { kind: "tool_result", content: `WebSearch: ${v.error}`, is_error: true }
  }

  const config = loadWebSearchConfig()
  const opts = mergeOptions(v.value, config)
  const logger = (msg: string) => ctx.stderr.write(`[web-search] ${msg}\n`)
  const chain = buildChain(config, undefined, logger)

  try {
    if (chain.length === 0) throw new WebSearchAllFailedError([])
    const resolved = await runChain(v.value.query, opts, chain, ctx.abort, ctx.env, logger)

    const display = formatText(resolved, { ansi: true })
    const content =
      v.value.format === "json" ? formatJsonString(resolved) : formatText(resolved, { ansi: false })
    return { kind: "tool_result", content, display }
  } catch (err) {
    if (err instanceof WebSearchAllFailedError) {
      return { kind: "tool_result", content: renderAllFailed(err), is_error: true }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: "tool_result", content: `WebSearch: unexpected error: ${msg}`, is_error: true }
  }
}

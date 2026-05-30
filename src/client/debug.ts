/**
 * Debug / pretty-printer + rate-limit header parsing + streaming
 * status helpers used internally by the client. Everything in this
 * module is side-effecty stderr output or stateless formatting; no
 * value is publicly re-exported from `client.ts`.
 *
 * Split out of `src/client.ts` to keep that file under the
 * `max-lines` lint budget.
 *
 * @module client/debug
 */

import { redactHeaders } from "../net-dbg.ts"
import { clampWithHint } from "../truncate-hint.ts"

import type { ContentBlock, Message } from "./types.ts"

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  brightGreen: (s: string) => `\x1b[92m${s}\x1b[39m`,
}

// ---------------------------------------------------------------------------
// Debug logging : pretty-printed to stderr
// ---------------------------------------------------------------------------

/**
 * Check debug mode at call time (not import time) so that --debug flag
 * in index.ts can set process.env.DEBUG before the first request.
 */
export function isDebug(): boolean {
  return !!process.env.DEBUG
}

/**
 * When verbose is enabled (--verbose flag or VERBOSE=1), debug output is not
 * truncated: full system blocks, full message previews, untrimmed tokens.
 */
export function isVerbose(): boolean {
  return !!process.env.VERBOSE
}

/**
 * When --show-hidden-chars (or MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1) is on,
 * debug output reveals invisible characters as faint glyphs : same idea
 * as the input editor's show-hidden mode (see editor-renderer.ts).
 *
 * Without this, multi-line tool descriptions (e.g. "Bash: ...\n\nThe working
 * directory...") wrap onto real lines in the debug log and visually break
 * the structured key/value layout.
 */
export function isShowHiddenChars(): boolean {
  return process.env.MINIMAL_AGENT_SHOW_HIDDEN_CHARS === "1"
}

/**
 * Replace invisible characters with faint visual indicator glyphs:
 *   space → ·, tab → →, LF → ↵, CR → ␍.
 * No-op unless `--show-hidden-chars` is active.
 *
 * Kept independent of editor-renderer.ts's `markHidden` because here we
 * also want to fold newlines (which the editor handles structurally) so
 * the debug log keeps each value on a single line.
 */
export function revealHidden(s: string): string {
  if (!isShowHiddenChars()) return s
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === " ")
      out += "\x1b[2m\u00b7\x1b[22m" // ·
    else if (ch === "\t")
      out += "\x1b[2m\u2192\x1b[22m" // →
    else if (ch === "\n")
      out += "\x1b[2m\u21b5\x1b[22m" // ↵
    else if (ch === "\r")
      out += "\x1b[2m\u240d\x1b[22m" // ␍
    else out += ch
  }
  return out
}

/**
 * Truncate `s` to `max` chars unless verbose mode is on, then optionally
 * reveal hidden characters. Truncation operates on the raw string so the
 * `(+Nch)` count reflects source characters, not glyph-substituted output.
 */
export function truncate(s: string, max: number): string {
  // Verbose mode disables the cap; otherwise delegate to the shared
  // `clampWithHint` so debug dumps speak the same `...(+Nch)` dialect as
  // tool transcript previews (see src/truncate-hint.ts).
  const body = isVerbose() ? s : clampWithHint(s, max, "ch")
  return revealHidden(body)
}

/**
 * Render a single ContentBlock as a short structural token for debug output.
 *
 * One token per block; no color, no truncation : the caller composes them
 * and applies {@link truncate} to the joined result. The discriminator
 * (`b.type`) is the wire-protocol literal from {@link ContentBlock}, so the
 * exhaustiveness `never` check below will fail at compile time the moment
 * Anthropic adds a new block variant : pointing right at this switch.
 *
 * Newline-bearing payloads (text, tool_result strings) are JSON-stringified
 * so embedded `\n` becomes the escape `\n`, keeping each block on one line
 * in the debug log.
 */
export function previewBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return JSON.stringify(b.text)
    case "thinking":
      return `thinking(${b.thinking.length}ch)`
    case "tool_use": {
      const keys = Object.keys(b.input ?? {}).join(",")
      return `tool_use(${b.name}#${shortId(b.id)})${keys ? `{${keys}}` : ""}`
    }
    case "tool_result": {
      const inner =
        typeof b.content === "string"
          ? JSON.stringify(b.content)
          : b.content.map(previewBlock).join(" + ")
      const err = b.is_error ? "!" : ""
      return `tool_result${err}(${shortId(b.tool_use_id)}) ${inner}`
    }
    case "image": {
      // Never log the base64 payload : just the source kind + a short descriptor.
      const s = b.source
      const detail = s.type === "base64" ? s.media_type : s.type === "url" ? s.url : s.file_id
      return `image(${s.type} ${detail})`
    }
    case "document": {
      const s = b.source
      const detail =
        s.type === "base64"
          ? s.media_type
          : s.type === "url"
            ? s.url
            : s.type === "file"
              ? s.file_id
              : "text/plain"
      return `document(${s.type} ${detail})`
    }
    default: {
      // Compile-time exhaustiveness. If ContentBlock gains a member, tsc
      // errors here ("Type 'XBlock' is not assignable to type 'never'").
      // Runtime fallback below keeps the agent alive on unknown shapes.
      const _exhaustive: never = b
      void _exhaustive
      return `unknown(${(b as { type?: string } | null)?.type ?? "?"})`
    }
  }
}

/** Last 6 chars of a `toolu_...` id : enough to pair use↔result within a dump. */
export function shortId(id: string): string {
  return id.slice(-6)
}

/**
 * Summarize a `Message.content` (string or block array) for non-verbose
 * debug. Caps at `max` chars with the same `...(+Nch)` convention as
 * {@link truncate}.
 */
export function previewContent(content: string | ContentBlock[], max = 80): string {
  if (typeof content === "string") return truncate(content, max)
  return truncate(content.map(previewBlock).join("  ⟶  "), max)
}

export function debugHeader(label: string): void {
  if (!isDebug()) return
  console.error(`\n${c.bold(c.cyan(`--- ${label} ---`))}`)
}

export function debugKV(key: string, value: string): void {
  if (!isDebug()) return
  console.error(`  ${c.dim(key + ":")} ${value}`)
}

/** Print request headers sorted alphabetically, with auth tokens redacted. */
export function debugHeaders(headers: Record<string, string>): void {
  if (!isDebug()) return
  console.error(`  ${c.bold("Headers:")}`)
  const safeHeaders = redactHeaders(headers)
  const sorted = Object.entries(safeHeaders).sort(([a], [b]) => a.localeCompare(b))
  for (const [k, v] of sorted) {
    console.error(`    ${c.yellow(k)}: ${revealHidden(v)}`)
  }
}

/**
 * Pretty-print the request body, with special handling for:
 *   - messages: show count + role/content preview per message
 *   - system: label blocks as "billing" or "identity" based on content
 *   - metadata.user_id: parse the JSON string and show fields individually
 */
export function debugBody(body: Record<string, unknown>): void {
  if (!isDebug()) return
  console.error(`  ${c.bold("Body:")}`)
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[]
      console.error(`    ${c.yellow("messages")}: ${c.dim(`[${msgs.length} message(s)]`)}`)
      for (const msg of msgs) {
        const isCached = (() => {
          if (typeof msg.content === "string") return false
          const last = msg.content[msg.content.length - 1] as
            | { cache_control?: unknown }
            | undefined
          return Boolean(last?.cache_control)
        })()
        // Bright bold green annotation marks where the cache_control
        // breakpoint sits in this request. Everything before it (system,
        // tools, prior messages) is what the API actually serves from cache;
        // see docs/caching.md for the prefix-checkpoint mental model.
        const cc = isCached ? ` ${c.bold(c.brightGreen("[← cached prefix ends here]"))}` : ""
        const preview = previewContent(msg.content, 80)
        console.error(`      ${c.green(msg.role)}${cc}: ${c.dim(preview)}`)
      }
    } else if (k === "system") {
      const sys = v as Array<{
        type: string
        text: string
        cache_control?: unknown
      }>
      console.error(`    ${c.yellow("system")}: ${c.dim(`[${sys.length} block(s)]`)}`)
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        // Label blocks by their role (see SYSTEM_PROMPT docs in headers.ts)
        const label = block.text.startsWith("x-anthropic-billing-header")
          ? "billing"
          : block.text.startsWith("You are Claude")
            ? "identity"
            : `block ${i}`
        const cc = block.cache_control ? ` ${c.bold(c.brightGreen("[cached]"))}` : ""
        const preview = truncate(block.text, 80)
        console.error(`      ${c.magenta(label)}${cc}: ${c.dim(preview)}`)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      console.error(`    ${c.yellow("tools")}: ${c.dim(`[${tools.length} tool(s)]`)}`)
      for (const tool of tools) {
        const desc = truncate(tool.description ?? "", 80)
        console.error(`      ${c.magenta(tool.name)}: ${c.dim(desc)}`)
      }
    } else if (k === "metadata") {
      const meta = v as { user_id: string }
      console.error(`    ${c.yellow("metadata.user_id")}:`)
      try {
        const parsed = JSON.parse(meta.user_id)
        for (const [mk, mv] of Object.entries(parsed)) {
          console.error(`      ${c.magenta(mk)}: ${revealHidden(String(mv))}`)
        }
      } catch {
        console.error(`      ${revealHidden(meta.user_id)}`)
      }
    } else {
      console.error(`    ${c.yellow(k)}: ${revealHidden(JSON.stringify(v))}`)
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * Convert a raw ratelimit header value to a human-readable annotation.
 *
 * The Anthropic API returns unified rate limit headers with this naming pattern:
 *   anthropic-ratelimit-unified[-<window>]-<field>
 *
 * Windows: "5h" (5-hour rolling), "7d" (7-day rolling), or none (aggregate).
 * Fields: reset (unix timestamp), utilization (0.0-1.0), status (allowed/rejected),
 *   fallback-percentage, overage-status, overage-disabled-reason,
 *   representative-claim (which window is billing-relevant).
 */
export function humanizeRatelimitValue(key: string, value: string): string {
  if (key.endsWith("-reset")) {
    const resetAt = Number(value) * 1000 // API sends seconds, we need ms
    const now = Date.now()
    const diffMs = resetAt - now
    if (diffMs <= 0) return "now"
    const mins = Math.floor(diffMs / 60_000)
    const hrs = Math.floor(mins / 60)
    if (hrs > 0) return `in ${hrs}h ${mins % 60}m`
    return `in ${mins}m`
  }
  if (key.endsWith("-utilization")) {
    return `${(Number(value) * 100).toFixed(1)}%`
  }
  if (key.endsWith("-fallback-percentage")) {
    return `${(Number(value) * 100).toFixed(0)}%`
  }
  if (key.endsWith("-status")) {
    if (value === "allowed") return c.green("allowed")
    if (value === "rejected") return c.red("rejected")
    return value
  }
  if (key.endsWith("-disabled-reason")) {
    // These reasons come from `P04()` (L468510-468524) which checks
    // cachedExtraUsageDisabledReason.
    const map: Record<string, string> = {
      out_of_credits: "no credits remaining",
      overage_not_provisioned: "overage not set up",
      org_level_disabled: "disabled by org admin",
    }
    return map[value] ?? value
  }
  return ""
}

/**
 * Print a summary of rate limit status after the per-header listing.
 * Extracts the 5h and 7d windows and shows utilization, status, and reset time.
 */
export function formatRatelimitSummary(rl: Map<string, string>): void {
  const windows = new Map<string, { util?: number; status?: string; reset?: number }>()
  for (const [k, v] of rl) {
    const match = k.match(/^anthropic-ratelimit-unified-([\w]+)-(\w+)$/)
    if (!match) continue
    const window = match[1]
    const field = match[2]
    if (!windows.has(window)) windows.set(window, {})
    const w = windows.get(window)!
    if (field === "utilization") w.util = Number(v)
    if (field === "status") w.status = v
    if (field === "reset") w.reset = Number(v) * 1000
  }

  const ovStatus = rl.get("anthropic-ratelimit-unified-overage-status")
  const ovReason = rl.get("anthropic-ratelimit-unified-overage-disabled-reason")
  const rep = rl.get("anthropic-ratelimit-unified-representative-claim")

  console.error(`\n  ${c.bold("Rate limit summary:")}`)
  for (const [window, info] of [...windows.entries()].sort()) {
    // Skip non-window entries (overage, fallback, representative-claim are handled separately)
    if (window === "overage" || window === "fallback" || window === "representative") continue
    if (!info.util && !info.status && !info.reset) continue
    const label =
      window === "5h"
        ? "5-hour"
        : window === "7d"
          ? "7-day"
          : window.startsWith("7d_")
            ? `7-day (${window.slice(3)})`
            : window
    const pct = info.util != null ? `${(info.util * 100).toFixed(1)}% used` : "?"
    const statusColor = info.status === "allowed" ? c.green(info.status) : c.red(info.status!)
    let resetStr = ""
    if (info.reset) {
      const diffMs = info.reset - Date.now()
      if (diffMs > 0) {
        const hrs = Math.floor(diffMs / 3_600_000)
        const mins = Math.floor((diffMs % 3_600_000) / 60_000)
        resetStr = `, resets in ${hrs}h ${mins}m`
      }
    }
    console.error(`    ${c.cyan(label)}: ${pct} : ${statusColor}${resetStr}`)
  }
  if (ovStatus) {
    const ovColor = ovStatus === "allowed" ? c.green("enabled") : c.red("disabled")
    const reason = ovReason
      ? ` (${humanizeRatelimitValue("x-disabled-reason", ovReason) || ovReason})`
      : ""
    console.error(`    ${c.cyan("overage")}: ${ovColor}${reason}`)
  }
  if (rep) {
    console.error(`    ${c.cyan("billing window")}: ${rep.replace("_", " ")}`)
  }
}

/**
 * Pretty-print all response headers, with human annotations for ratelimit
 * headers and a summary block at the end.
 */
export function debugResponse(status: number, headers: Headers): void {
  if (!isDebug()) return
  debugHeader(`Response ${status >= 400 ? c.red(String(status)) : c.green(String(status))}`)
  const entries: [string, string][] = []
  const ratelimitEntries = new Map<string, string>()
  headers.forEach((v, k) => entries.push([k, v]))
  entries.sort(([a], [b]) => a.localeCompare(b))

  for (const [k, v] of entries) {
    const human = k.startsWith("anthropic-ratelimit-") ? humanizeRatelimitValue(k, v) : ""
    const annotation = human ? ` ${c.dim(`(${human})`)}` : ""
    console.error(`    ${c.yellow(k)}: ${v}${annotation}`)
    if (k.startsWith("anthropic-ratelimit-")) {
      ratelimitEntries.set(k, v)
    }
  }

  if (ratelimitEntries.size > 0) {
    formatRatelimitSummary(ratelimitEntries)
  }
}

// ---------------------------------------------------------------------------
// Streaming status helpers
// ---------------------------------------------------------------------------

/**
 * Format a byte count as a short human-readable string for status labels.
 * Examples: 0 → "0 B", 512 → "512 B", 2048 → "2.0 KB", 1572864 → "1.5 MB".
 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Best-effort extraction of a one-line hint from a (possibly partial) tool_use
 * input JSON string while it is still streaming. Tries fast regex extraction
 * first (works on partial JSON), then falls back to JSON.parse.
 *
 * Per-tool prioritization mirrors the most useful "what is it actually doing"
 * field: file_path for Read/Write/Edit, command for Bash, pattern for Grep,
 * url for WebFetch, query for the search tools, etc. Falls back to the first
 * string-valued top-level key when no known field is found.
 *
 * @returns A short hint string (≤80 chars, no newlines) or "" if nothing
 *   could be extracted yet.
 */
export function extractToolHint(toolName: string, partialJson: string): string {
  if (partialJson.length === 0) return ""

  const fieldsByTool: Record<string, string[]> = {
    Bash: ["command"],
    Read: ["file_path", "path"],
    Write: ["file_path", "path"],
    Edit: ["file_path", "path"],
    MultiEdit: ["file_path", "path"],
    Grep: ["pattern", "path"],
    Glob: ["pattern", "path"],
    WebFetch: ["url"],
    WebSearch: ["query"],
    show_diff: ["title"],
  }
  const candidates = fieldsByTool[toolName] ?? [
    "file_path",
    "path",
    "command",
    "pattern",
    "url",
    "query",
    "title",
    "name",
  ]

  // Regex pass: tolerates unterminated strings and incomplete JSON.
  // Captures the contents of the first matching `"<key>"\s*:\s*"..."` pair.
  for (const key of candidates) {
    const re = new RegExp(String.raw`"${key}"\s*:\s*"((?:\\.|[^"\\])*)`, "")
    const m = re.exec(partialJson)
    if (m && m[1]) return shortenHint(unescapeJsonish(m[1]))
  }

  // Fallback: try a full JSON parse and surface the first string field.
  try {
    const obj = JSON.parse(partialJson) as Record<string, unknown>
    for (const key of candidates) {
      const v = obj[key]
      if (typeof v === "string" && v.length > 0) return shortenHint(v)
    }
    for (const v of Object.values(obj)) {
      if (typeof v === "string" && v.length > 0) return shortenHint(v)
    }
  } catch {
    // partial : nothing more to do
  }
  return ""
}

export function unescapeJsonish(s: string): string {
  // Cheap unescape sufficient for hint display (not a full JSON string parser).
  return s
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\r/g, "")
    .replace(/"/g, '"')
    .replace(/\\\\/g, "\\")
}

export function shortenHint(s: string): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= 80) return oneLine
  return `${oneLine.slice(0, 77)}…`
}

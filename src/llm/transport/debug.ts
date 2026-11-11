/**
 * Transport `--debug` request dump.
 *
 * Provider-neutral: a structured view of a `SendOptions` request (model /
 * stream / max_tokens / request_type plus a messages/system/tools preview),
 * emitted as Debug-severity diagnostics when debug mode is on. Derived purely
 * from the agent's `SendOptions`; the adapter builds the real wire body
 * downstream, but the debug view is the same regardless of provider.
 *
 * @module llm/transport/debug
 */

import { type Diagnostics, processDiagnostics } from "../../diagnostics/hub.ts"
import { clampWithHint } from "../../utils/truncate-hint.ts"
import type { ContentBlock, Message } from "../messages.ts"

import type { SendOptions } from "./types.ts"

/**
 * Check debug mode at call time (not import time) so the `--debug` flag can
 * set `process.env.DEBUG` before the first request.
 */
export function isDebug(): boolean {
  return !!process.env.DEBUG
}

/**
 * When verbose is enabled (`--verbose` / `VERBOSE=1`), debug output is not
 * truncated: full system blocks, full message previews, untrimmed tokens.
 */
export function isVerbose(): boolean {
  return !!process.env.VERBOSE
}

/**
 * Truncate `s` to `max` chars.
 *
 * `max` is authoritative. The verbose check lives in the CALLER (see
 * `requestDumpLines`), which raises the cap; re-checking `isVerbose()` here
 * made an explicit `Number.MAX_SAFE_INTEGER` cap look like a no-op under
 * `VERBOSE=1` and silently ignored the argument.
 */
function truncate(s: string, max: number): string {
  return clampWithHint(s, max, "ch")
}

/** Last 6 chars of a tool id: enough to pair use↔result within a dump. */
function shortId(id: string): string {
  return id.slice(-6)
}

/**
 * Render a single content block as a short structural token for debug
 * output. One token per block; no color, no truncation (the caller composes
 * them and truncates the joined result).
 */
function previewBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
      return JSON.stringify(b.text)
    case "thinking":
      return `thinking(${b.thinking.length}ch)`
    case "redacted_thinking":
      return `redacted_thinking(${b.data.length}ch)`
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
      void (b satisfies never)
      return `unknown(${(b as { type?: string } | null)?.type ?? "?"})`
    }
  }
}

/** Summarize a message's content (string or block array) for debug. */
function previewContent(content: string | ContentBlock[], max = 80): string {
  if (typeof content === "string") return truncate(content, max)
  return truncate(content.map(previewBlock).join("  ⟶  "), max)
}

/**
 * Collapse one preview to a SINGLE line.
 *
 * A dump row must never contain a newline: the rows are emitted one per
 * diagnostic, and a diagnostic is one RFC 5424 log line. A prompt block with
 * embedded newlines used to smuggle raw `\n` into both, which (a) broke the
 * file log's line format and (b) made the host's line-anchored `^ {6}` row
 * regexes skip the row entirely, so a `system: [4 block(s)]` header printed
 * only `block 0` while the other three silently vanished.
 */
function oneLine(s: string, max: number): string {
  const collapsed = s.replace(/\s*\n\s*/g, " ⏎ ").replace(/[ \t]+/g, " ")
  return truncate(collapsed.trim(), max)
}

/**
 * The body preview lines: a per-message role/content preview, the system
 * blocks, and the tool list. Marks where the cache breakpoint sits.
 *
 * Rows longer than the preview cap produce a second, indented row holding the
 * FULL text under the same label. The cap is configurable so `--verbose` can
 * disable it; without the continuation row, raising the cap would only ever
 * elide at a different width.
 */
function bodyLines(body: Record<string, unknown>, verbose: boolean): string[] {
  const cap = (): number => (verbose ? Number.MAX_SAFE_INTEGER : 80)
  /** Push `label + preview`, plus the full text when the preview was cut. */
  const pushRow = (label: string, text: string): void => {
    const preview = oneLine(text, cap())
    out.push(`      ${label}: ${preview}`)
    const full = oneLine(text, Number.MAX_SAFE_INTEGER)
    if (full !== preview) out.push(`        ${full}`)
  }
  const out = ["  Body:"]
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[]
      out.push(`    messages: [${msgs.length} message(s)]`)
      for (const msg of msgs) {
        const cached =
          typeof msg.content !== "string" &&
          Boolean(
            (msg.content[msg.content.length - 1] as { cache_control?: unknown })?.cache_control,
          )
        const cc = cached ? " [← cached prefix ends here]" : ""
        // `oneLine`, not `truncate`: a multi-line user message would otherwise
        // put raw newlines in the row and be dropped by the host's parser.
        const preview = oneLine(previewContent(msg.content, Number.MAX_SAFE_INTEGER), cap())
        out.push(`      ${msg.role}${cc}: ${preview}`)
        const full = oneLine(
          previewContent(msg.content, Number.MAX_SAFE_INTEGER),
          Number.MAX_SAFE_INTEGER,
        )
        if (full !== preview) out.push(`        ${full}`)
      }
    } else if (k === "system") {
      const sys = v as Array<{ type: string; text: string; cache_control?: unknown }>
      out.push(`    system: [${sys.length} block(s)]`)
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        const cc = block.cache_control ? " [cached]" : ""
        pushRow(`block ${i}${cc}`, block.text)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      out.push(`    tools: [${tools.length} tool(s)]`)
      for (const tool of tools) pushRow(tool.name, tool.description ?? "")
    } else {
      out.push(`    ${k}: ${oneLine(JSON.stringify(v), Number.MAX_SAFE_INTEGER)}`)
    }
  }
  return out
}

/**
 * The plain-text `--debug` dump of one request: the model / stream /
 * max_tokens / request_type header lines plus the body preview. Never
 * includes `auth` (the credential).
 *
 * Every returned entry is a single line — no embedded newlines — so one dump
 * row maps to one diagnostic row, readable in the TUI and valid in the file
 * log. Pass `verbose` to keep previews untruncated.
 */
export function requestDumpLines(opts: SendOptions, verbose = isVerbose()): string[] {
  const out = [`--- POST ${opts.model ?? "(default model)"} ---`]
  const kv = (key: string, value: string): void => {
    out.push(`  ${key}: ${oneLine(value, Number.MAX_SAFE_INTEGER)}`)
  }
  if (opts.model) kv("model", opts.model)
  kv("stream", String(opts.stream ?? true))
  if (opts.maxTokens != null) kv("max_tokens", String(opts.maxTokens))
  kv("request_type", opts.requestType ?? "conversation")
  if (opts.thinking) kv("thinking", JSON.stringify(opts.thinking))
  if (opts.outputConfig) kv("output_config", JSON.stringify(opts.outputConfig))
  if (opts.speed && opts.speed !== "normal") kv("speed", opts.speed)
  const body: Record<string, unknown> = { messages: opts.messages }
  if (opts.system) body.system = opts.system
  if (opts.tools) body.tools = opts.tools
  out.push(...bodyLines(body, verbose))
  return out
}

/**
 * Transport-agnostic `--debug` request dump.
 *
 * Emits {@link requestDumpLines} as Debug-severity diagnostics, one per
 * line, under `transport.request-dump`. No-op unless debug mode is on. The
 * host's diagnostic sinks decide where the lines go (the session log file,
 * or stderr with `MINIMAL_AGENT_LOG_STDERR=1`).
 *
 * Each row carries `row` (its index in the dump) and the last carries
 * `last: true`, so a host sink can rebuild the whole request and render it
 * as one block. The dump is a multi-line document, not independent
 * one-liners, and a TUI that paints it above the prompt needs the whole
 * request at once. Rows stay plain text: styling is the host's decision.
 *
 * @param opts - The request about to be sent.
 * @param diagnostics - Where to report. Defaults to the process handle.
 */
export function debugRequestOptions(
  opts: SendOptions,
  diagnostics: Diagnostics = processDiagnostics(),
): void {
  if (!isDebug()) return
  const lines = requestDumpLines(opts)
  const last = lines.length - 1
  for (let i = 0; i < lines.length; i++) {
    diagnostics.debug("transport.request-dump", lines[i], {
      row: i,
      ...(i === last ? { last: true } : {}),
    })
  }
}

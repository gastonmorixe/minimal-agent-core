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

import type { StructuredData } from "../../bus/diagnostic-bus.ts"
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
 * `structuredData` of one `transport.request-dump` row.
 *
 * `row` and `last` are on every dump. The other keys are on verbose dumps
 * only: `kind` says what the row is (`part`: the labelled row of one
 * message, system block, or tool; `block`: one content block of a message;
 * `line`: one raw source line, verbatim), so a host can route rows by data
 * and never by the row text. `line` counts from 1 through the whole part.
 */
export interface RequestDumpRowData {
  /** Index of the row in the dump. */
  readonly row: number
  /** Set on the final row of the dump. */
  readonly last?: true
  /** Row type. Verbose only. */
  readonly kind?: "part" | "block" | "line" | "elided"
  /** Lines dropped by the row cap. Set on `elided` rows only. */
  readonly hiddenLines?: number
  /** Body section of the row. Verbose only. */
  readonly section?: "messages" | "system" | "tools"
  /** Index in `messages[]`, `system[]`, or `tools[]`. */
  readonly part?: number
  /** Content block index in the message (messages only). */
  readonly block?: number
  /** Content block type (messages only). */
  readonly blockType?: ContentBlock["type"]
  /** `tool_use.id`, or `tool_result.tool_use_id`. */
  readonly toolUseId?: string
  /** `tool_use.name`. */
  readonly toolName?: string
  /** `tool_result.is_error`. */
  readonly isError?: boolean
  /** 1-based line number, counted through the whole part. */
  readonly line?: number
}

/** One dump row before it becomes a diagnostic. */
export interface DumpRow {
  /** The row text. Never holds a newline. */
  readonly text: string
  /** Typed row data. Absent on header rows and on every non-verbose row. */
  readonly data?: Omit<RequestDumpRowData, "row" | "last">
}

type RowData = NonNullable<DumpRow["data"]>

/**
 * Most `line` rows one text block contributes.
 *
 * A verbose round resends the whole history, and each `line` row is one bus
 * event plus one synchronous `appendFileSync`, so an unbounded split of a
 * 5000-line `tool_result` alone gave 5010 rows / 98 KB. Past this cap the
 * block emits {@link MAX_LINE_ROWS} lines and one `elided` row whose
 * `hiddenLines` data holds the count the host renders. A resource guard: a data
 * number, never a text budget.
 */
export const MAX_LINE_ROWS = 200

/** Push one `line` row per `\n`-separated line of `text`. Returns the next line number. */
function pushLines(out: DumpRow[], text: string, base: RowData, from: number): number {
  if (text.length === 0) return from
  const lines = text.split("\n")
  const shown = Math.min(lines.length, MAX_LINE_ROWS)
  let line = from
  for (let i = 0; i < shown; i++) {
    out.push({ text: lines[i], data: { ...base, kind: "line", line } })
    line++
  }
  const hidden = lines.length - shown
  if (hidden > 0) {
    // Data only: the count goes out as `hiddenLines`, the host renders the
    // hint. `text` stays empty because no reader may build a row from it here.
    out.push({ text: "", data: { ...base, kind: "elided", hiddenLines: hidden } })
  }
  return from + lines.length
}

/** Deepest input nesting {@link jsonSafeValue} walks before it elides. */
const MAX_JSON_DEPTH = 100

/**
 * Copy `value` into a plain structure that `JSON.stringify` accepts.
 *
 * `stack` holds the ANCESTORS of the node being visited, so a real cycle
 * becomes `"[Circular]"` while one object referenced twice from sibling keys
 * is written twice. A bigint becomes its decimal digits plus `n`, and a
 * throwing getter becomes `"[unserializable]"` on that one property.
 */
function jsonSafeValue(value: unknown, stack: object[], depth: number): unknown {
  if (typeof value === "bigint") return `${value}n`
  if (value === null || typeof value !== "object") return value
  if (depth >= MAX_JSON_DEPTH) return "[depth]"
  const obj = value as Record<string, unknown> & { toJSON?: () => unknown }
  if (stack.includes(obj)) return "[Circular]"
  stack.push(obj)
  try {
    if (typeof obj.toJSON === "function") return jsonSafeValue(obj.toJSON(), stack, depth + 1)
    if (Array.isArray(obj)) return obj.map((v) => jsonSafeValue(v, stack, depth + 1))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj)) {
      try {
        out[k] = jsonSafeValue(obj[k], stack, depth + 1)
      } catch {
        out[k] = "[unserializable]"
      }
    }
    return out
  } finally {
    stack.pop()
  }
}

/**
 * `JSON.stringify` that never throws.
 *
 * The dump runs inside the send path (`canonical-send.ts`), so a tool input
 * that plain `JSON.stringify` rejects must not abort a request that the base
 * commit sent. A cycle becomes `"[Circular]"`, a bigint becomes `"10n"`, and
 * any other surprise becomes the `"[unserializable]"` marker.
 */
function safeJson(value: unknown, indent = 2): string {
  try {
    return JSON.stringify(jsonSafeValue(value, [], 0), null, indent) ?? "[unserializable]"
  } catch {
    return "[unserializable]"
  }
}

/** The faithful source text of one content block, or `undefined` when it has none. */
function blockSourceText(b: ContentBlock): string | undefined {
  switch (b.type) {
    case "text":
      return b.text
    case "thinking":
      return b.thinking
    case "tool_use":
      return safeJson(b.input ?? {})
    case "tool_result":
      if (typeof b.content === "string") return b.content
      return b.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")
    default:
      return undefined
  }
}

/** The typed data of the `block` row of `b`. */
function blockRowData(b: ContentBlock, part: number, block: number): RowData {
  const base: RowData = { kind: "block", section: "messages", part, block, blockType: b.type }
  if (b.type === "tool_use") return { ...base, toolUseId: b.id, toolName: b.name }
  if (b.type === "tool_result") {
    return {
      ...base,
      toolUseId: b.tool_use_id,
      ...(b.is_error !== undefined ? { isError: b.is_error } : {}),
    }
  }
  return base
}

/** Verbose rows of one message: one `block` row per block, each followed by its `line` rows. */
function pushMessageDetail(out: DumpRow[], content: string | ContentBlock[], part: number): void {
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content
  let line = 1
  for (let j = 0; j < blocks.length; j++) {
    const b = blocks[j]
    out.push({ text: `        block ${j} ${b.type}`, data: blockRowData(b, part, j) })
    const text = blockSourceText(b)
    if (text !== undefined) {
      line = pushLines(out, text, { section: "messages", part, block: j }, line)
    }
  }
}

/**
 * The body preview rows: a per-message role/content preview, the system
 * blocks, and the tool list. Marks where the cache breakpoint sits.
 *
 * Rows longer than the preview cap produce a second, indented row holding the
 * FULL text under the same label. The cap is configurable so `--verbose` can
 * disable it; without the continuation row, raising the cap would only ever
 * elide at a different width.
 *
 * Verbose only: each labelled row carries `kind: "part"`, and the raw
 * source follows as `block` and `line` rows (see {@link RequestDumpRowData}).
 */
function bodyLines(body: Record<string, unknown>, verbose: boolean): DumpRow[] {
  const cap = (): number => (verbose ? Number.MAX_SAFE_INTEGER : 80)
  const partData = (section: RowData["section"], part: number): RowData | undefined =>
    verbose ? { kind: "part", section, part } : undefined
  /** Push `label + preview`, plus the full text when the preview was cut. */
  const pushRow = (
    label: string,
    text: string,
    section: "system" | "tools",
    part: number,
  ): void => {
    const preview = oneLine(text, cap())
    const data = partData(section, part)
    out.push({ text: `      ${label}: ${preview}`, ...(data ? { data } : {}) })
    const full = oneLine(text, Number.MAX_SAFE_INTEGER)
    if (full !== preview) out.push({ text: `        ${full}` })
    if (verbose) pushLines(out, text, { section, part }, 1)
  }
  const out: DumpRow[] = [{ text: "  Body:" }]
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[]
      out.push({ text: `    messages: [${msgs.length} message(s)]` })
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const cached =
          typeof msg.content !== "string" &&
          Boolean(
            (msg.content[msg.content.length - 1] as { cache_control?: unknown })?.cache_control,
          )
        const cc = cached ? " [← cached prefix ends here]" : ""
        // `oneLine`, not `truncate`: a multi-line user message would otherwise
        // put raw newlines in the row and be dropped by the host's parser.
        const preview = oneLine(previewContent(msg.content, Number.MAX_SAFE_INTEGER), cap())
        const data = partData("messages", i)
        out.push({ text: `      ${msg.role}${cc}: ${preview}`, ...(data ? { data } : {}) })
        const full = oneLine(
          previewContent(msg.content, Number.MAX_SAFE_INTEGER),
          Number.MAX_SAFE_INTEGER,
        )
        if (full !== preview) out.push({ text: `        ${full}` })
        if (verbose) pushMessageDetail(out, msg.content, i)
      }
    } else if (k === "system") {
      const sys = v as Array<{ type: string; text: string; cache_control?: unknown }>
      out.push({ text: `    system: [${sys.length} block(s)]` })
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        const cc = block.cache_control ? " [cached]" : ""
        pushRow(`block ${i}${cc}`, block.text, "system", i)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      out.push({ text: `    tools: [${tools.length} tool(s)]` })
      for (let i = 0; i < tools.length; i++) {
        pushRow(tools[i].name, tools[i].description ?? "", "tools", i)
      }
    } else {
      out.push({ text: `    ${k}: ${oneLine(JSON.stringify(v), Number.MAX_SAFE_INTEGER)}` })
    }
  }
  return out
}

/**
 * The typed `--debug` dump of one request: the model / stream / max_tokens /
 * request_type header rows plus the body preview rows. Never includes `auth`
 * (the credential).
 *
 * Every row text is a single line (no embedded newline), so one dump row maps
 * to one diagnostic row, readable in the TUI and valid in the file log. With
 * `verbose`, previews are untruncated and the raw source follows as typed
 * `block` and `line` rows. Without it, no row carries `data`.
 *
 * @param opts - The request about to be sent.
 * @param verbose - Add the verbose rows and the row data.
 * @returns The dump rows, in order.
 */
export function requestDumpRows(opts: SendOptions, verbose: boolean): DumpRow[] {
  const out: DumpRow[] = [{ text: `--- POST ${opts.model ?? "(default model)"} ---` }]
  const kv = (key: string, value: string): void => {
    out.push({ text: `  ${key}: ${oneLine(value, Number.MAX_SAFE_INTEGER)}` })
  }
  if (opts.model) kv("model", opts.model)
  kv("stream", String(opts.stream ?? true))
  if (opts.maxTokens != null) kv("max_tokens", String(opts.maxTokens))
  kv("request_type", opts.requestType ?? "conversation")
  if (opts.thinking) kv("thinking", JSON.stringify(opts.thinking))
  if (opts.outputConfig) kv("output_config", JSON.stringify(opts.outputConfig))
  if (opts.speed && opts.speed !== "normal") kv("speed", opts.speed)
  // `messages` goes LAST: it is the longest and most-read section, so it
  // ends right above the prompt instead of being pushed up by system/tools.
  // `system` sits directly before it (after `tools`), so the prompt reads in
  // the order the model sees it: system blocks, then the conversation.
  const body: Record<string, unknown> = {}
  if (opts.tools) body.tools = opts.tools
  if (opts.system) body.system = opts.system
  body.messages = opts.messages
  out.push(...bodyLines(body, verbose))
  return out
}

/**
 * The plain-text `--debug` dump of one request: the text of each
 * {@link requestDumpRows} row. Pass `verbose` to keep previews untruncated.
 */
export function requestDumpLines(opts: SendOptions, verbose = isVerbose()): string[] {
  return requestDumpRows(opts, verbose).map((r) => r.text)
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
  const rows = requestDumpRows(opts, isVerbose())
  const last = rows.length - 1
  for (let i = 0; i < rows.length; i++) {
    const data: StructuredData = {
      row: i,
      ...rows[i].data,
      ...(i === last ? { last: true } : {}),
    } satisfies RequestDumpRowData
    diagnostics.debug("transport.request-dump", rows[i].text, data)
  }
}

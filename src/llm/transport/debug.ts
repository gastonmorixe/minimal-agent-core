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

/** Truncate `s` to `max` chars (verbose mode disables the cap). */
function truncate(s: string, max: number): string {
  return isVerbose() ? s : clampWithHint(s, max, "ch")
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
 * The body preview lines: a per-message role/content preview, the system
 * blocks, and the tool list. Marks where the cache breakpoint sits.
 */
function bodyLines(body: Record<string, unknown>): string[] {
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
        out.push(`      ${msg.role}${cc}: ${previewContent(msg.content, 80)}`)
      }
    } else if (k === "system") {
      const sys = v as Array<{ type: string; text: string; cache_control?: unknown }>
      out.push(`    system: [${sys.length} block(s)]`)
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        const cc = block.cache_control ? " [cached]" : ""
        out.push(`      block ${i}${cc}: ${truncate(block.text, 80)}`)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      out.push(`    tools: [${tools.length} tool(s)]`)
      for (const tool of tools) {
        out.push(`      ${tool.name}: ${truncate(tool.description ?? "", 80)}`)
      }
    } else {
      out.push(`    ${k}: ${JSON.stringify(v)}`)
    }
  }
  return out
}

/**
 * The plain-text `--debug` dump of one request: the model / stream /
 * max_tokens / request_type header lines plus the body preview. Never
 * includes `auth` (the credential).
 */
export function requestDumpLines(opts: SendOptions): string[] {
  const out = [`--- POST ${opts.model ?? "(default model)"} ---`]
  const kv = (key: string, value: string): void => {
    out.push(`  ${key}: ${value}`)
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
  out.push(...bodyLines(body))
  return out
}

/**
 * Transport-agnostic `--debug` request dump.
 *
 * Emits {@link requestDumpLines} as Debug-severity diagnostics, one per
 * line, under `transport.request-dump`. No-op unless debug mode is on. The
 * host's diagnostic sinks decide where the lines go (the session log file,
 * or stderr with `MINIMAL_AGENT_LOG_STDERR=1`).
 */
export function debugRequestOptions(
  opts: SendOptions,
  diagnostics: Diagnostics = processDiagnostics(),
): void {
  if (!isDebug()) return
  for (const line of requestDumpLines(opts)) diagnostics.debug("transport.request-dump", line)
}

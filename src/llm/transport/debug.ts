/**
 * Transport `--debug` request dump.
 *
 * Provider-neutral: prints a structured view of a `SendOptions` request
 * (model / stream / max_tokens / request_type plus a messages/system/tools
 * preview) to stderr when debug mode is on. Derived purely from the agent's
 * `SendOptions`; the adapter builds the real wire body downstream, but the
 * user-facing debug view is the same regardless of provider.
 *
 * @module llm/transport/debug
 */

import { ansiStyle } from "@minimal-agent/plugin-api/utils/ansi"

import { clampWithHint } from "../../truncate-hint.ts"
import type { ContentBlock, Message } from "../messages.ts"

import type { SendOptions } from "./types.ts"

const c = ansiStyle

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

function debugHeader(label: string): void {
  if (!isDebug()) return
  console.error(`\n${c.bold(c.cyan(`--- ${label} ---`))}`)
}

function debugKV(key: string, value: string): void {
  if (!isDebug()) return
  console.error(`  ${c.dim(`${key}:`)} ${value}`)
}

/**
 * Pretty-print the request body: a per-message role/content preview, the
 * system blocks, and the tool list. Marks where the cache breakpoint sits.
 */
function debugBody(body: Record<string, unknown>): void {
  if (!isDebug()) return
  console.error(`  ${c.bold("Body:")}`)
  for (const [k, v] of Object.entries(body)) {
    if (k === "messages") {
      const msgs = v as Message[]
      console.error(`    ${c.yellow("messages")}: ${c.dim(`[${msgs.length} message(s)]`)}`)
      for (const msg of msgs) {
        const cached =
          typeof msg.content !== "string" &&
          Boolean(
            (msg.content[msg.content.length - 1] as { cache_control?: unknown })?.cache_control,
          )
        const cc = cached ? ` ${c.bold(c.brightGreen("[← cached prefix ends here]"))}` : ""
        console.error(`      ${c.green(msg.role)}${cc}: ${c.dim(previewContent(msg.content, 80))}`)
      }
    } else if (k === "system") {
      const sys = v as Array<{ type: string; text: string; cache_control?: unknown }>
      console.error(`    ${c.yellow("system")}: ${c.dim(`[${sys.length} block(s)]`)}`)
      for (let i = 0; i < sys.length; i++) {
        const block = sys[i]
        const cc = block.cache_control ? ` ${c.bold(c.brightGreen("[cached]"))}` : ""
        console.error(`      ${c.magenta(`block ${i}`)}${cc}: ${c.dim(truncate(block.text, 80))}`)
      }
    } else if (k === "tools") {
      const tools = v as Array<{ name: string; description?: string }>
      console.error(`    ${c.yellow("tools")}: ${c.dim(`[${tools.length} tool(s)]`)}`)
      for (const tool of tools) {
        console.error(
          `      ${c.magenta(tool.name)}: ${c.dim(truncate(tool.description ?? "", 80))}`,
        )
      }
    } else {
      console.error(`    ${c.yellow(k)}: ${JSON.stringify(v)}`)
    }
  }
}

/**
 * Transport-agnostic `--debug` request dump.
 *
 * Prints the model / stream / max_tokens / request_type header lines plus the
 * structured messages / system / tools body preview to stderr. No-op unless
 * debug mode is on. Never prints `auth` (the credential).
 */
export function debugRequestOptions(opts: SendOptions): void {
  if (!isDebug()) return
  debugHeader(`POST ${opts.model ?? "(default model)"}`)
  if (opts.model) debugKV("model", opts.model)
  debugKV("stream", String(opts.stream ?? true))
  if (opts.maxTokens != null) debugKV("max_tokens", String(opts.maxTokens))
  debugKV("request_type", opts.requestType ?? "conversation")
  if (opts.thinking) debugKV("thinking", JSON.stringify(opts.thinking))
  if (opts.outputConfig) debugKV("output_config", JSON.stringify(opts.outputConfig))
  if (opts.speed && opts.speed !== "normal") debugKV("speed", opts.speed)
  const body: Record<string, unknown> = { messages: opts.messages }
  if (opts.system) body.system = opts.system
  if (opts.tools) body.tools = opts.tools
  debugBody(body)
}

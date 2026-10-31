/**
 * Tool facts for the event stream (spec S19): the one-line input and output
 * summaries, and the capped output text of a `tool_output` event.
 *
 * Pure functions. The summaries are for display (a trace view, a progress
 * line); they never reach the model.
 *
 * @module sdk/tool-facts
 */

import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"

import { TOOL_OUTPUT_TEXT_CAP, type ToolCallEvent, type ToolOutputEvent } from "./events.ts"

/** Most characters in one summary. */
export const TOOL_SUMMARY_MAX_CHARS = 120

/** Collapse whitespace to single spaces and cut to `max` characters. */
function oneLine(text: string, max = TOOL_SUMMARY_MAX_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const chars = Array.from(flat)
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`
}

/**
 * One-line summary of a tool input. When the caller names an identifying
 * input field and the input has it as a string, the summary is that value;
 * otherwise it is the compact JSON of the input. Core itself never passes
 * a field name (S29: the tool's cosmetic presentation data that used to
 * supply one is a CLI-side concern now), so today this always takes the
 * JSON path; the parameter stays for a host or test that wants the
 * preview-one-field behavior.
 */
export function summarizeToolInput(input: unknown, preferField?: string): string {
  if (preferField && input !== null && typeof input === "object") {
    const value = (input as Record<string, unknown>)[preferField]
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value)
  }
  try {
    return oneLine(JSON.stringify(input) ?? "")
  } catch {
    return ""
  }
}

/** The text of a tool result: the string, or its text blocks (other blocks as `[type]`). */
export function toolOutputText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content.map((b) => (b.type === "text" ? b.text : `[${b.type}]`)).join("\n")
}

/**
 * One-line summary of a tool output: its first non-empty line, plus the
 * count of the other non-empty lines.
 */
export function summarizeToolOutput(content: string | ContentBlock[]): string {
  const lines = toolOutputText(content)
    .split("\n")
    .filter((l) => l.trim().length > 0)
  const first = lines[0]
  if (first === undefined) return ""
  const more = lines.length - 1
  if (more === 0) return oneLine(first)
  return `${oneLine(first)} (+${more} ${more === 1 ? "line" : "lines"})`
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes, on a character boundary. */
export function capUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; totalBytes: number } {
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return { text, truncated: false, totalBytes: bytes.length }
  let end = maxBytes
  // Step back over UTF-8 continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
    totalBytes: bytes.length,
  }
}

/** A copy of the model's tool input, so a sink cannot reach history through it. */
function copyInput(input: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(input)
  } catch {
    return { ...input }
  }
}

/** The `tool_call` event for a tool_use block. */
export function toolCallEvent(tool: ToolUseBlock, inputSummary: string): ToolCallEvent {
  return {
    type: "tool_call",
    callId: tool.id,
    toolName: tool.name,
    input: copyInput(tool.input),
    inputSummary,
  }
}

/** The `tool_output` event for a finished tool call. */
export function toolOutputEvent(
  tool: ToolUseBlock,
  content: string | ContentBlock[],
): ToolOutputEvent {
  const capped = capUtf8(toolOutputText(content), TOOL_OUTPUT_TEXT_CAP)
  return {
    type: "tool_output",
    callId: tool.id,
    toolName: tool.name,
    text: capped.text,
    truncated: capped.truncated,
    totalBytes: capped.totalBytes,
  }
}

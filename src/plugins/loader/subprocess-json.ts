/**
 * The `output: "json"` form of a subprocess tool handler: stdout is one JSON
 * object with the fields of the `tool_result` arm of `TUIResult`.
 *
 * Only the known fields with the correct type are kept. `attachments` stays
 * an array of plain objects here: `PluginLoader.dispatch` decodes the
 * `{base64}` wire entries (`attachment-wire.ts`) for every tool handler.
 *
 * @module plugins/loader/subprocess-json
 */

import type { ToolHandlerResult } from "../../../plugin-api/src/types/plugin.ts"

/** The `tool_result` arm of {@link ToolHandlerResult}. */
type ToolResult = Extract<ToolHandlerResult, { kind: "tool_result" }>

/** The optional string fields that a JSON result can set. */
const STRING_FIELDS = ["display", "displayHeader", "displayFooter"] as const

/**
 * Parse the stdout of a JSON subprocess tool handler.
 *
 * @param out - All of stdout (already under the stdout cap).
 * @param code - The exit code. A non-zero code sets `is_error`.
 * @returns The result, or `null` when stdout is not one JSON object with a
 *   string `content` (and, when present, `kind: "tool_result"`).
 */
export function parseJsonToolResult(out: string, code: number): ToolResult | null {
  let v: unknown
  try {
    v = JSON.parse(out)
  } catch {
    return null
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (o.kind !== undefined && o.kind !== "tool_result") return null
  if (typeof o.content !== "string") return null
  const r: ToolResult = {
    kind: "tool_result",
    content: o.content,
    is_error: o.is_error === true || code !== 0,
  }
  for (const k of STRING_FIELDS) if (typeof o[k] === "string") r[k] = o[k] as string
  if (typeof o.suppressToolTime === "boolean") r.suppressToolTime = o.suppressToolTime
  if (Array.isArray(o.attachments)) r.attachments = o.attachments
  return r
}

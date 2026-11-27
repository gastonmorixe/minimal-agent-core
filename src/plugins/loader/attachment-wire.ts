/**
 * The JSON wire form of plugin tool attachments.
 *
 * A subprocess handler prints its `tool_result` as JSON, and JSON has no
 * bytes. So it sends each attachment as `{base64, mimeType?, label?}`
 * ({@link ToolAttachmentWire}). {@link decodeWire} runs in
 * `PluginLoader.dispatch`, for every tool handler (subprocess and module),
 * and changes each wire entry to a {@link ToolAttachment} with `bytes`. So
 * the tool round sees only bytes.
 *
 * Rules (also in the TSDoc of {@link ToolAttachmentWire}):
 * 1. `base64` is strict standard base64: only `A-Z a-z 0-9 + /`, a length
 *    that is a multiple of 4, and `=` padding (0 to 2) only at the end. No
 *    whitespace. An empty string is not valid.
 * 2. The string length is checked BEFORE the decode
 *    ({@link MAX_ATTACHMENT_BASE64_CHARS}), so a huge string is never
 *    decoded into memory. Then the decoded size is checked against
 *    {@link MAX_ATTACHMENT_BYTES}.
 * 3. A maximum of {@link MAX_WIRE_ATTACHMENTS} wire entries for each result.
 * 4. A bad entry is dropped with a `tool-attachment.invalid` warning. Its
 *    place in the array stays (an empty wire entry, which the tool round
 *    ignores), so the file number of a later entry does not change. The
 *    tool call does not fail.
 *
 * An entry that already has `bytes`, or that is not a wire entry, has no
 * change.
 *
 * @module plugins/loader/attachment-wire
 */

import type {
  ToolAttachment,
  ToolAttachmentWire,
  ToolHandlerResult,
} from "../../../plugin-api/src/types/plugin.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import { MAX_ATTACHMENT_BYTES } from "../../media/tool-attachment.ts"

/** The maximum number of wire entries in one result. Core drops the entries after it. */
export const MAX_WIRE_ATTACHMENTS = 8

/**
 * The maximum length of one `base64` string: the base64 length of
 * {@link MAX_ATTACHMENT_BYTES} (44739244 characters for 32 MiB).
 */
export const MAX_ATTACHMENT_BASE64_CHARS = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3)

/** Strict standard base64: the alphabet, then 0 to 2 `=` at the end. */
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

/** Why a wire entry was dropped (the `reason` of `tool-attachment.invalid`). */
export type WireDropReason =
  | "base64-not-string"
  | "base64-too-long"
  | "base64-invalid"
  | "too-large"
  | "too-many"

/** `true` when `s` is strict standard base64 (see the module doc). */
export function isStrictBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && BASE64_RE.test(s)
}

/** `true` for an object with a `base64` key and no `Uint8Array` `bytes`. */
function isWireEntry(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || !("base64" in v)) return false
  return !((v as { bytes?: unknown }).bytes instanceof Uint8Array)
}

/** Decode one wire entry. Gives the attachment, or the reason of the drop. */
export function decodeWireEntry(e: Record<string, unknown>): ToolAttachment | WireDropReason {
  const b64 = e.base64
  if (typeof b64 !== "string") return "base64-not-string"
  if (b64.length > MAX_ATTACHMENT_BASE64_CHARS) return "base64-too-long"
  if (!isStrictBase64(b64)) return "base64-invalid"
  const buf = Buffer.from(b64, "base64")
  if (buf.byteLength > MAX_ATTACHMENT_BYTES) return "too-large"
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  return {
    bytes,
    ...(typeof e.mimeType === "string" ? { mimeType: e.mimeType } : {}),
    ...(typeof e.label === "string" ? { label: e.label } : {}),
  }
}

/**
 * Decode the wire entries of an attachment list. The array keeps its length
 * and order. A dropped entry becomes `{base64: ""}`, and `onDrop` gets its
 * index and reason.
 *
 * @param list - The `attachments` of the result.
 * @param onDrop - Called one time for each dropped entry.
 * @returns The same array when it has no wire entry, else a new array.
 */
export function decodeWireAttachments(
  list: ReadonlyArray<ToolAttachment | ToolAttachmentWire>,
  onDrop: (index: number, reason: WireDropReason) => void,
): ReadonlyArray<ToolAttachment | ToolAttachmentWire> {
  if (!list.some(isWireEntry)) return list
  let wire = 0
  return list.map((e, i) => {
    if (!isWireEntry(e)) return e
    wire += 1
    const r = wire > MAX_WIRE_ATTACHMENTS ? "too-many" : decodeWireEntry(e)
    if (typeof r !== "string") return r
    onDrop(i, r)
    return { base64: "" }
  })
}

/**
 * The dispatch step: decode the wire attachments of a `tool_result`. Other
 * results, and a result with no wire entry, come back with no change.
 *
 * @param r - The result of the handler.
 * @param diagnostics - Gets `tool-attachment.invalid` (data pluginId, tool, index, reason).
 * @param pluginId - The id of the plugin, for the warning.
 * @param tool - The tool name, for the warning.
 * @returns The result with bytes in place of each valid wire entry.
 */
export function decodeWire(
  r: ToolHandlerResult,
  diagnostics: Pick<Diagnostics, "warn">,
  pluginId: string,
  tool: string,
): ToolHandlerResult {
  if (r?.kind !== "tool_result" || !Array.isArray(r.attachments)) return r
  const attachments = decodeWireAttachments(r.attachments, (index, reason) =>
    diagnostics.warn("tool-attachment.invalid", "", { pluginId, tool, index, reason }),
  )
  return attachments === r.attachments ? r : { ...r, attachments }
}

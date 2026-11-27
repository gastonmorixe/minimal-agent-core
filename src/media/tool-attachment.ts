/**
 * Plugin tool attachments: binary files (for example a PNG screenshot) that
 * a plugin tool gives back with its `tool_result`.
 *
 * Each attachment goes through the same media gate as the built-in `Read`
 * tool ({@link decideReadFile}): the type comes from the magic bytes, the
 * active model must accept the modality, and an image too large for the
 * per-item limit is shrunk first. An accepted image becomes an
 * {@link ImageBlock}. The tool round then sends `[text, image...]`, the same
 * wire shape as a `Read` of a screenshot.
 *
 * Core keeps no prose (the text plugins own it). The model-facing lines are
 * the `tool_text.Read.*` texts of the media gate, and one `binary-result`
 * sideband tag for each attachment. The tag names the saved path, so the model
 * can `Read` the file later. A tag with no `path` attr means "not saved".
 *
 * @module media/tool-attachment
 */

import type { ToolAttachment, ToolAttachmentWire } from "../../plugin-api/src/types/plugin.ts"
import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ImageBlock } from "../llm/canonical-messages.ts"
import { joinOutcome } from "../loops/tool-outcome-finalize.ts"
import { attachmentFileName, type BlobStore, formatBytes } from "../session/blob-store.ts"
import { renderCoreKind } from "../sideband/core-render.ts"
import type { SidebandApi } from "../sideband/types.ts"
import { hasBinaryResultTag, isBinaryOptIn } from "../tools/binary-guard.ts"
import { scrubEmbeddedPayloads } from "../tools/embedded-payload-scrub.ts"
import { readTooLargeText } from "../tools/tool-result-text.ts"

import { mimeToKind, sniffMime } from "./probe.ts"
import { decideReadFile, type ReadFileMediaContext, unsupportedEmbeddingText } from "./read-file.ts"
import { resolveToolMediaContext } from "./tool-context.ts"

/**
 * The maximum number of image blocks in one tool result. The LAST image
 * candidates of the array get the slots (a plugin puts the newest last).
 * Earlier images get a path line only.
 */
export const MAX_ATTACHMENT_IMAGES = 3

/**
 * The maximum size of one attachment: 32 MiB. This is 1/8 of the default
 * per-session blob cap (`maxBytesPerSession`, 256 MiB), so one result cannot
 * push most of the session blobs out of the LRU. It is also the per-file cap
 * of `sessions:files`. A larger attachment is not saved and not gated. The
 * model gets a "too large" text and a tag with no path. When the store has a
 * lower `maxBytesPerSession`, that value is the cap.
 */
export const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024

/** The maximum length of the `label` attr, in characters. */
const MAX_LABEL_CHARS = 80

/** The MIME type that magic bytes do not identify. */
const UNKNOWN_MIME = "application/octet-stream"

/** File extension for each MIME type that {@link sniffMime} gives. */
const EXT_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
}

/** The file extension of a sniffed MIME type, else `bin`. */
export function attachmentExtension(mimeType: string): string {
  return EXT_BY_MIME[mimeType] ?? "bin"
}

/** Inputs of {@link processToolAttachments}. */
export interface ToolAttachmentInput {
  /**
   * The attachments of the plugin result. An entry whose `bytes` is not a
   * `Uint8Array` is ignored, but it keeps its number: the file of the entry
   * at array position `i` is always `-<i + 1>`.
   */
  readonly attachments: ReadonlyArray<ToolAttachment | ToolAttachmentWire>
  /** The tool name, for the `tool` attr of the tag. */
  readonly toolName: string
  /** The tool use id. The file name comes from {@link attachmentFileName}. */
  readonly toolUseId: string
  /**
   * The session blob store. `null`: no store, or the store is off. Then
   * core writes no file. The LRU caps of the store count the files.
   */
  readonly store: Pick<BlobStore, "writeAttachment"> | null
  /**
   * The media gate of the active model (`resolveToolMediaContext`).
   * `undefined` (an unknown model): no image block, a path line only.
   */
  readonly media: ReadFileMediaContext | undefined
  /** The synthetic text resolver for the gate texts. Default: no text. */
  readonly text?: SyntheticTextResolver
  /** The sideband API that renders the `binary-result` tag. */
  readonly sb: Pick<SidebandApi, "render">
  /** The byte cap of one attachment. Default {@link MAX_ATTACHMENT_BYTES}. */
  readonly maxBytes?: number
  /** Called with the file name when the store does not save a file. */
  readonly onWriteError?: (fileName: string) => void
}

/** What {@link processToolAttachments} gives. */
export interface ToolAttachmentResult {
  /** The model-facing lines, one group for each attachment, in order. Empty strings are left out. */
  readonly textLines: string[]
  /** The accepted image blocks, at most {@link MAX_ATTACHMENT_IMAGES}, in array order. */
  readonly media: ImageBlock[]
}

/** One attachment with its facts, before the save and the gate. */
interface Entry {
  readonly bytes: Uint8Array
  /** The position in the array, from 1. */
  readonly n: number
  /** The type from the magic bytes. */
  readonly sniffed: string
  /** The one MIME type of the texts and the tag: the sniffed type, else the hint. */
  readonly mimeType: string
  readonly label: string | undefined
  readonly tooLarge: boolean
}

function entriesOf(input: ToolAttachmentInput): Entry[] {
  const max = input.maxBytes ?? MAX_ATTACHMENT_BYTES
  const out: Entry[] = []
  input.attachments.forEach((entry, i) => {
    // A wire entry (`{base64}`) is decoded in `PluginLoader.dispatch`. One
    // that is still here (a dropped entry) has no bytes: ignored.
    if (!((entry as { bytes?: unknown } | null)?.bytes instanceof Uint8Array)) return
    const att = entry as ToolAttachment
    const sniffed = sniffMime(att.bytes)
    const hint = typeof att.mimeType === "string" ? att.mimeType.trim() : ""
    const label = typeof att.label === "string" ? att.label.trim().slice(0, MAX_LABEL_CHARS) : ""
    out.push({
      bytes: att.bytes,
      n: i + 1,
      sniffed,
      mimeType: sniffed === UNKNOWN_MIME && hint !== "" ? hint : sniffed,
      label: label === "" ? undefined : label,
      tooLarge: att.bytes.byteLength > max,
    })
  })
  return out
}

/** The entries that get an image slot: the last image candidates under the cap. */
function imageSlots(entries: Entry[]): Set<Entry> {
  const candidates = entries.filter((e) => !e.tooLarge && mimeToKind(e.sniffed) === "image")
  return new Set(candidates.slice(-MAX_ATTACHMENT_IMAGES))
}

/** Write one attachment. Gives the path and hash, or `null` when not saved. Never throws. */
async function saveAttachment(
  input: ToolAttachmentInput,
  e: Entry,
): Promise<{ path: string; sha256: string } | null> {
  if (input.store === null || e.bytes.length === 0 || e.tooLarge) return null
  const ext = attachmentExtension(e.sniffed)
  const r = await input.store.writeAttachment(input.toolUseId, e.n, ext, e.bytes)
  if (r === null) input.onWriteError?.(attachmentFileName(input.toolUseId, e.n, ext))
  return r
}

/** The `binary-result` tag of one attachment ("" with no codec or no owner of the kind). */
function pointerTag(
  input: ToolAttachmentInput,
  e: Entry,
  saved: { path: string; sha256: string } | null,
): string {
  const attrs: Record<string, string> = { mime: e.mimeType, size: formatBytes(e.bytes.length) }
  if (saved !== null) {
    attrs.path = saved.path
    attrs.sha256 = saved.sha256
  }
  attrs.tool = input.toolName
  // A codec drops an attr that the kind does not declare.
  if (e.label !== undefined) attrs.label = e.label
  return renderCoreKind(input.sb, "binary-result", { attrs })
}

/** The gate text of one attachment, and its image block when the gate accepts it. */
async function gateAttachment(
  input: ToolAttachmentInput,
  e: Entry,
  slot: boolean,
): Promise<{ line: string; block?: ImageBlock }> {
  const text = input.text ?? EMPTY_SYNTHETIC_TEXT
  if (e.tooLarge) {
    const max = input.maxBytes ?? MAX_ATTACHMENT_BYTES
    const mb = (b: number) => (b / 1024 / 1024).toFixed(1)
    return { line: readTooLargeText(text, mb(e.bytes.length), Number(mb(max))) }
  }
  if (input.media === undefined) return { line: "" }
  // No slot: do not decode or resize an image that core will not send.
  if (mimeToKind(e.sniffed) === "image" && !slot) return { line: "" }
  const decision = await decideReadFile(e.bytes, input.media, text)
  if (decision.kind === "image") return { line: decision.summary, block: decision.block }
  if (decision.kind === "rejected") return { line: decision.message }
  // Bytes with no known magic: tool output cannot carry them.
  const facts = { mimeType: e.mimeType, sizeBytes: e.bytes.length }
  return { line: unsupportedEmbeddingText(text, facts) }
}

/**
 * Save each attachment in the session blob store and send it through the
 * `Read` media gate.
 *
 * For each attachment, in order:
 * 1. Over the byte cap ({@link MAX_ATTACHMENT_BYTES}): no file, no gate, the
 *    `tool_text.Read.too_large` text and a tag with no path.
 * 2. Write the bytes with `BlobStore.writeAttachment` (the extension from
 *    the sniffed MIME type, else `bin`). With no store, or on a write
 *    error, there is no file and no `path` attr.
 * 3. Image slots: the LAST {@link MAX_ATTACHMENT_IMAGES} images under the
 *    cap get a slot. An image in a slot that the gate accepts gives the
 *    image block and the `tool_text.Read.image_summary` caption. An image
 *    with no slot gets no gate text. A rejected image does not give its
 *    slot to an earlier image.
 * 4. Rejected (no image modality, too large, a PDF, audio, video, unknown
 *    bytes): the rejection text of the gate.
 * 5. No media context: no gate text.
 * 6. Always: the `binary-result` tag with the MIME type, size, path, tool
 *    and label.
 *
 * @param input - The attachments and the context of the call.
 * @returns The text lines and the accepted image blocks.
 */
export async function processToolAttachments(
  input: ToolAttachmentInput,
): Promise<ToolAttachmentResult> {
  const textLines: string[] = []
  const media: ImageBlock[] = []
  const entries = entriesOf(input)
  const slots = imageSlots(entries)
  for (const e of entries) {
    const saved = await saveAttachment(input, e)
    const gated = await gateAttachment(input, e, slots.has(e))
    if (gated.block) media.push(gated.block)
    const group = [gated.line, pointerTag(input, e, saved)].filter((t) => t !== "").join("\n")
    if (group !== "") textLines.push(group)
  }
  return { textLines, media }
}

/**
 * A new outcome with the attachment lines after the body text and the image
 * blocks in `media` (after any media the outcome has). The input is not
 * changed. With no lines and no media, the same outcome.
 */
export function withAttachments(o: ToolOutcome, r: ToolAttachmentResult): ToolOutcome {
  if (r.textLines.length === 0 && r.media.length === 0) return o
  const lines = r.textLines.join("\n\n")
  const text =
    lines === "" ? o.body.text : o.body.text === "" ? lines : `${o.body.text}\n\n${lines}`
  return {
    ...o,
    body: { ...o.body, text },
    ...(r.media.length > 0 ? { media: [...(o.media ?? []), ...r.media] } : {}),
  }
}

/** The values of the tool round that {@link addToolAttachments} reads. */
export interface ToolAttachmentRoundContext {
  /** The session blob store. `null`, or a store that is off: no file. */
  readonly blobStore: Pick<BlobStore, "config" | "writeAttachment"> | null
  /** The active model id. The media gate comes from `resolveToolMediaContext`. */
  readonly model: string
  /** Gets `tool-attachment.write-failed` when a file write fails. */
  readonly diagnostics?: Pick<Diagnostics, "warn"> | undefined
}

/** The values of the one call that {@link addToolAttachments} reads. */
export interface ToolAttachmentCall {
  /** The tool call. */
  readonly tool: { readonly id: string; readonly name: string }
  /** The tool input. `binary: true` turns off the data-URI scrub, as for any tool. */
  readonly input: Record<string, unknown>
  /** The synthetic text resolver of the round. */
  readonly text: SyntheticTextResolver
  /** The sideband API of the round. */
  readonly sb: Pick<SidebandApi, "render" | "trailing" | "has">
}

/**
 * The data-URI scrub of the round, on the plugin body BEFORE the attachment
 * lines go in. After that, the body holds a `binary-result` tag (and maybe
 * media), and the round scrub skips the whole body. Same guards and the same
 * `rawForBlob` rule as the round scrub. A body that already holds a
 * `binary-result` tag from the plugin is left alone.
 */
function scrubPluginBody(o: ToolOutcome, call: ToolAttachmentCall): ToolOutcome {
  if (o.aborted || (o.media?.length ?? 0) > 0 || isBinaryOptIn(call.input)) return o
  const prefix = joinOutcome(o)
  if (prefix.length === 0 || hasBinaryResultTag(call.sb, prefix)) return o
  const tool = call.tool.name
  const scrubbed = scrubEmbeddedPayloads(call.sb, o.body.text, { tool })
  if (!scrubbed.changed) return o
  const out = { ...o, body: { ...o.body, text: scrubbed.text }, rawForBlob: o.rawForBlob ?? prefix }
  const view = o.hostHints?.view
  if (typeof view !== "string" || !view.includes("data:")) return out
  const d = scrubEmbeddedPayloads(call.sb, view, { tool })
  return d.changed ? { ...out, hostHints: { ...o.hostHints, view: d.text } } : out
}

/**
 * The tool round step for plugin attachments: the data-URI scrub of the
 * plugin body, {@link processToolAttachments} with the blob store and the
 * media gate of the round, then {@link withAttachments}.
 *
 * @param o - The lifted (and clamped) plugin outcome.
 * @param attachments - `attachments` of the plugin `tool_result`. Absent or
 *   empty: `o` with no change, and no file or gate work.
 * @param ctx - The round values (only `blobStore`, `model`, `diagnostics`).
 * @param call - The values of the call.
 * @returns The new outcome.
 */
export async function addToolAttachments(
  o: ToolOutcome,
  attachments: ReadonlyArray<ToolAttachment | ToolAttachmentWire> | undefined,
  ctx: ToolAttachmentRoundContext,
  call: ToolAttachmentCall,
): Promise<ToolOutcome> {
  if (!Array.isArray(attachments) || attachments.length === 0) return o
  const store = ctx.blobStore?.config.enabled ? ctx.blobStore : null
  const maxBytes = Math.min(MAX_ATTACHMENT_BYTES, store?.config.maxBytesPerSession ?? Infinity)
  const r = await processToolAttachments({
    attachments,
    toolName: call.tool.name,
    toolUseId: call.tool.id,
    store,
    media: resolveToolMediaContext(ctx.model),
    text: call.text,
    sb: call.sb,
    maxBytes,
    onWriteError: (file) =>
      ctx.diagnostics?.warn("tool-attachment.write-failed", "", { tool: call.tool.name, file }),
  })
  return withAttachments(scrubPluginBody(o, call), r)
}

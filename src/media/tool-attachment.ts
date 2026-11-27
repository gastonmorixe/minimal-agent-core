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

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { ToolAttachment } from "../../plugin-api/src/types/plugin.ts"
import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ImageBlock } from "../llm/canonical-messages.ts"
import { type BlobStore, formatBytes, shortSha256 } from "../session/blob-store.ts"
import { renderCoreKind } from "../sideband/core-render.ts"
import type { SidebandApi } from "../sideband/types.ts"

import { mimeToKind, sniffMime } from "./probe.ts"
import { decideReadFile, type ReadFileMediaContext, unsupportedEmbeddingText } from "./read-file.ts"
import { resolveToolMediaContext } from "./tool-context.ts"

/** The maximum number of image blocks in one tool result. More images get a path line only. */
export const MAX_ATTACHMENT_IMAGES = 3

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
  /** The attachments of the plugin result. An entry whose `bytes` is not a `Uint8Array` is ignored. */
  readonly attachments: ReadonlyArray<ToolAttachment>
  /** The tool name, for the `tool` attr of the tag. */
  readonly toolName: string
  /** The tool use id. The file name is `<toolUseId>-<n>.<ext>`. */
  readonly toolUseId: string
  /**
   * The session blob directory (`BlobStore.dir`). `null`: no blob store, or
   * the store is off. Then core writes no file.
   */
  readonly blobDir: string | null
  /**
   * The media gate of the active model (`resolveToolMediaContext`).
   * `undefined` (an unknown model): no image block, a path line only.
   */
  readonly media: ReadFileMediaContext | undefined
  /** The synthetic text resolver for the gate texts. Default: no text. */
  readonly text?: SyntheticTextResolver
  /** The sideband API that renders the `binary-result` tag. */
  readonly sb: Pick<SidebandApi, "render">
  /** Called when a file write fails. The attachment then has no path. */
  readonly onWriteError?: (err: unknown, path: string) => void
}

/** What {@link processToolAttachments} gives. */
export interface ToolAttachmentResult {
  /** The model-facing lines, one group for each attachment, in order. Empty strings are left out. */
  readonly textLines: string[]
  /** The accepted image blocks, at most {@link MAX_ATTACHMENT_IMAGES}. */
  readonly media: ImageBlock[]
}

/** Only `[A-Za-z0-9_-]`, so a tool use id cannot leave the blob directory. */
function safeFileStem(id: string): string {
  const stem = id.replace(/[^A-Za-z0-9_-]/g, "_")
  return stem === "" ? "tool" : stem
}

/** Write one attachment. Gives the path, or `null` when not saved. Never throws. */
async function saveAttachment(
  input: ToolAttachmentInput,
  index: number,
  bytes: Uint8Array,
  ext: string,
): Promise<string | null> {
  if (input.blobDir === null || bytes.length === 0) return null
  const path = join(input.blobDir, `${safeFileStem(input.toolUseId)}-${index}.${ext}`)
  try {
    await mkdir(input.blobDir, { recursive: true })
    await writeFile(path, bytes)
    return path
  } catch (err) {
    input.onWriteError?.(err, path)
    return null
  }
}

/** The `binary-result` tag of one attachment ("" with no codec or no owner of the kind). */
function pointerTag(
  input: ToolAttachmentInput,
  mimeType: string,
  bytes: Uint8Array,
  path: string | null,
): string {
  const attrs: Record<string, string> = { mime: mimeType, size: formatBytes(bytes.length) }
  if (path !== null) {
    attrs.path = path
    attrs.sha256 = shortSha256(bytes)
  }
  attrs.tool = input.toolName
  return renderCoreKind(input.sb, "binary-result", { attrs })
}

/** The gate text of one attachment, and its image block when the gate accepts it. */
async function gateAttachment(
  input: ToolAttachmentInput,
  bytes: Uint8Array,
  mimeType: string,
  imageSlotFree: boolean,
): Promise<{ line: string; block?: ImageBlock }> {
  const text = input.text ?? EMPTY_SYNTHETIC_TEXT
  if (input.media === undefined) return { line: "" }
  // The cap is full: do not decode or resize an image that core will not send.
  if (mimeToKind(mimeType) === "image" && !imageSlotFree) return { line: "" }
  const decision = await decideReadFile(bytes, input.media, text)
  if (decision.kind === "image") return { line: decision.summary, block: decision.block }
  if (decision.kind === "rejected") return { line: decision.message }
  // Bytes with no known magic: tool output cannot carry them.
  return { line: unsupportedEmbeddingText(text, { mimeType, sizeBytes: bytes.length }) }
}

/**
 * Save each attachment in the session blob directory and send it through the
 * `Read` media gate.
 *
 * For each attachment, in order:
 * 1. Write the bytes to `<blobDir>/<toolUseId>-<n>.<ext>` (`n` from 1, the
 *    extension from the sniffed MIME type, else `bin`). With no blob
 *    directory, or on a write error, there is no file and no `path` attr.
 * 2. Accepted image (while fewer than {@link MAX_ATTACHMENT_IMAGES}): the
 *    image block, and the `tool_text.Read.image_summary` caption.
 * 3. Rejected (no image modality, too large, a PDF, audio, video, unknown
 *    bytes): the rejection text of the gate.
 * 4. No media context, or the image cap is full: no gate text.
 * 5. Always: the `binary-result` tag with the MIME type, size, path and tool.
 *
 * @param input - The attachments and the context of the call.
 * @returns The text lines and the accepted image blocks.
 */
export async function processToolAttachments(
  input: ToolAttachmentInput,
): Promise<ToolAttachmentResult> {
  const textLines: string[] = []
  const media: ImageBlock[] = []
  let index = 0
  for (const att of input.attachments) {
    if (!(att?.bytes instanceof Uint8Array)) continue
    index++
    const sniffed = sniffMime(att.bytes)
    const mimeType = sniffed === UNKNOWN_MIME && att.mimeType ? att.mimeType : sniffed
    const path = await saveAttachment(input, index, att.bytes, attachmentExtension(sniffed))
    const slotFree = media.length < MAX_ATTACHMENT_IMAGES
    const gated = await gateAttachment(input, att.bytes, sniffed, slotFree)
    if (gated.block) media.push(gated.block)
    const group = [gated.line, pointerTag(input, mimeType, att.bytes, path)]
      .filter((t) => t !== "")
      .join("\n")
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

/** The part of the tool round context that {@link addToolAttachments} reads. */
export interface ToolAttachmentRoundContext {
  /** The session blob store. `null`, or a store that is off: no file. */
  readonly blobStore: Pick<BlobStore, "dir" | "config"> | null
  /** The active model id. The media gate comes from `resolveToolMediaContext`. */
  readonly model: string
  /** The tool call. */
  readonly tool: { readonly id: string; readonly name: string }
  /** The synthetic text resolver of the round. */
  readonly text: SyntheticTextResolver
  /** The sideband API of the round. */
  readonly sb: Pick<SidebandApi, "render">
  /** Gets `tool-attachment.write-failed` when a file write fails. */
  readonly diagnostics?: Pick<Diagnostics, "warn"> | undefined
}

/**
 * The tool round step for plugin attachments: {@link processToolAttachments}
 * with the blob dir and the media gate of the round, then
 * {@link withAttachments}.
 *
 * @param o - The lifted (and clamped) plugin outcome.
 * @param attachments - `attachments` of the plugin `tool_result`. Absent or
 *   empty: `o` with no change, and no file or gate work.
 * @param ctx - The round values.
 * @returns The new outcome.
 */
export async function addToolAttachments(
  o: ToolOutcome,
  attachments: ReadonlyArray<ToolAttachment> | undefined,
  ctx: ToolAttachmentRoundContext,
): Promise<ToolOutcome> {
  if (!Array.isArray(attachments) || attachments.length === 0) return o
  const store = ctx.blobStore
  const r = await processToolAttachments({
    attachments,
    toolName: ctx.tool.name,
    toolUseId: ctx.tool.id,
    blobDir: store?.config.enabled ? store.dir : null,
    media: resolveToolMediaContext(ctx.model),
    text: ctx.text,
    sb: ctx.sb,
    onWriteError: (err, path) =>
      ctx.diagnostics?.warn("tool-attachment.write-failed", "", {
        tool: ctx.tool.name,
        path,
        detail: err instanceof Error ? err.message : String(err),
      }),
  })
  return withAttachments(o, r)
}

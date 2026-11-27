/**
 * Move the media of a `tool_result` out of the tool result, for an encoder
 * whose wire tool result takes only text (OpenAI Chat and its gateways).
 *
 * A canonical `tool_result` can hold `[TextBlock, ImageBlock, ...]`. The
 * Anthropic encoder sends that as is. A Chat-shaped encoder sends a tool
 * message with a text body only, so an image in it is lost. This module keeps
 * the image: it puts a text marker in the tool result and moves the image to
 * the same message, after its tool results. The encoder then sends the moved
 * blocks in a user message after all the tool messages.
 *
 * Rules:
 * - Pure. The input is not changed. When no message changes, the result is
 *   the same array object.
 * - In each changed message, a media block of a tool result becomes a text
 *   marker ({@link TOOL_RESULT_MEDIA_TEXT}.marker). The number counts across
 *   the message, from 1.
 * - After the last `tool_result` of the message, and before the other
 *   blocks of the message, the module adds one label text block for each
 *   tool result with media, then the media blocks of that tool result.
 * - A changed tool result keeps its id, its `isError` flag and its other
 *   keys.
 * - A run of consecutive `role:"tool"` messages is one group. Each message
 *   keeps its text blocks, and a marker replaces each media block. The
 *   numbers count across the run, from 1. One new `role:"user"` message
 *   comes after the LAST message of the run. It holds one label and the
 *   media for each tool message that had media, in order. OpenAI Chat and
 *   Ollama reject a user message between the tool messages of one turn.
 * - The marker names the block kind (image, audio, video, file). The label
 *   holds the tool id cut to `[A-Za-z0-9_-]` (64 chars max), or `unknown`.
 *
 * Run it after the modality check: a model with no image input then has
 * placeholder text, not images, and this module has nothing to move.
 *
 * @module llm/tool-result-media
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  TextBlock,
  ToolResultContentBlock,
} from "./canonical-messages.ts"

/**
 * The text that the hoist writes. Tests and plugins match these forms.
 *
 * - `marker(n, kind)`: the text that replaces media block `n` in a tool
 *   result. `kind` is the block type, `image` by default.
 * - `label(id)`: the text before the moved media of tool result `id`. The id
 *   is cut to `A-Z a-z 0-9 _ -` (64 chars max) first, or `unknown`.
 */
export const TOOL_RESULT_MEDIA_TEXT = {
  marker: (n: number, kind: MediaKind = "image"): string =>
    `${kind} ${n} is attached after the tool results`,
  label: (toolUseId: string): string => `Images from tool result ${safeToolId(toolUseId)}:`,
} as const

/** The media kinds of a canonical block. */
export type MediaKind = "image" | "audio" | "video" | "file"

const MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>(["image", "audio", "video", "file"])

/** The maximum length of the tool id in a label. */
const MAX_LABEL_ID_CHARS = 64

function isMedia(block: { type: string }): block is { type: MediaKind } {
  return MEDIA_KINDS.has(block.type)
}

/**
 * The tool id for a label: only `A-Z a-z 0-9 _ -`, max 64 chars. A tool id
 * comes from the model or a plugin, so the label must not carry other text.
 *
 * @param id - The raw tool id.
 * @returns The safe id, or `unknown` when nothing is left.
 */
function safeToolId(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_LABEL_ID_CHARS)
  return safe.length > 0 ? safe : "unknown"
}

/**
 * Move the media of each `tool_result` to the end of the tool results of its
 * message, with a text marker in its place. See the module doc for the rules.
 *
 * @param messages - The canonical messages. Not changed.
 * @returns The same array when no message has tool result media, else a new
 *   array.
 */
export function hoistToolResultMedia(messages: readonly CanonicalMessage[]): CanonicalMessage[] {
  let out: CanonicalMessage[] | null = null
  let i = 0
  while (i < messages.length) {
    const msg = messages[i] as CanonicalMessage
    let end = i + 1
    if (msg.role === "tool") {
      while (end < messages.length && messages[end]?.role === "tool") end += 1
    }
    const group = messages.slice(i, end)
    const changed = msg.role === "tool" ? hoistToolRun(group) : hoistMessage(msg)
    if (changed === null) {
      if (out) out.push(...group)
    } else {
      if (!out) out = messages.slice(0, i)
      out.push(...changed)
    }
    i = end
  }
  return out ?? (messages as CanonicalMessage[])
}

/** One message with tool result media, changed. Null when it has none. */
function hoistMessage(msg: CanonicalMessage): CanonicalMessage[] | null {
  const hasMedia = msg.content.some(
    (b) => b.type === "tool_result" && b.content.some((c) => isMedia(c)),
  )
  if (!hasMedia) return null
  const results: CanonicalBlock[] = []
  const moved: CanonicalBlock[] = []
  const others: CanonicalBlock[] = []
  let n = 0
  for (const block of msg.content) {
    if (block.type !== "tool_result") {
      others.push(block)
      continue
    }
    if (!block.content.some((c) => isMedia(c))) {
      results.push(block)
      continue
    }
    const content: ToolResultContentBlock[] = []
    const media: CanonicalBlock[] = []
    for (const inner of block.content) {
      if (isMedia(inner)) {
        n += 1
        content.push({ type: "text", text: TOOL_RESULT_MEDIA_TEXT.marker(n, inner.type) })
        media.push(inner)
      } else {
        content.push(inner)
      }
    }
    results.push({ ...block, content })
    moved.push({ type: "text", text: TOOL_RESULT_MEDIA_TEXT.label(block.toolUseId) }, ...media)
  }
  return [{ ...msg, content: [...results, ...moved, ...others] }]
}

/**
 * A run of consecutive `role:"tool"` messages. The text stays, a marker
 * replaces each media block, and ONE user message after the last tool
 * message holds the labels and the media. Null when the run has no media.
 */
function hoistToolRun(run: readonly CanonicalMessage[]): CanonicalMessage[] | null {
  if (!run.some((m) => m.content.some((b) => isMedia(b)))) return null
  const tools: CanonicalMessage[] = []
  const moved: CanonicalBlock[] = []
  let n = 0
  for (const msg of run) {
    if (!msg.content.some((b) => isMedia(b))) {
      tools.push(msg)
      continue
    }
    const kept: CanonicalBlock[] = []
    const media: CanonicalBlock[] = []
    for (const block of msg.content) {
      if (isMedia(block)) {
        n += 1
        kept.push({ type: "text", text: TOOL_RESULT_MEDIA_TEXT.marker(n, block.type) })
        media.push(block)
      } else {
        kept.push(block)
      }
    }
    tools.push({ ...msg, content: kept })
    const label: TextBlock = {
      type: "text",
      text: TOOL_RESULT_MEDIA_TEXT.label(msg.toolCallId ?? "unknown"),
    }
    moved.push(label, ...media)
  }
  return [...tools, { role: "user", content: moved }]
}

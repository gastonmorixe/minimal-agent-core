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
 * - A `role:"tool"` message with media keeps its text blocks. Its media
 *   move to a new `role:"user"` message just after it, with one label.
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
 * - `marker(n)`: the text that replaces media block `n` in a tool result.
 * - `label(id)`: the text before the moved media of tool result `id`.
 */
export const TOOL_RESULT_MEDIA_TEXT = {
  marker: (n: number): string => `image ${n} is attached after the tool results`,
  label: (toolUseId: string): string => `Images from tool result ${toolUseId}:`,
} as const

/** The media kinds of a canonical block. */
type MediaKind = "image" | "audio" | "video" | "file"

const MEDIA_KINDS: ReadonlySet<string> = new Set<MediaKind>(["image", "audio", "video", "file"])

function isMedia(block: { type: string }): boolean {
  return MEDIA_KINDS.has(block.type)
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
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as CanonicalMessage
    const changed = msg.role === "tool" ? hoistToolMessage(msg) : hoistMessage(msg)
    if (changed === null) {
      if (out) out.push(msg)
      continue
    }
    if (!out) out = messages.slice(0, i)
    out.push(...changed)
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
        content.push({ type: "text", text: TOOL_RESULT_MEDIA_TEXT.marker(n) })
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

/** A `role:"tool"` message with media: text stays, media go to a user message. */
function hoistToolMessage(msg: CanonicalMessage): CanonicalMessage[] | null {
  if (!msg.content.some((b) => isMedia(b))) return null
  const kept: CanonicalBlock[] = []
  const media: CanonicalBlock[] = []
  let n = 0
  for (const block of msg.content) {
    if (isMedia(block)) {
      n += 1
      kept.push({ type: "text", text: TOOL_RESULT_MEDIA_TEXT.marker(n) })
      media.push(block)
    } else {
      kept.push(block)
    }
  }
  const label: TextBlock = { type: "text", text: TOOL_RESULT_MEDIA_TEXT.label(msg.toolCallId ?? "unknown") }
  return [
    { ...msg, content: kept },
    { role: "user", content: [label, ...media] },
  ]
}

/**
 * Visual replay of a hydrated message list into a scrollback sink.
 *
 * **Fidelity contract:** replay MUST be visually identical to what the
 * agent rendered live, byte-for-byte where possible. Same colors, same
 * tool transcript shape (`╭ … │ … ╰`), same thinking blocks, same
 * formatToolPreview output. NO dim wrapping anywhere — historical content
 * is rendered with the same vivid styling as new content. The only
 * concession to "this is history" is the resume header line (a single
 * dim `── resumed from <sid> (<n> messages, <model>) ──` separator),
 * because that's a structural marker, not content.
 *
 * Why no dimming on the body? Users want to scroll up and re-read prior
 * conversations as if the session never ended. Dimming hurts contrast,
 * hides syntax-highlighted code, and turns thinking summaries into
 * unreadable mush.
 *
 * Used by `--resume <sid>`: after `loadSession` reconstructs `messages`,
 * we want the user to see the prior conversation (text + thinking + tool
 * transcripts) before the resumed REPL prompt.
 */

import { c, formatToolInput, formatToolPreview, faintThinkingChunk } from "./agent.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"

/**
 * Sink shape: anything with a `write(string)`. The live-area REPL passes
 * `compositor.writeStream` here; the legacy REPL would pass `stdout.write`.
 */
export interface ReplaySink {
  write(s: string): unknown
}

/**
 * One-line dim header announcing the resume. This is the ONLY dim text
 * in the replay output — see the fidelity contract in the module docs.
 */
export function buildResumeHeader(opts: {
  sid: string
  turns: number
  model: string
  repaired?: boolean
  dropped?: number
}): string {
  const parts = [`${opts.turns} message${opts.turns === 1 ? "" : "s"}`, opts.model]
  if (opts.repaired) parts.push("repaired")
  if (opts.dropped && opts.dropped > 0) parts.push(`dropped ${opts.dropped}`)
  const meta = parts.join(", ")
  return `\n  ${c.dim("──")} ${c.dim(`resumed from ${opts.sid} (${meta})`)} ${c.dim("──")}\n\n`
}

/**
 * Replay a message list to the sink with full fidelity:
 *
 * - **User messages**: prompt prefix `❯ ` followed by the user's text in
 *   normal weight. Tool_result blocks are not rendered here — they appear
 *   under the assistant's tool_use header below.
 *
 * - **Assistant text blocks**: rendered plain (no dim).
 *
 * - **Assistant thinking blocks**: rendered using `faintThinkingChunk`
 *   (the same faint italic style live thinking uses), so historical
 *   thinking is visually identical to live thinking.
 *
 * - **Assistant tool_use blocks**: rendered as the live transcript
 *   `╭ ToolName  $ args ╰ output` shape, using the SAME `formatToolInput`
 *   + `formatToolPreview` helpers the live agent uses.
 */
export function replayToScrollback(messages: Message[], sink: ReplaySink): void {
  // Build a map of tool_use_id → tool_result block for fast lookup.
  const toolResultById = new Map<string, ToolResultBlock>()
  for (const msg of messages) {
    if (msg.role !== "user" || !Array.isArray(msg.content)) continue
    for (const b of msg.content) {
      if (b.type === "tool_result") {
        toolResultById.set((b as ToolResultBlock).tool_use_id, b as ToolResultBlock)
      }
    }
  }

  for (const msg of messages) {
    if (msg.role === "user") {
      // Skip user messages whose content is ONLY tool_results — those
      // are rendered under the corresponding assistant turn.
      const content = msg.content
      if (Array.isArray(content) && content.every((b) => b.type === "tool_result")) {
        continue
      }
      const text = stringifyUserText(content)
      if (text.length > 0) {
        // Live prompt arrow style: bold pink ❯ + plain text.
        sink.write(`${c.bold(c.pink("❯"))} ${text}\n\n`)
      }
      continue
    }

    // Assistant
    const blocks = Array.isArray(msg.content) ? msg.content : []
    let wroteAnyText = false
    for (const b of blocks) {
      if (b.type === "text") {
        sink.write(`${b.text}\n`)
        wroteAnyText = true
      } else if (b.type === "thinking") {
        // Live thinking renders via writeDirectSink + faintThinkingChunk
        // (faint italic). Use the same helper for byte-identical replay.
        const thinkingText = (b as { thinking?: string }).thinking ?? ""
        if (thinkingText.length > 0) {
          sink.write(`${faintThinkingChunk(thinkingText)}\n`)
          wroteAnyText = true
        }
      } else if (b.type === "tool_use") {
        const tu = b as ToolUseBlock
        // Live header: `\n  ╭ ✦ Tool  args` — match it verbatim.
        sink.write(`\n  ${c.dimCyan("╭")} ${c.bold(tu.name)}  ${c.dim(formatToolInput(tu))}\n`)
        const result = toolResultById.get(tu.id)
        if (result) {
          const content =
            typeof result.content === "string"
              ? result.content
              : result.content
                  .filter((rb): rb is Extract<ContentBlock, { type: "text" }> => rb.type === "text")
                  .map((rb) => rb.text)
                  .join("")
          for (const line of formatToolPreview(content, !!result.is_error)) {
            sink.write(`${line}\n`)
          }
        } else {
          sink.write(`  ${c.dimCyan("╰")} ${c.dim("(no result on disk)")}\n`)
        }
      }
    }
    if (wroteAnyText) sink.write("\n")
  }
}

function stringifyUserText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  return content
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join(" ")
    .trim()
}

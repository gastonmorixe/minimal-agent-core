/**
 * Visual replay of a hydrated message list into a scrollback sink.
 *
 * Used by `--resume <sid>`: after `loadSession` reconstructs `messages`,
 * we want the user to see the prior conversation (text + tool transcripts)
 * before the resumed REPL prompt. Without this, resume hydrates state
 * silently and the user stares at an empty pane wondering whether
 * anything was loaded.
 *
 * The output uses the SAME helpers (`formatToolInput`, `formatToolPreview`)
 * as live turns, so replayed content is visually identical to what the
 * agent would have rendered originally — just dimmed slightly via a
 * leading dim header so the user can tell "this is history, not new".
 *
 * Kept in its own module (rather than `session-restore.ts`) because it
 * imports from `agent.ts` for the formatters; `session-restore.ts` stays
 * a pure data-only module that's safe for tests/tools to import without
 * pulling in the whole agent stack.
 */

import { c, formatToolInput, formatToolPreview } from "./agent.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"

/**
 * Sink shape: anything with a `write(string)`. The live-area REPL passes
 * `compositor.writeStream` here; the legacy REPL would pass `stdout.write`.
 */
export interface ReplaySink {
  write(s: string): unknown
}

/**
 * Render a one-line dim header announcing the resume.
 */
export function buildResumeHeader(opts: {
  sid: string
  turns: number
  model: string
  repaired?: boolean
  dropped?: number
}): string {
  const parts = [
    `${opts.turns} message${opts.turns === 1 ? "" : "s"}`,
    opts.model,
  ]
  if (opts.repaired) parts.push("repaired")
  if (opts.dropped && opts.dropped > 0) parts.push(`dropped ${opts.dropped}`)
  const meta = parts.join(", ")
  return `\n  ${c.dim("──")} ${c.dim(`resumed from ${opts.sid} (${meta})`)} ${c.dim("──")}\n\n`
}

/**
 * Replay a message list to the sink. Each message is rendered to look
 * like the live turn that produced it:
 *
 * - User messages: shown as a dim block with the user prompt prefix `❯`.
 *   String and `text` blocks are concatenated. `tool_result` blocks are
 *   rendered using the SAME `formatToolPreview` connector style as live —
 *   but they appear UNDER the assistant turn that produced the matching
 *   `tool_use`, not under the user message they're technically part of.
 *   To keep the replay readable, we render the tool_use header and its
 *   matching tool_result preview together as a single grouped block.
 *
 * - Assistant messages: text blocks rendered plainly; `tool_use` blocks
 *   rendered as a header `╭ ToolName  $ args`. The matching `tool_result`
 *   from the next user message is found and its preview rendered under
 *   the header, mirroring `Agent.run`'s live transcript shape.
 */
export function replayToScrollback(messages: Message[], sink: ReplaySink): void {
  // Build a map of tool_use_id → tool_result block for fast lookup. We
  // walk all user messages once.
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
      // Skip user messages whose content is ONLY tool_results — those are
      // rendered under the corresponding assistant turn.
      const content = msg.content
      if (Array.isArray(content) && content.every((b) => b.type === "tool_result")) {
        continue
      }
      // Otherwise render the user prompt with the same arrow we use live.
      const text = stringifyUserText(content)
      if (text.length > 0) {
        sink.write(`${c.bold(c.pink("❯"))} ${c.dim(text)}\n\n`)
      }
      continue
    }

    // Assistant
    const blocks = Array.isArray(msg.content) ? msg.content : []
    let wroteAnyText = false
    for (const b of blocks) {
      if (b.type === "text") {
        // Replayed text is dimmed so the eye can tell history from new.
        sink.write(`${c.dim(b.text)}\n`)
        wroteAnyText = true
      } else if (b.type === "tool_use") {
        const tu = b as ToolUseBlock
        sink.write(
          `\n  ${c.dimCyan("╭")} ${c.bold(c.dim(tu.name))}  ${c.dim(formatToolInput(tu))}\n`,
        )
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
      // thinking blocks intentionally skipped — too verbose for replay,
      // and they're already-completed reasoning the user doesn't need to
      // re-read.
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

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

import {
  c,
  faintThinkingChunk,
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
} from "./agent.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import { Formatter } from "./formatter.ts"
import type { ModeManager } from "./modes.ts"

/**
 * Sink shape: anything with a `write(string)`. The live-area REPL passes
 * `compositor.writeStream` here; the legacy REPL would pass `stdout.write`.
 */
export interface ReplaySink {
  write(s: string): unknown
}

/**
 * Optional per-call options for {@link replayToScrollback}.
 */
export interface ReplayOptions {
  /**
   * If provided, used to render the prompt prefix for each replayed user
   * turn (so a turn submitted under `ASK` mode displays `ASK ❯` in
   * scrollback, matching what the live REPL drew). When omitted, all
   * replayed turns use the bare `❯ ` arrow regardless of any
   * `<mode-change>` activation blocks recorded in the log.
   *
   * The activation blocks themselves are ALWAYS stripped from the
   * rendered text — they are a transport detail for the model, not
   * user-visible content — even when no `modeManager` is supplied.
   */
  modeManager?: ModeManager | null

  /**
   * If provided, assistant `text` and `thinking` blocks are piped through
   * a freshly-spawned {@link Formatter} subprocess (typically `mdstream`)
   * so markdown renders the same way the live REPL renders it. When
   * omitted, text blocks are written raw (the historical behavior).
   *
   * One formatter is spawned per text block (and per thinking block),
   * mirroring the live agent's per-text-block `onTextStop` boundary so
   * each block starts with mdstream's `partial` paragraph buffer empty.
   * Without this boundary, two text blocks in one assistant turn would
   * be smashed together at end-of-render — see memory `#mp0pnjih-16b0`.
   */
  formatterCmd?: string[]
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
 * - **User messages**: prompt prefix `❯ ` (or the per-mode prefix such
 *   as `ASK ❯` when `opts.modeManager` is supplied and the turn carried
 *   a `<mode-change from=… to=… />` activation block) followed by the
 *   user's text in normal weight. The activation block itself is always
 *   stripped from the rendered text — it is a transport detail, not
 *   user-visible content. Tool_result blocks are not rendered here —
 *   they appear under the assistant's tool_use header below.
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
 *
 * @param messages - Hydrated message list (typically `loadSession(...).messages`).
 * @param sink - Anywhere with `write(string)`. See {@link ReplaySink}.
 * @param opts - Optional rendering knobs. See {@link ReplayOptions}.
 */
export async function replayToScrollback(
  messages: Message[],
  sink: ReplaySink,
  opts: ReplayOptions = {},
): Promise<void> {
  const baseArrow = `${c.bold(c.pink("❯"))} `
  const modeManager = opts.modeManager ?? null
  const formatterCmd = opts.formatterCmd
  // Wrap the sink as a `FormatterOutput` so a spawned Formatter can pipe
  // its rendered stdout back into the same scrollback target. `columns`
  // / `rows` come from the host stdout — `COLUMNS` is load-bearing for
  // mdstream ≥ 0.2.2 (see `formatterEnv` in src/formatter.ts), and
  // mdstream uses it to wrap paragraphs.
  const textFormatterOutput = formatterCmd ? makeFormatterOutput(sink, null) : null
  // Thinking output wraps each emitted chunk with `faintThinkingChunk`
  // (faint italic ANSI), mirroring the live agent's `thinkingOutput`
  // setup in src/agent.ts.
  const thinkingFormatterOutput = formatterCmd
    ? makeFormatterOutput(sink, faintThinkingChunk)
    : null
  // Tracks the mode the user was in when each message was submitted, by
  // walking <mode-change> activation blocks in order. Defaults to "no
  // mode" until a block flips it.
  let activeModeId: string | null = null

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
      const content = msg.content
      // Skip user messages whose content is ONLY tool_results (and/or a
      // `<mode-change>` activation block) — those have no user-visible
      // payload of their own. Tool results are rendered under the
      // corresponding assistant turn; the mode-change is consumed for
      // its side effect on the prompt prefix of LATER turns.
      if (
        Array.isArray(content) &&
        content.every((b) => b.type === "tool_result" || isModeChangeBlock(b))
      ) {
        for (const b of content) {
          const to = readModeChangeTo(b)
          if (to !== undefined) activeModeId = to === "default" ? null : to
        }
        continue
      }
      const { text, modeAfter } = stringifyUserText(content, activeModeId)
      activeModeId = modeAfter
      if (text.length > 0) {
        const arrow = modeManager
          ? modeManager.promptPrefixForId(activeModeId, baseArrow)
          : baseArrow
        sink.write(`${arrow}${text}\n\n`)
      }
      continue
    }

    // Assistant
    const blocks = Array.isArray(msg.content) ? msg.content : []
    let wroteAnyText = false
    for (const b of blocks) {
      if (b.type === "text") {
        if (b.text.length === 0) continue
        if (formatterCmd && textFormatterOutput) {
          // Per-text-block formatter cycle: spawn → write → end (await
          // drain). End-and-respawn at every text-block boundary mirrors
          // the live agent's `onTextStop` callback (see `agent.ts`
          // `spawnMainFormatter`) — without it, two adjacent text blocks
          // would share one mdstream `partial` buffer and get smashed
          // together by `finish()`'s erase_partial + render_line on EOF.
          // mdstream's natural trailing `\n` provides the line-end. The
          // outer `if (wroteAnyText) sink.write("\n")` below provides
          // the blank-line separator between turns.
          const f = new Formatter(formatterCmd, textFormatterOutput)
          f.start()
          f.write(b.text)
          await f.end()
        } else {
          sink.write(`${b.text}\n`)
        }
        wroteAnyText = true
      } else if (b.type === "thinking") {
        // Live thinking renders via writeDirectSink + faintThinkingChunk
        // (faint italic). When a formatter is configured the live agent
        // pipes thinking through it too (see `ensureThinkingFormatter`
        // in src/agent.ts), with each emitted chunk wrapped by
        // `faintThinkingChunk`. Mirror both paths for byte-identical
        // replay.
        const thinkingText = (b as { thinking?: string }).thinking ?? ""
        if (thinkingText.length === 0) continue
        if (formatterCmd && thinkingFormatterOutput) {
          const f = new Formatter(formatterCmd, thinkingFormatterOutput)
          f.start()
          f.write(thinkingText)
          await f.end()
          // Live `onThinkingStop` writes a trailing `\n` for breathing
          // room between the thinking block and whatever follows.
          sink.write("\n")
        } else {
          sink.write(`${faintThinkingChunk(thinkingText)}\n`)
        }
        wroteAnyText = true
      } else if (b.type === "tool_use") {
        const tu = b as ToolUseBlock
        // Live header: `\n  ╭ ✦ Tool  args` — match it verbatim.
        // Pass live terminal width so soft-split (overflowing single-line
        // Bash → `↳ <op> <body>` rows) activates the same way it does in
        // the live agent. See `src/bash-split.ts`.
        const replayCols = process.stdout.columns
        sink.write(
          `\n  ${c.dimCyan("╭")} ${c.bold(tu.name)}  ${c.dim(formatToolInput(tu, replayCols))}\n`,
        )
        // Continuation rows: `> <line>` for `\n`-separated multi-line,
        // `↳ <op> <body>` for soft-split single-line overflow.
        for (const cont of formatToolInputContinuation(tu, replayCols)) {
          sink.write(`  ${c.dimCyan("│")} ${c.dim(cont)}\n`)
        }
        // Header→body separator (mirrors live agent rendering: the empty
        // gutter row that sits between the tool header and the first
        // body line, giving every tool block a consistent visual shape).
        // Always solid `│` in replay : the live agent reserves the dashed
        // `┊` for bodies that start mid-source (Read with `offset > 0`),
        // derived from runtime `truncInfo.startLine`. That field isn't
        // persisted in the JSONL store, so replay can't reconstruct it
        // and falls back to the default glyph. End-of-body truncation
        // footers are similarly absent from replay (see formatToolPreview
        // call below : we pass `info: undefined`).
        sink.write(`  ${c.dimCyan("│")}\n`)
        const result = toolResultById.get(tu.id)
        if (result) {
          const content =
            typeof result.content === "string"
              ? result.content
              : result.content
                  .filter((rb): rb is Extract<ContentBlock, { type: "text" }> => rb.type === "text")
                  .map((rb) => rb.text)
                  .join("")
          // Replay does not have access to the live `_truncInfo` (it was
          // never persisted in the JSONL — it's a per-render artifact).
          // We pass `tool: tu.name` so the per-tool body line budget still
          // applies; truncation footers are not reconstructed at replay.
          // The trailing `[truncated: ...]` notice in `content` is still
          // stripped from the displayed body by `formatToolPreview` since
          // it scans for the magic prefix.
          for (const line of formatToolPreview(content, !!result.is_error, undefined, {
            tool: tu.name,
          })) {
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

/**
 * Build a `FormatterOutput`-shaped wrapper around a {@link ReplaySink}
 * so a spawned {@link Formatter} can route its rendered stdout back
 * into the replay sink. The optional `wrap` callback is applied to
 * every emitted chunk before writing — used by the thinking path to
 * apply `faintThinkingChunk`'s faint+italic ANSI codes.
 *
 * Column/row hints come live from `process.stdout` so that, on
 * mid-replay terminal resize, a later spawn sees the new dimensions.
 * mdstream consumes these via the `COLUMNS`/`LINES` env (see
 * `formatterEnv` in src/formatter.ts).
 */
function makeFormatterOutput(
  sink: ReplaySink,
  wrap: ((s: string) => string) | null,
): Pick<NodeJS.WriteStream, "write"> & { columns?: number; rows?: number } {
  const decoder = new TextDecoder()
  return {
    get columns() {
      return process.stdout.columns
    },
    get rows() {
      return process.stdout.rows
    },
    write: ((chunk: string | Uint8Array): boolean => {
      const s = typeof chunk === "string" ? chunk : decoder.decode(chunk)
      sink.write(wrap ? wrap(s) : s)
      return true
    }) as NodeJS.WriteStream["write"],
  }
}

/**
 * Match a `<mode-change from=… to=… />` activation block exactly as
 * written by `ModeManager.consumePendingAttachment`. The block is always
 * emitted as a self-contained text block (one per user turn), so an
 * exact whole-string match is sufficient — no inline parsing needed.
 */
const MODE_CHANGE_RE = /^\s*<mode-change\s+from="([^"]*)"\s+to="([^"]*)"\s*\/>\s*$/

/**
 * True iff `b` is a text content block holding ONLY a mode-change
 * activation tag (and possibly surrounding whitespace).
 */
function isModeChangeBlock(b: ContentBlock): boolean {
  return b.type === "text" && MODE_CHANGE_RE.test(b.text)
}

/**
 * If `b` is a mode-change activation block, return its `to=` value
 * (`"ask"`, `"default"`, …). Otherwise return `undefined`.
 */
function readModeChangeTo(b: ContentBlock): string | undefined {
  if (b.type !== "text") return undefined
  const m = b.text.match(MODE_CHANGE_RE)
  return m ? m[2] : undefined
}

/**
 * Extract user-visible text from a user message's content array, while
 * threading the active mode forward across `<mode-change>` activation
 * blocks. Returns the visible text plus the resulting mode id (or
 * `null` for "no mode active").
 *
 * @param content - The message's content (string or block array).
 * @param initialModeId - Mode id active at the START of this message,
 *   carried over from earlier turns.
 */
function stringifyUserText(
  content: string | ContentBlock[],
  initialModeId: string | null,
): { text: string; modeAfter: string | null } {
  if (typeof content === "string") return { text: content, modeAfter: initialModeId }
  let modeAfter = initialModeId
  const parts: string[] = []
  for (const b of content) {
    if (b.type !== "text") continue
    const to = readModeChangeTo(b)
    if (to !== undefined) {
      modeAfter = to === "default" ? null : to
      continue
    }
    parts.push(b.text)
  }
  return { text: parts.join(" ").trim(), modeAfter }
}

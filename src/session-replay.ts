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
  clampTranscriptRow,
  faintThinkingChunk,
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
  toolContinuationIndentCells,
} from "./agent.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "./client.ts"
import { Formatter } from "./formatter.ts"
import { buildModeChangeChip, type ChipRenderInput } from "./mode-change-chip.ts"
import type { ModeManager } from "./modes.ts"
import { deriveDisplayFallback, type ReplaySidecarTask } from "./session-replay-derivers.ts"
import type { SessionRecord } from "./session-store.ts"
import { displayWidth } from "./term-width.ts"
import type { ToolTimeTracker } from "./tool-time.ts"

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

  /**
   * Optional time-hint tracker shared with the live Agent. When provided
   * AND `toolStartTimes` is also provided, every tool_use header gets
   * the same dim ` · <time>` suffix the live agent draws. The tracker
   * is mutated in-place as replay walks the message list, so the LIVE
   * agent's first header inherits the day-state and only re-emits the
   * date prefix on actual rollover. See `src/tool-time.ts`.
   */
  toolTimeTracker?: ToolTimeTracker | null

  /**
   * Optional `tool_use_id → epoch ms` lookup for the time-hint suffix.
   * The agent doesn't persist a dedicated `startedAt` field, so callers
   * derive this from the parsed JSONL records (each AssistantRecord's
   * `ts` is the time the assistant message containing the tool_use
   * arrived; that approximates the moment the live REPL drew the header).
   * When omitted, no time hint is appended even if `toolTimeTracker` is set.
   */
  toolStartTimes?: Map<string, number> | null

  /**
   * Optional per-message timestamps, parallel to {@link messages}. Used
   * by the mode-change chip renderer to stamp each historical toggle
   * with the date+time it actually took effect (specifically, when the
   * user pressed Enter on the message that flushed the toggle to the
   * model). The chip is rendered as
   * `  · ✦ mode →  ASK   2026-05-22 17:52  from default`.
   *
   * Indices where the timestamp is unknown (or the message is not a
   * user message) should be `null`. When the array is omitted entirely
   * OR when the relevant index is `null`, the mode-change chip falls
   * back to a "(historical)" stamp WITHOUT a date : the toggle is
   * still announced visually, just without the time.
   *
   * Production callers (`src/index.ts`) build this from the session
   * store's UserRecord `ts` values via {@link userTimestampsFromRecords}.
   */
  userTimestamps?: readonly (Date | null)[]

  /**
   * Optional `tool_use_id → display overrides` lookup. When present,
   * replay reproduces the LIVE transcript's plugin-driven body
   * (`display`), header content slot (`displayHeader`), and footer row
   * (`displayFooter`) instead of falling back to the default `content`
   * + JSON-args path. Without this, an Edit's unified diff regresses
   * to its model-facing `"File edited: ..."` text, and a Task tool
   * call regresses to its raw JSON args + truncated body : both bugs
   * the snapshot-driven repro caught.
   *
   * Production callers build this from `loaded.records` via
   * {@link toolDisplaysFromRecords}.
   */
  toolDisplays?: Map<
    string,
    { display?: string; displayHeader?: string; displayFooter?: string }
  > | null

  /**
   * Optional `tool_name → {icon, color}` map used to draw the live
   * agent's cosmetic prefix (`» Bash`, `✦ Edit`, `✔ Task`) on the
   * replayed `╭` header row. Both built-in tools (from
   * `TOOL_DEFINITIONS`) and plugin tools (from
   * `PluginLoader.getExtraTools`) populate this in the live agent;
   * production callers (`src/index.ts`) merge the two sources and
   * pass the result here. Without it, replay falls back to the bare
   * bold tool name in the default orange (the historical behavior).
   *
   * `color` keys into the same palette `c.*` in `src/agent.ts` uses
   * (e.g. `"orange"`, `"gold"`, `"lime"`); unknown values fall back
   * to orange, matching the live agent.
   */
  toolPresentation?: Map<string, { icon?: string; color?: string; headerKey?: string }> | null
}

/**
 * One-line dim header announcing the resume. This is the ONLY dim text
 * in the replay output — see the fidelity contract in the module docs.
 *
 * Returns `  ── resumed from <sid> (...) ──\n\n` with NO leading `\n`.
 * The caller is responsible for spacing above the header. When the
 * ready banner (`src/ready-banner.ts`) is written immediately before
 * this, its trailing `\n\n` already provides the blank row of breathing
 * room : adding another `\n` here would compound into two blank rows.
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
  return `  ${c.dim("──")} ${c.dim(`resumed from ${opts.sid} (${meta})`)} ${c.dim("──")}\n\n`
}

/**
 * Replay a message list to the sink with full fidelity:
 *
 * - **User messages**: prompt prefix `❯ ` (or the per-mode prefix such
 *   as `ASK ❯` when `opts.modeManager` is supplied and the turn carried
 *   a `<mode-change from=… to=… at=… />` activation block) followed by the
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
  const toolTimeTracker = opts.toolTimeTracker ?? null
  const toolStartTimes = opts.toolStartTimes ?? null
  const userTimestamps = opts.userTimestamps ?? null
  const toolDisplays = opts.toolDisplays ?? null
  const toolPresentation = opts.toolPresentation ?? null

  /**
   * Emit a mode-change chip to the sink for the given transition. Uses
   * the modeManager (when present) to resolve target colors and labels,
   * falling back to dim/uppercased-id labels otherwise. Pure write : no
   * side effects on the manager.
   */
  const emitModeChangeChip = (from: string, to: string, at: Date | null): void => {
    const fromId = from === "default" ? null : from
    const toId = to === "default" ? null : to
    const fromMode = modeManager?.modeById(fromId) ?? null
    const toMode = modeManager?.modeById(toId) ?? null
    const fromLabel = fromMode?.label ?? (fromId ? fromId.toUpperCase() : "default")
    const toLabel = toMode?.label ?? (toId ? toId.toUpperCase() : "default")
    const fromFgOpen = modeManager?.resolvedForId(fromId)?.label.fgOpen ?? null
    const toFgOpen = modeManager?.resolvedForId(toId)?.label.fgOpen ?? null
    // When the user-record timestamp is unknown, fall back to the Unix
    // epoch so the chip still renders with a (clearly-wrong-looking)
    // date. The alternative was a "(historical)" placeholder, but a
    // visible 1970-01-01 makes "we lost the timestamp" obvious to the
    // operator instead of looking like the chip is hiding info. In
    // practice every user record carries a `ts` so this branch is rare.
    const chipInput: ChipRenderInput = {
      fromLabel,
      toLabel,
      fromFgOpen,
      toFgOpen,
      at: at ?? new Date(0),
    }
    sink.write(`${buildModeChangeChip(chipInput)}\n\n`)
  }
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

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    const msgTs = userTimestamps?.[i] ?? null
    if (msg.role === "user") {
      const content = msg.content
      // Skip user messages whose content is ONLY tool_results and/or
      // runtime-injected attachment blocks (mode-change,
      // <ma::plugin::*>, <ma::agent::*>, plus the legacy bare forms
      // memory-saved). None of those have a user-visible payload of
      // their own : tool_results render under the corresponding
      // assistant turn, and runtime attachments are a model-only
      // transport detail. The mode-change block is also consumed here
      // for its side effect on the prompt prefix of LATER turns AND
      // emits a scrollback chip so the historical toggle is visible
      // on `--resume` exactly as it was when live.
      if (
        Array.isArray(content) &&
        content.every((b) => b.type === "tool_result" || isRuntimeAttachmentBlock(b))
      ) {
        for (const b of content) {
          const change = readModeChangeFromTo(b)
          if (change !== undefined) {
            emitModeChangeChip(change.from, change.to, msgTs)
            activeModeId = change.to === "default" ? null : change.to
          }
        }
        continue
      }
      // Mode-change blocks inside a user message that ALSO carries text
      // get rendered FIRST (chip above the prompt arrow) before the
      // user text itself : the toggle took effect just before the user
      // typed the prompt, so visually it belongs above the `❯`.
      if (Array.isArray(content)) {
        for (const b of content) {
          const change = readModeChangeFromTo(b)
          if (change !== undefined) emitModeChangeChip(change.from, change.to, msgTs)
        }
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
        // Live header: `\n  ╭ ✦ Tool  args [· <time>]` — match it verbatim.
        // Pass live terminal width so soft-split (overflowing single-line
        // Bash → `↳ <op> <body>` rows) activates the same way it does in
        // the live agent. See `src/bash-split.ts`.
        const replayCols = process.stdout.columns
        // Time-hint suffix mirrors writeToolHeader in src/agent.ts. The
        // startedAt comes from the AssistantRecord that originally wrote
        // this tool_use block (caller-supplied via `toolStartTimes`); we
        // can only render the suffix when both the lookup AND the shared
        // tracker are present, so a non-resume call (no records loaded)
        // and an old-format call (no tracker injected) both no-op cleanly.
        const startedAt = toolStartTimes?.get(tu.id)
        const timeText =
          toolTimeTracker !== null && startedAt !== undefined
            ? toolTimeTracker.format(startedAt)
            : undefined
        const timeSuffix = timeText !== undefined ? ` · ${timeText}` : ""
        const TIME_HINT_GUTTER = 2
        const adjustedCols =
          replayCols !== undefined && timeSuffix.length > 0
            ? Math.max(20, replayCols - displayWidth(timeSuffix) - TIME_HINT_GUTTER)
            : replayCols
        const dimTimeSuffix = timeSuffix.length > 0 ? c.dim(timeSuffix) : ""
        // Resolve icon + label color from the optional presentation map.
        // The live agent does the same via `pres = toolPresentation.get(tool.name)`
        // (built from TOOL_DEFINITIONS + plugin manifests). Falls back to
        // orange + no-icon when the caller didn't supply a map, which
        // preserves byte-identical output for old tests that don't pass it.
        const pres = toolPresentation?.get(tu.name) ?? null
        const labelColor =
          pres?.color && (c as Record<string, (s: string) => string>)[pres.color]
            ? (c as Record<string, (s: string) => string>)[pres.color]
            : c.orange
        const iconText = pres?.icon ? `${c.bold(labelColor(pres.icon))} ` : ""
        const label = c.bold(labelColor(tu.name))
        // Header content slot: prefer the persisted `displayHeader` (plugin
        // override, e.g. the tasks plugin's `✔ ALL DONE · 39/39 · ...`)
        // when present. Otherwise the default `formatToolInput` summary
        // (JSON args / Bash command preview), matching live behavior.
        // When `displayHeader` is in effect we skip the soft-split
        // continuation rows : the plugin owns the header rendering
        // entirely, same as the live agent (`writeToolHeader(override)`).
        const result = toolResultById.get(tu.id)
        const displays = toolDisplays?.get(tu.id) ?? null
        const headerOverride = displays?.displayHeader
        const headerContent =
          headerOverride !== undefined
            ? headerOverride
            : c.dim(formatToolInput(tu, adjustedCols, pres?.headerKey))
        const headerLine =
          headerContent.length === 0
            ? `${iconText}${label}${dimTimeSuffix}`
            : `${iconText}${label}  ${headerContent}${dimTimeSuffix}`
        // Outer-row clamp catches header overflow at narrow terminal
        // widths : see {@link clampTranscriptRow} in src/agent.ts.
        sink.write(`\n${clampTranscriptRow(`  ${c.dimCyan("╭")} ${headerLine}`, replayCols)}\n`)
        if (headerOverride === undefined) {
          // Continuation rows: `> <line>` for `\n`-separated multi-line,
          // `↳ <op> <body>` for soft-split single-line overflow. Indented
          // so the sigil aligns directly under the start of the command
          // body in the header. Pass the icon (when present) so the
          // indent matches the live agent's wider indent on iconned rows.
          const contIndent = " ".repeat(toolContinuationIndentCells(tu.name, pres?.icon))
          for (const cont of formatToolInputContinuation(tu, adjustedCols)) {
            const contRow = `  ${c.dimCyan("│")} ${contIndent}${c.dim(cont)}`
            sink.write(`${clampTranscriptRow(contRow, replayCols)}\n`)
          }
        }
        // Header→body separator (mirrors live agent rendering: the empty
        // `│` gutter row that sits between the tool header and the first
        // body line, giving every tool block a consistent visual shape).
        sink.write(`  ${c.dimCyan("│")}\n`)
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
          //
          // `cols: replayCols` forwards the live terminal width so the
          // per-line clamp activates the same way it does in the live
          // agent : a 200-cell body line in a 90-col terminal trims at
          // the visible width instead of soft-wrapping into the gutter.
          // Captured-at-block-start (NOT live-on-each-line) is correct
          // here : replay walks the whole transcript in one pass and
          // doesn't observe mid-replay resizes.
          //
          // `display` / `displayFooter` come from the persisted
          // presentation overrides : when present, formatToolPreview
          // renders the pre-built ANSI payload verbatim and uses our
          // footer (instead of computing one from a `_truncInfo` we
          // don't have on disk). This is what makes Edit's unified diff
          // and the tasks plugin's tree survive `--resume` intact.
          for (const line of formatToolPreview(content, !!result.is_error, displays?.display, {
            tool: tu.name,
            cols: replayCols,
            footer: displays?.displayFooter,
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
 * Match the mode-change activation block as written by
 * `ModeManager.consumePendingAttachment`. The block is always emitted
 * as a self-contained text block (one per user turn), so an exact
 * whole-string match is sufficient : no inline parsing needed.
 *
 * Accepts BOTH spellings during the tag-namespace migration
 * (TODOS.md#T-ca2ce1):
 *
 *   - new: `<ma::agent::mode-change from="…" to="…" at="…" />`
 *   - intermediate: `<ma::mode-change from="…" to="…" at="…" />`
 *   - legacy: `<mode-change from="…" to="…" at="…" />`
 *
 * The `at` attribute is optional in the regex so older session logs
 * (recorded before the timestamp was added) still replay cleanly.
 *
 * The `(?:ma::(?:agent::)?)?` non-capturing group makes both namespace
 * prefixes optional; all three forms produce identical capture-group
 * output.
 */
const MODE_CHANGE_RE =
  /^\s*<(?:ma::(?:agent::)?)?mode-change\s+from="([^"]*)"\s+to="([^"]*)"(?:\s+at="([^"]*)")?\s*\/>\s*$/

/**
 * Build the `userTimestamps` array for {@link replayToScrollback} from
 * the raw {@link SessionRecord}s a session file holds. The output is
 * parallel to the {@link Message}s that `foldRecords` produces : one
 * entry per message, populated with the source record's `ts` when
 * available and `null` otherwise.
 *
 * Folding rules (mirror of `foldRecords` in `src/session-restore.ts`):
 *
 * - `meta` / `note` records produce no message → skipped.
 * - `user` records produce one user message → ts copied.
 * - `assistant` records produce one assistant message → ts copied.
 * - `tool_result` records APPEND to the trailing user message if it's
 *   already a tool-block user; otherwise they START a new synthetic
 *   user message. We mirror that: append-case leaves the parent's ts
 *   alone (it's still the parent's submit time, which is what the chip
 *   wants anyway); start-case populates with the tool_result's ts.
 * - `rewind` records truncate the message list. We do the same to keep
 *   the indices aligned with the post-fold `messages[]`.
 *
 * Returns a fresh array. Pure : no I/O. Safe to call before / after
 * `foldRecords` with the same `records` input.
 */
/**
 * Build the `toolDisplays` map for {@link replayToScrollback} from raw
 * {@link SessionRecord}s. Two-source merge:
 *
 *  1. **Persisted overrides** (new sessions): each `tool_result` row
 *     carries `display` / `displayHeader` / `displayFooter` written
 *     by the live agent at `Store.appendToolResult` time. We index
 *     those verbatim by `tool_use_id`.
 *
 *  2. **Re-derived fallback** (pre-fix / unsupported sessions): for
 *     every `tool_result` row WITHOUT persisted overrides, we look up
 *     the matching `tool_use` block's input via `assistantToolUseIndex`
 *     and run {@link deriveDisplayFallback}. Today this covers `Task`
 *     (split content into header/body/footer), `Edit` (synthesize a
 *     unified diff from `old_string` / `new_string`), and `Write`
 *     (new-file diff from the content arg). Other tools land
 *     unchanged.
 *
 * Returns an empty map when no overrides were persisted AND no
 * re-derivable tools fired (e.g. a Bash-only session). Old logs render
 * the rich displays anyway because the deriver path picks them up.
 *
 * Pure: no I/O. Safe to call before / after {@link foldRecords}.
 */
export function toolDisplaysFromRecords(
  records: readonly SessionRecord[],
  opts?: {
    /**
     * Pre-parsed task list from the per-session `<sid>.tasks.jsonl`
     * sidecar (core-local structural slice — see
     * {@link ReplaySidecarTask}). Threaded into the loader-registered
     * tasks replay renderer so it can re-render the historical body
     * with the live agent's ANSI styling.
     *
     * When `null` / `undefined` (the test path, or the plugin absent),
     * the core Task deriver falls back to the structural content-split
     * path which preserves the tree shape but loses body colors.
     */
    sidecarTasks?: readonly ReplaySidecarTask[] | null
  },
): Map<string, { display?: string; displayHeader?: string; displayFooter?: string }> {
  const out = new Map<
    string,
    { display?: string; displayHeader?: string; displayFooter?: string }
  >()
  const sidecarTasks = opts?.sidecarTasks ?? null
  // Pass 1: index every assistant tool_use block so the fallback path
  // can look up its `name`, `input`, and `ts` by `tool_use_id`. The
  // persisted tool_result row only carries `content` + `isError`,
  // never the tool-name (the API's tool_result block shape is
  // name-less) or the historical wall-clock. The assistant `ts` is
  // the moment the model's tool_use arrived, which is the cutoff the
  // Task deriver needs for status snapshot reconstruction.
  const toolUseIndex = new Map<
    string,
    { name: string; input: Record<string, unknown>; ts: Date | null }
  >()
  for (const rec of records) {
    if (rec.kind !== "assistant") continue
    const ts = parseDate(rec.ts)
    for (const b of rec.content) {
      if (b.type !== "tool_use") continue
      const tu = b as ToolUseBlock
      toolUseIndex.set(tu.id, {
        name: tu.name,
        input: (tu.input ?? {}) as Record<string, unknown>,
        ts,
      })
    }
  }
  // Pass 2: walk tool_results, prefer persisted overrides, fall back
  // to the deriver. The two paths are mutually exclusive per row :
  // a row with even ONE persisted field bypasses the fallback (the
  // live agent owned that render, we don't try to second-guess).
  for (const rec of records) {
    if (rec.kind !== "tool_result") continue
    const hasOverride =
      rec.display !== undefined ||
      rec.displayHeader !== undefined ||
      rec.displayFooter !== undefined
    if (hasOverride) {
      const entry: { display?: string; displayHeader?: string; displayFooter?: string } = {}
      if (rec.display !== undefined) entry.display = rec.display
      if (rec.displayHeader !== undefined) entry.displayHeader = rec.displayHeader
      if (rec.displayFooter !== undefined) entry.displayFooter = rec.displayFooter
      out.set(rec.tool_use_id, entry)
      continue
    }
    const tu = toolUseIndex.get(rec.tool_use_id)
    if (!tu) continue
    const contentStr =
      typeof rec.content === "string"
        ? rec.content
        : rec.content
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("")
    const derived = deriveDisplayFallback({
      toolName: tu.name,
      input: tu.input,
      content: contentStr,
      isError: rec.isError,
      callTs: tu.ts,
      sidecarTasks,
    })
    if (derived !== undefined) out.set(rec.tool_use_id, derived)
  }
  return out
}

/**
 * Derives a per-message timestamp list aligned with the message array that
 * folding produces from the same records: one entry per user/assistant
 * message, `null` where a record carried no parseable `ts`. Honors `rewind`
 * records by truncating back to the rewound user message, and merges
 * consecutive tool-result user records the same way folding does so indexes
 * stay aligned.
 */
export function userTimestampsFromRecords(records: readonly SessionRecord[]): (Date | null)[] {
  const out: (Date | null)[] = []
  // Track which user-record ids we've already produced a message for,
  // so a `rewind` can truncate `out` to the matching offset.
  const userIdToIndex = new Map<string, number>()
  let lastMessageIsToolUser = false
  for (const rec of records) {
    switch (rec.kind) {
      case "meta":
      case "note":
        continue
      case "user": {
        out.push(parseDate(rec.ts))
        if (rec.id !== undefined) userIdToIndex.set(rec.id, out.length - 1)
        lastMessageIsToolUser =
          Array.isArray(rec.content) && rec.content.some((b) => b.type === "tool_result")
        continue
      }
      case "assistant":
        out.push(parseDate(rec.ts))
        lastMessageIsToolUser = false
        continue
      case "tool_result":
        if (lastMessageIsToolUser) {
          // Appends to the existing user message; no new index, ts of
          // the parent user record stays as the chip-relevant time.
          continue
        }
        // Starts a new synthetic user message.
        out.push(parseDate(rec.ts))
        lastMessageIsToolUser = true
        continue
      case "rewind": {
        const targetIdx = userIdToIndex.get(rec.to)
        if (targetIdx === undefined) continue
        out.length = targetIdx + 1
        // Prune the map; any id pointing past the kept range goes away.
        for (const [k, v] of userIdToIndex) if (v > targetIdx) userIdToIndex.delete(k)
        lastMessageIsToolUser = false
        continue
      }
      default:
        continue
    }
  }
  return out
}

function parseDate(ts: string): Date | null {
  if (!ts) return null
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return d
}

/**
 * Openers for the runtime-injected attachment blocks the agent
 * prepends to user messages (see `Agent.run` in `src/agent.ts`). When
 * a user-role text block starts with one of these, it has no
 * user-visible payload : it's a transport detail aimed at the model
 * (live context: tasks, scratchpad, save echoes, reflection
 * checkpoints, mode toggles) and must NOT be replayed verbatim into
 * the scrollback on `--resume`.
 *
 * The match is anchored at the start of the (trimmed) block. Each
 * attachment is emitted by the agent as its own dedicated text block
 * (verified at every push site in agent.ts), so a starts-with check
 * is sufficient : we don't need to validate the closing tag. A user
 * who pastes one of these openers as the FIRST non-whitespace of
 * their own prompt is the only false-positive scenario, which is
 * acceptable (they're typing a tag that, by convention, belongs to
 * the agent runtime, not the user).
 */
const RUNTIME_ATTACHMENT_OPENERS: readonly RegExp[] = [
  // New schema (canonical): every agent/plugin attachment opens with
  // `<ma::agent::*>` or `<ma::plugin::*>`. One regex covers them all.
  /^\s*<ma::(?:agent|plugin|plugins)::/i,
  // Bare `<ma::plugins>` system-prompt wrapper (also a legitimate
  // top-level emission, though it doesn't ride per-turn attachments).
  /^\s*<ma::plugins\b/,
  // Legacy forms accepted during the migration window so sessions
  // started before this refactor still resume cleanly. Drop these once
  // older session files are no longer in circulation.
  /^\s*<(?:ma::)?mode-change\b/,
  /^\s*<ma::(?:mode-active|reflection-checkpoint|reflection-ack|emergency-cap-triggered|tui-preview|tui::[a-z][a-z0-9_-]*)\b/i,
  /^\s*<short-term-memory\b/,
  /^\s*<memory-saved\b/,
]

/**
 * True iff `b` is a text content block that the agent runtime
 * prepended to a user message: any `<ma::agent::*>` or
 * `<ma::plugin::*>` attachment, plus the legacy bare forms
 * (`<mode-change>`, `<short-term-memory>`, `<memory-saved>`,
 * `<ma::*>`) accepted during the migration window. These have no
 * user-visible payload and must be skipped during replay.
 */
function isRuntimeAttachmentBlock(b: ContentBlock): boolean {
  if (b.type !== "text") return false
  return RUNTIME_ATTACHMENT_OPENERS.some((re) => re.test(b.text))
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
 * If `b` is a mode-change activation block, return both `from=` and `to=`.
 * Used by the replay chip renderer; the prompt-prefix path only cares
 * about `to`.
 */
function readModeChangeFromTo(b: ContentBlock): { from: string; to: string } | undefined {
  if (b.type !== "text") return undefined
  const m = b.text.match(MODE_CHANGE_RE)
  return m ? { from: m[1], to: m[2] } : undefined
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
    // Thread mode forward via the mode-change side effect, then drop
    // every runtime-injected attachment from the rendered text. The
    // attachment set is broader than mode-change alone : it also
    // includes <short-term-memory>, <ma::plugin::tasks>, <memory-saved>,
    // and <ma::agent::reflection-checkpoint>, all of which the agent prepends
    // to user content for model context and which would otherwise leak
    // into scrollback verbatim on `--resume`.
    const to = readModeChangeTo(b)
    if (to !== undefined) modeAfter = to === "default" ? null : to
    if (isRuntimeAttachmentBlock(b)) continue
    parts.push(b.text)
  }
  return { text: parts.join(" ").trim(), modeAfter }
}

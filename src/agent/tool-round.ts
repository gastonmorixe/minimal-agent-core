/**
 * Single-tool execution round for the agent's agentic loop.
 *
 * Extracted from `src/agent.ts` (the body of its per-tool `for` loop) to keep
 * that file under the `max-lines` lint budget. {@link executeToolRound} owns
 * everything that happens between "the model asked for tool X" and "the
 * tool_result block is ready to send back": the mode dispatch gate, the
 * built-in `Mode` tool, plugin dispatch, built-in execution with live Bash
 * streaming, transcript rendering (header / body / footer), the
 * `tool.didInvoke` plugin chain, blob-store capture, the TUI-elision and
 * active-mode annotations, and JSONL persistence of the result.
 *
 * Deliberately closure-free: every collaborator the original loop body pulled
 * from `Agent`'s fields or the `run()` scope arrives through
 * {@link ToolRoundContext}, so this module never reaches back into the class.
 * The agent calls it once per `tool_use` block and pushes the returned
 * `tool_result` onto the outgoing user message.
 *
 * @module agent/tool-round
 */

import { GLOBAL_STATUS_BUS } from "../bus/status.ts"
// P4 FOLLOW-UP (core→host decoupling): this is the LAST host import in this
// module. The raw box-drawing glyphs + palette were already pushed into the
// host (formatRefusalRows / formatModeCloseRow / formatStreamBodyRow, plus
// the header/preview/stream/findings formatters live here). What remains is
// the whole tool-block RENDER PIPELINE, which core drives inline. Killing it
// to zero means inverting `executeToolRound`'s render path behind a
// host-provided renderer port threaded through ToolRoundContext (the
// onStopNotice pattern), which belongs to Jacob's Phase-4 host-adapter /
// SDK-port wiring — not a reactive rewrite here. `format.ts` itself can't
// move to the leaf: it depends on core modules (bash-split, tools/truncation,
// truncate-hint, term-width).
import {
  clampBodyWithHint,
  computeTuiElision,
  effectiveBodyLineWidth,
  formatDiagnosticsAnnotation,
  formatModeCloseRow,
  formatRefusalRows,
  formatStreamBodyRow,
  formatToolHeaderRows,
  formatToolPreview,
  renderFindingsPanel,
  renderStreamedTail,
  reopenFrameCloser,
  TOOL_PREVIEW_GUTTER_WIDTH,
  TOOL_PREVIEW_LINES,
  TOOL_PREVIEW_LINES_DEFAULT,
  type ToolPresentation,
  tuiPreviewHint,
} from "../host/ui/tool-transcript/format.ts"
import type { ContentBlock, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { resolveToolMediaContext } from "../media/tool-context.ts"
import type { ModeManager } from "../modes/modes.ts"
import {
  type Finding,
  makeToolDidInvokePayload,
  type ToolDidInvokePayload,
} from "../plugins/hooks/tool-lifecycle.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import {
  type BlobStore,
  type BlobWriteResult,
  formatRawOutputFooter,
} from "../session/blob-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import { expandTabs } from "../terminal/term-width.ts"
import type { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import type { ToolTimeTracker } from "../tools/tool-time.ts"
import { executeTool, type ToolResultMediaBlock } from "../tools/tools.ts"
import { type TruncationInfo, truncateToolOutput } from "../tools/truncation.ts"

/**
 * Everything {@link executeToolRound} needs from the agent. The original
 * loop body captured these via closure over `Agent` fields and `run()`
 * locals; the explicit bag keeps the extraction compile-safe and the module
 * free of any dependency on the `Agent` class itself.
 */
export interface ToolRoundContext {
  /** Per-tool cosmetic presentation map (icon / color / headerKey). */
  presentation: ReadonlyMap<string, ToolPresentation>
  /** Transcript sink: one call per scrollback line. */
  writeTranscript: (line: string) => void
  /** Plugin loader for plugin-tool dispatch + the didInvoke hook chain. */
  loader: PluginLoader | null
  /** Mode manager for the dispatch gate, `Mode` tool, and mode stamps. */
  modeManager: ModeManager | null
  /** Per-session raw-output blob store (null disables blob capture). */
  blobStore: BlobStore | null
  /** Tools whose output is excluded from clamping + blob persistence. */
  blobSkipTools: ReadonlySet<string>
  /** Streak tracker behind the consecutive-truncation `[note: …]` hint. */
  feedbackTracker: ToolFeedbackTracker
  /** Optional `· HH:MM:SS` header time-hint tracker (null disables it). */
  toolTimeTracker: ToolTimeTracker | null
  /** Active model id, used to resolve media (vision) capabilities. */
  model: string
  /** Append-only session store for tool_result persistence (optional). */
  store: SessionStore | null
  /** Per-turn cancellation signal forwarded into tool execution. */
  signal?: AbortSignal | undefined
}

/**
 * Convert a canonical media block (currently an image) returned by a
 * media-aware tool into the legacy wire {@link ContentBlock} the agent's
 * message history speaks. Kept tiny + local so the agent doesn't reach into the
 * adapter's private encoders; the canonical→wire image source mapping is the
 * same trichotomy (`base64`/`url`/`file_id`→`file`) the adapter uses.
 */
function mediaBlockToLegacy(block: ToolResultMediaBlock): ContentBlock {
  const src = block.source
  switch (src.kind) {
    case "base64":
      return {
        type: "image",
        source: { type: "base64", media_type: src.mediaType, data: src.data },
      }
    case "url":
      return { type: "image", source: { type: "url", url: src.url } }
    case "file_id":
      return { type: "image", source: { type: "file", file_id: src.fileId } }
    default:
      throw new Error(`unhandled media source: ${JSON.stringify(src satisfies never)}`)
  }
}

/**
 * Fire the `tool.didInvoke` chain so plugins can augment a just-finished
 * tool result, then fold the union back into renderable + model-facing
 * forms. Returns `null` when there's no loader, no subscriber, or the
 * plugins added nothing (the common, zero-cost path).
 *
 * - `panel`: transcript lines (the agent's own gutter/palette chrome) built
 *   from the plugins' structured `findings`.
 * - `annotation`: the `<ma::agent::diagnostics>` block (or `""`) built from
 *   the plugins' model-facing `notes`, to append to `tool_result.content`.
 *
 * This is the ONLY agent-side coupling to the diagnostics feature, and even
 * it is generic: the agent knows about `findings`/`notes`, not about LSP,
 * linters, or formatters. All failure modes are contained by the HookBus.
 */
async function runToolDidInvokeChain(
  loader: PluginLoader | null,
  tool: ToolUseBlock,
  isError: boolean | undefined,
): Promise<{ panel: string[]; annotation: string } | null> {
  // Defensive resolution: a loader may be a partial/mock without the hooks
  // facade (several tests inject a minimal loader exposing only hasTool /
  // dispatch). Treat any missing piece as "no subscribers" and bail quietly.
  if (!loader || typeof loader.hooks !== "function") return null
  let hooks: ReturnType<PluginLoader["hooks"]>
  try {
    hooks = loader.hooks()
  } catch {
    return null
  }
  if (!hooks?.hookBus || typeof hooks.hookBus.listenerCount !== "function") return null
  // Cheap guard: skip the whole dance when nothing subscribed.
  if (hooks.hookBus.listenerCount("tool.didInvoke") === 0) return null

  const filePath = typeof tool.input.file_path === "string" ? tool.input.file_path : undefined
  const payload = makeToolDidInvokePayload({
    tool: tool.name,
    input: tool.input,
    cwd: process.cwd(),
    ok: !isError,
    ...(filePath !== undefined ? { filePath } : {}),
  })

  let result: ToolDidInvokePayload
  try {
    const emitted = await hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", payload)
    result = emitted.payload
  } catch {
    // The bus already absorbs listener errors; this guards the emit itself.
    return null
  }

  const findings: Finding[] = Array.isArray(result.findings) ? result.findings : []
  const notes: string[] = Array.isArray(result.notes) ? result.notes : []
  if (findings.length === 0 && notes.length === 0) return null

  const renderCols = process.stdout.columns
  const diagScope = findings.find((f) => f.scope)?.scope
  return {
    panel: renderFindingsPanel(findings, renderCols ? { cols: renderCols } : {}),
    annotation: formatDiagnosticsAnnotation(notes, diagScope),
  }
}

/**
 * Execute ONE `tool_use` block end-to-end and return the matching
 * `tool_result` block, ready to be pushed onto the next user message.
 *
 * Covers the full original per-tool pipeline: mode dispatch gate, the
 * built-in `Mode` tool, plugin dispatch (with universal output clamping),
 * built-in execution with live Bash streaming, transcript rendering, the
 * `tool.didInvoke` plugin chain, blob-store raw capture, the
 * `<ma::agent::output-preview>` and active-mode annotations, and JSONL
 * persistence (including presentation overrides for session replay).
 *
 * @param tool - The `tool_use` block the model emitted.
 * @param ctx - Collaborators threaded in from the agent (see
 *   {@link ToolRoundContext}).
 * @returns The `tool_result` block pairing `tool.id`.
 */
export async function executeToolRound(
  tool: ToolUseBlock,
  ctx: ToolRoundContext,
): Promise<ToolResultBlock> {
  const { writeTranscript, signal } = ctx
  const pres = ctx.presentation.get(tool.name)
  const renderCols = process.stdout.columns
  let headerWritten = false
  const writeToolHeader = (override?: string): void => {
    if (headerWritten) return
    headerWritten = true
    const timeText = suppressToolTime ? undefined : ctx.toolTimeTracker?.format(Date.now())
    const rows = formatToolHeaderRows({
      tool,
      presentation: pres,
      headerOverride: override,
      timeText,
      cols: renderCols,
    })
    for (const [idx, row] of rows.entries()) writeTranscript(idx === 0 ? `\n${row}` : row)
  }

  let content: string
  let isError: boolean | undefined
  let display: string | undefined
  let displayHeader: string | undefined
  let displayFooter: string | undefined
  let truncInfo: TruncationInfo | undefined
  let streamedRendered = false
  let aborted = false
  /**
   * Non-text content blocks (currently images) a media-aware tool
   * attached to its result : e.g. `Read` on a screenshot for a vision
   * model. They ride into the `tool_result` content alongside the text
   * caption (converted to legacy wire blocks below) so the model
   * actually sees the pixels. Empty for the overwhelming majority of
   * tool calls. See `src/tools.ts` :: `ToolExecResult.blocks` and
   * `src/media/read-file.ts`.
   */
  let mediaBlocks: ToolResultMediaBlock[] | undefined
  /**
   * Pre-clamp body the agent should persist via the blob store.
   * Set from `executeTool` result's `_raw` field when the universal
   * truncation clamp fired (built-in path). Left undefined for the
   * plugin path: the plugin result's `content` IS the full body in
   * that case, so the agent falls back to `content` for the blob.
   * See `src/tools.ts` :: `executeTool` and `src/blob-store.ts`.
   */
  let rawForBlob: string | undefined
  /**
   * Outcome of the blob write, populated inside the else-execute
   * branch and read after the if-refused/else-execute structure
   * when building the JSONL record. `null` when no blob was
   * written (store disabled, body too small, tool on skip list,
   * write failure, etc.).
   */
  let blobWrite: BlobWriteResult | null = null
  /**
   * Plugin opt-in: when true, the tool header skips the agent's
   * automatic `· HH:MM:SS` time suffix so the plugin can own the
   * trailing date+time chrome inside `displayHeader`. Used by the
   * tasks plugin (full `· YYYY-MM-DD HH:MM:SS` with year). See
   * `TUIResult.suppressToolTime` in `src/plugins/types.ts`.
   */
  let suppressToolTime = false

  // Mode dispatch gate. Tools stay registered in the request body
  // (so the cached prefix is mode-independent), but the harness
  // refuses to actually invoke a tool the active mode disallows.
  // The synthesized error tool_result teaches the model how to
  // adapt : see ManifestMode.refusalHint. No spinner, no execution
  // side effects.
  const gate = ctx.modeManager?.isToolAllowed(
    tool.name,
    tool.input as Record<string, unknown> | undefined,
  ) ?? { allowed: true as const }
  if (!gate.allowed) {
    writeToolHeader()
    content = gate.message
    isError = true
    // Render a denial block in the transcript so the user sees what
    // got blocked. The host owns the ⊘ glyph + frame + palette; core
    // supplies the message and the refusing mode's id.
    for (const row of formatRefusalRows(content, ctx.modeManager?.activeId() ?? "mode")) {
      writeTranscript(row)
    }
  } else if (tool.name === "Mode" && ctx.modeManager) {
    // Built-in `Mode` tool. Returns the live mode + effective
    // permissions as a small JSON blob. Intercepted here (not in
    // `executeTool`) because `tools.ts` does not (and should not)
    // import the agent's ModeManager.
    //
    // The result is small, deterministic, side-effect-free, and
    // doesn't need a spinner or the bash-streaming machinery. It
    // ships through the same `tool_result` shape as everything
    // else and picks up the trailing `<ma::agent::mode-active>` stamp
    // below.
    writeToolHeader()
    const mm = ctx.modeManager
    const active = mm.active()
    const since = mm.activeSince()
    const perms = active ? mm.effectivePermissions(active.id) : null
    const result = {
      id: active?.id ?? null,
      label: active?.label ?? null,
      since: since ? since.toISOString() : null,
      permissions: perms
        ? {
            tools: perms.tools.map((t) => {
              const entry: Record<string, unknown> = { tool: t.tool, allow: t.allow }
              if (t.refusalHint) entry.refusalHint = t.refusalHint
              return entry
            }),
            source: perms.source,
          }
        : { tools: [{ tool: "*", allow: true }], source: "default" },
    }
    content = JSON.stringify(result, null, 2)
    isError = false
    // Close the framed tool block. One transcript row showing the
    // id is enough : the model gets the structured details, the
    // user just needs to see that the model checked.
    const labelDisplay = active ? (active.label ?? active.id) : "default"
    writeTranscript(formatModeCloseRow(labelDisplay))
  } else {
    // Header-timing is a per-tool STRATEGY, because scrollback is
    // append-only: a tool can either paint its header NOW (from data
    // we have synchronously) or DEFER it until the handler returns a
    // richer `displayHeader` — never both on the same line.
    //
    //   - Built-in tools: always paint early (they format their own
    //     header from input; no plugin handler runs).
    //   - Plugin tools that declare `headerKey`: paint early using
    //     that input field. This is the opt-in for LONG-RUNNING tools
    //     (Fetch → url, WebSearch → query) that must show feedback
    //     immediately instead of a frozen 120s gap. The reported bug.
    //   - Plugin tools WITHOUT `headerKey`: defer to `displayHeader`,
    //     exactly as before. These are the instant tools (Task,
    //     ShowDiff, MemoryTool, LockStatus) whose `displayHeader` IS
    //     the header (e.g. Task's `+ added 2 tasks · 0/2`) and which
    //     have no perceptible delay to bridge.
    //
    // `displayHeader` is captured for session-replay fidelity in the
    // `presentation` block below regardless. When we paint early the
    // later `writeToolHeader(displayHeader)` is a no-op (headerWritten
    // guard); when we defer, that later call is what paints the frame.
    const pluginTool = ctx.loader?.hasTool(tool.name) ?? false
    const paintHeaderEarly = !pluginTool || pres?.headerKey != null
    if (paintHeaderEarly) writeToolHeader()
    const toolStartedAt = Date.now()
    // Stall detection is for tools that STREAM chunks (Bash). The
    // amber `⋯ stalled · last byte Ns ago` infix is driven by
    // `direction:"down"` + `lastChunkAt` going quiet for >2s (see
    // STALL_THRESHOLD_MS in status.ts → formatActivityInfix). Seeding
    // that for a NON-streaming tool (every plugin tool: Fetch,
    // WebSearch, …) was a bug: those tools never call `onChunk`, so
    // the row was GUARANTEED to flip to "stalled" after 2s on a
    // perfectly healthy call. Only seed the stall machinery for tools
    // that actually feed chunks; everything else gets a neutral
    // `idle` activity (spinner + elapsed clock keep ticking, no
    // false "stalled"). `toolStreamsOutput` is the single source of
    // truth shared with the `onStdout`/`onStderr` wiring below.
    const toolStreamsOutput = tool.name === "Bash"
    const toolStatus = GLOBAL_STATUS_BUS.create(`Running ${tool.name}`, {
      notificationId: "tool.running",
      category: "tool",
      // When chunks DO start arriving (onChunk below), `lastChunkAt`
      // is bumped and the stalled state clears, giving way to
      // `↓ 1.2 KB · 12 B/s` etc.
      activity: toolStreamsOutput
        ? {
            direction: "down",
            startedAt: toolStartedAt,
            recvBytes: 0,
            lastChunkAt: toolStartedAt,
          }
        : { direction: "idle", startedAt: toolStartedAt },
    })

    try {
      if (ctx.loader?.hasTool(tool.name)) {
        // Plugin-provided tool: delegate to the loader dispatcher. Plugin
        // handlers may draw their own interactive UI; we do not preview
        // their stdout here.
        const pluginResult = await ctx.loader.dispatch(
          {
            type: "tool",
            name: tool.name,
            input: tool.input,
            tool_use_id: tool.id,
          },
          process.cwd(),
          // Forward the per-turn AbortSignal so Esc / Ctrl+C can
          // cancel a long-running plugin tool (Fetch, WebSearch, …).
          // Without this, abort no-ops until the manifest timeoutMs
          // fires — see loader.test.ts "dispatch external AbortSignal".
          signal,
        )
        if (pluginResult.kind === "tool_result") {
          content = pluginResult.content
          isError = pluginResult.is_error
          display = pluginResult.display
          displayHeader = pluginResult.displayHeader
          displayFooter = pluginResult.displayFooter
          suppressToolTime = pluginResult.suppressToolTime ?? false

          // Universal post-hoc clamp for plugin tools. Mirrors what
          // `executeTool` already does for built-in tools (Bash/Read/…).
          // Plugin handlers (Fetch, WebSearch, …) used to bypass the
          // clamp entirely, so a 5 MiB markdown from Fetch would ship
          // straight to the API. Now plugin output is clamped to the
          // same 64 KB / 1000-line budgets and the FULL pre-clamp body
          // is preserved in `rawForBlob` for the blob-store hook
          // below. Recoverable via the `<ma::agent::raw-output …/>` pointer
          // footer the agent appends a few lines down.
          //
          // Tools that want full plugin control over the
          // model-facing body (tasks, ShowDiff, LockStatus,
          // MemoryTool) live on the `skipTools` list resolved at
          // construction. Setting `display` alone does NOT
          // disable the clamp: Fetch sets `display` for the
          // transcript preview while `content` carries the full
          // body, and we genuinely want that body clamped.
          //
          // See `src/tools/truncation.ts` and `src/blob-store.ts`.
          if (!ctx.blobSkipTools.has(tool.name)) {
            const preClamp = content
            const { content: clamped, info } = truncateToolOutput(preClamp, {
              tool: tool.name,
            })
            content = clamped
            truncInfo = info
            if (info.truncated) rawForBlob = preClamp
          }
        } else {
          content = `Plugin tool "${tool.name}" returned a non-tool_result value`
          isError = true
        }
        writeToolHeader(displayHeader)
      } else {
        // Live-stream Bash stdout/stderr to the transcript as the
        // child writes it, instead of waiting for the process to
        // exit. Without this, a `for i in {1..20}; do echo $i;
        // sleep 1; done` produced nothing visible for 20 seconds :
        // the user couldn't tell the difference between "working"
        // and "frozen". The streamer emits one `│ <line>` per
        // newline up to the per-tool body budget; lines past the
        // budget are still counted (so the footer can say "shown
        // V/T L") but not emitted.
        //
        // The last emitted line is BUFFERED instead of written
        // immediately : so when the stream ends we can decide
        // between (a) writing it as `│` followed by a `╰ <footer>`
        // line (when there's something to say), or (b) rewriting
        // it as `╰` and dropping the footer entirely (clean run,
        // body fits in budget). Scrollback is permanent so this
        // last-line trick is the only way to keep the close glyph
        // attached to the body in the no-footer case.
        // Reuse the same streaming predicate that seeded the stall
        // activity above, so "seeds stall" and "wires onChunk" can
        // never drift apart (the original bug was exactly that
        // divergence: stall was seeded for all tools, onChunk only for
        // Bash).
        const isBash = toolStreamsOutput
        const STREAM_BUDGET = TOOL_PREVIEW_LINES[tool.name] ?? TOOL_PREVIEW_LINES_DEFAULT
        let streamedLineCount = 0
        let bufferedLastLine: string | null = null
        let bufferedLastLineRaw: string | null = null
        let pendingChunk = ""
        let didStream = false

        const flushLineToBuffer = (raw: string) => {
          didStream = true
          if (streamedLineCount >= STREAM_BUDGET) {
            streamedLineCount++
            return
          }
          if (bufferedLastLine !== null) {
            writeTranscript(formatStreamBodyRow(bufferedLastLine))
          }
          // Per-line width clamp : `min(terminal_cols - gutter,
          // TOOL_PREVIEW_LINE_WIDTH)` at the moment this line is
          // emitted. Live width (no `cols` arg → reads
          // `process.stdout.columns` now), so a mid-stream resize
          // takes effect on the very next line. Scrollback above
          // never re-renders, but no NEW line will overflow the
          // current visible columns. See {@link
          // effectiveBodyLineWidth} and {@link clampBodyWithHint}.
          //
          // Expand `\t` first using the body's start column
          // (after the 4-cell gutter) so the width math accounts
          // for the terminal's tab-stop advance. Without this,
          // a `<linenum>\t<content>` line (Read, also TSV-style
          // Bash output) underflows the cap by 1–8 cells and the
          // trailing `...(+Nch)` hint wraps into the gutter.
          bufferedLastLine = clampBodyWithHint(
            expandTabs(raw, TOOL_PREVIEW_GUTTER_WIDTH),
            effectiveBodyLineWidth(),
          )
          bufferedLastLineRaw = raw
          streamedLineCount++
        }

        // Track bytes streamed AND timestamp the most recent chunk so
        // the live-area status row renders `↓ 1.2 KB · 12 B/s` while
        // bash is producing output, AND flips to `⋯ stalled · last
        // byte Ns ago` when the subprocess goes quiet (which the user
        // observes as "Bash is frozen with no feedback" -- common
        // when the command pipes through a buffering filter like
        // `tail -N` or `head -N` that holds all output until EOF).
        let recvBytes = 0
        const onChunk = (s: string) => {
          pendingChunk += s
          recvBytes += Buffer.byteLength(s, "utf8")
          toolStatus.updateActivity({
            direction: "down",
            recvBytes,
            lastChunkAt: Date.now(),
          })
          let nl: number
          while ((nl = pendingChunk.indexOf("\n")) !== -1) {
            flushLineToBuffer(pendingChunk.slice(0, nl))
            pendingChunk = pendingChunk.slice(nl + 1)
          }
        }

        const result = await executeTool(tool.name, tool.input, {
          signal,
          // Active-model media capability context : lets `Read` hand back
          // an image block for a screenshot the model can actually see
          // instead of UTF-8 mojibake. Provider-neutral; resolved from
          // the registry. `undefined` for unknown models keeps the
          // legacy text-only behavior.
          media: resolveToolMediaContext(ctx.model),
          onStdout: isBash ? onChunk : undefined,
          onStderr: isBash ? onChunk : undefined,
        })
        content = result.content
        isError = result.is_error
        display = result.display
        truncInfo = result._truncInfo
        mediaBlocks = result.blocks
        // Pre-clamp body, present only when the universal clamp
        // fired (see `src/tools.ts` :: `executeTool`). The agent's
        // blob-store hook below prefers this over the clamped
        // `content` so the persisted file is the FULL output.
        rawForBlob = result._raw

        // Flush any trailing partial line (no terminating newline).
        if (pendingChunk.length > 0) {
          flushLineToBuffer(pendingChunk)
          pendingChunk = ""
        }

        // Propagate _aborted so the renderer below can draw a
        // dim "canceled" close line instead of the generic error
        // preview. The flag is stripped before the result is sent
        // back to the API as a tool_result block.
        if ((result as { _aborted?: boolean })._aborted) {
          aborted = true
          // If the executor surfaced partial output (e.g. Bash captured
          // some stdout before SIGTERM landed), keep it : both for the
          // user (transcript body) and for the model (so it sees what
          // ran before the abort). Only fall back to the canned
          // "canceled" string when there's literally nothing to show.
          if (!content) content = "canceled"
        } else {
          // Layer 3 of the size-feedback design: streak tracker.
          // After N consecutive truncations on the same tool, append
          // a soft `[note: ...]` to the model-facing content so the
          // model sees the *pattern*, not just per-call hints.
          // Skipped on aborted calls (no tool work happened) and on
          // plugin-tool branches (those don't go through executeTool
          // so we have no _truncInfo to consult anyway).
          const streakNote = ctx.feedbackTracker.observe(tool.name, truncInfo?.truncated ?? false)
          if (streakNote) content = `${content}\n\n${streakNote}`
        }

        if (didStream) {
          // Emit the buffered last line + computed footer. We then
          // mark `streamedRendered` so the post-block render path
          // (which would call formatToolPreview and re-emit the
          // body) is skipped : but the tool_result push to the API
          // below still happens.
          renderStreamedTail({
            bufferedLastLine,
            bufferedLastLineRaw,
            streamedLineCount,
            budget: STREAM_BUDGET,
            truncInfo,
            isError,
            writeTranscript,
            cols: renderCols,
          })
          streamedRendered = true
        }
      }
    } finally {
      toolStatus.clear()
    }

    // Tool-lifecycle extension point (generic seam, NOT diagnostics-
    // specific). Fire the `tool.didInvoke` CHAIN so any plugin can
    // augment a just-finished tool result: a plugin pushes structured
    // `findings` (the AGENT renders them, below) and model-facing
    // `notes` (folded into a `<ma::agent::diagnostics>` annotation on
    // `content`). The `diagnostics` plugin (LSP/linter/formatter
    // feedback) is the first consumer; the shape is tool-agnostic.
    //
    // Decoupled by construction: the agent never imports the plugin,
    // the plugin never imports the agent — they meet only at the
    // `ToolDidInvokePayload` shape. Listener errors/timeouts are
    // absorbed by the HookBus, so a misbehaving plugin can never break
    // the tool loop. Skipped when no plugin subscribes (zero cost) and
    // for aborted runs (no completed work to react to).
    let diagnosticsPanel: string[] = []
    if (!aborted) {
      const augmented = await runToolDidInvokeChain(ctx.loader, tool, isError)
      if (augmented) {
        if (augmented.annotation) content = `${content}${augmented.annotation}`
        diagnosticsPanel = augmented.panel
      }
    }

    if (!streamedRendered) {
      if (!headerWritten) writeToolHeader(displayHeader)
      const previewLines = formatToolPreview(content, isError, display, {
        tool: tool.name,
        info: truncInfo,
        footer: displayFooter,
        cols: renderCols,
      })
      // When a plugin attached a diagnostics panel, the panel owns the
      // final `╰`; re-open the preview's own closer to a `│` so the two
      // blocks fuse into one frame instead of double-closing.
      if (diagnosticsPanel.length > 0 && previewLines.length > 0) {
        const lastIdx = previewLines.length - 1
        previewLines[lastIdx] = reopenFrameCloser(previewLines[lastIdx])
      }
      for (const line of previewLines) writeTranscript(line)
      for (const line of diagnosticsPanel) writeTranscript(line)
    }

    // Raw-output blob capture (design 2026-05-26). The model's
    // `content` may be the clamped body (built-in tools that hit the
    // 64KB/1000L universal cap) OR the full body (plugin tools, OR
    // built-ins under cap). When persistable, write the FULL bytes
    // to `<sid>.blobs/<tool_use_id>.raw` and append a
    // `<ma::agent::raw-output …/>` pointer footer so the model can `Read` the
    // file when the inline body isn't enough.
    //
    // Source of truth for the blob:
    //   - `result._raw` (built-in clamp branch) when set: pre-clamp
    //     body, never includes the trailing `[truncated: …]` notice.
    //   - `content` otherwise: full output (no clamp ran, or plugin
    //     tool which currently doesn't clamp at all).
    //
    // Skipped when:
    //   - blobStore is null (config disabled, or construction failed)
    //   - tool is on the user-configurable skip list (Task,
    //     MemoryTool, ShowDiff, LockStatus). These plugins own
    //     full audience-split and would be mangled by an
    //     after-the-fact blob+footer on the model-facing body.
    //   - tool was aborted (partial output, no point)
    //   - body too small to be useful (gated inside BlobStore.write
    //     via `minBytesToPersist`)
    //
    // Setting `display` alone does NOT disable the blob: Fetch
    // sets `display` for the transcript preview while `content`
    // carries the full body, and we genuinely want that body
    // persisted. For Edit/Write the `content` is "File written:
    // …" sized, so the `minBytesToPersist` gate inside the store
    // handles them without an explicit `!display` guard here.
    //
    // See `src/blob-store.ts`.
    if (ctx.blobStore !== null && !ctx.blobSkipTools.has(tool.name) && !aborted) {
      const rawBody = rawForBlob ?? content
      // Async write: keeps the (potentially multi-MB) body's fs write
      // off the synchronous critical section so the TUI/input loop
      // doesn't freeze while a big Fetch body is persisted (Bug 4).
      // We're already inside an async function here, so the await is
      // free; the tool_result it produces is returned below either way.
      blobWrite = await ctx.blobStore.writeAsync(tool.id, rawBody)
      if (blobWrite) {
        // Footer order: existing `[truncated: …]` notice is already
        // inside `content` (appended by truncation.ts when the clamp
        // fired). Our `<ma::agent::raw-output …/>` goes AFTER that and BEFORE
        // the `<ma::agent::output-preview …>` annotation appended below. The
        // model-facing tail therefore reads:
        //   <body>
        //   [truncated: …]               ← only when clamp fired
        //
        //   <ma::agent::raw-output path="<path>" size="85kB" sha256="…" />   ← new
        //
        //   <ma::agent::output-preview shown=… total=…>…</ma::agent::output-preview>   ← only when TUI elided
        content = `${content}\n\n${formatRawOutputFooter(blobWrite)}`
      }
    }

    // Layer 1b of size-feedback (companion to truncation.ts notice and
    // feedback-tracker.ts streak note): when the user's transcript
    // clamped MORE lines than the API cap did (every tool with a tight
    // preview budget : Bash=10, Read=15, Grep=12, Glob=25), append a
    // model-only `<ma::agent::output-preview …>` annotation to `content` BEFORE
    // the result block is built, so the model knows the audiences
    // diverged. Without this, the model sees the full body and
    // assumes the user did too, leading to "as you can see above"
    // claims that desync from what the user actually saw.
    //
    // Model-only by construction: this runs AFTER the transcript
    // render path, so `formatToolPreview` / `renderStreamedTail`
    // never sees it. The strip in `formatToolPreview` also catches
    // it (for session-replay where this annotation is persisted in
    // tool_result history). Skipped when:
    //   - tool was refused by the mode gate (no execution happened),
    //   - tool returned a `display` override (Edit/Write diff render
    //     full by design),
    //   - tool was aborted (partial output, no point nagging),
    //   - body fits the TUI budget.
    if (!display && !aborted) {
      const e = computeTuiElision(content, tool.name)
      if (e) {
        // When a raw-output blob was written for this same result (above),
        // thread its path into BOTH the hint prose and a machine-readable
        // `path="…"` attribute, so the elision flag carries its own recovery
        // pointer instead of stranding the model with "you saw less than the
        // model did" and no destination. `blobWrite` is the write outcome
        // from the blob-store hook a few lines up; null when nothing spilled
        // (body under `minBytesToPersist`, store disabled, skip-listed tool).
        const rawPath = blobWrite?.path
        const hint = tuiPreviewHint(tool.name, rawPath)
        const pathAttr = rawPath ? ` path="${rawPath}"` : ""
        content =
          `${content}\n\n<ma::agent::output-preview ` +
          `shown="${e.shown}" total="${e.total}" tool="${tool.name}"${pathAttr}>` +
          hint +
          `</ma::agent::output-preview>`
      }
    }
  }

  // Active-mode stamp on EVERY tool_result. Continuously surfaces
  // the current mode to the model so reasoning inertia from
  // earlier in the same turn can't keep operating under a stale
  // mode. Emitted only when a mode is active : default/no-mode
  // turns are byte-identical to pre-stamp output, so tool_results
  // in unrestricted sessions don't grow.
  //
  // Position: trailing on the tool_result content text. Sits in
  // the rolling-tail cache breakpoint that's invalidated every
  // turn anyway. Zero cache cost.
  //
  // Refusals get the stamp too : the model needs to know which
  // mode produced the refusal so it can adapt deterministically
  // (the refusal message already says "in <LABEL> mode", and the
  // stamp gives the machine-readable id alongside).
  const modeStamp = ctx.modeManager?.buildActiveModeStamp() ?? null
  if (modeStamp) {
    content = content.length > 0 ? `${content}\n\n${modeStamp}` : modeStamp
  }

  // When a media-aware tool attached image blocks (Read on a screenshot
  // for a vision model), the tool_result content becomes a BLOCK ARRAY:
  // the text caption first, then the image block(s). The wire layer
  // (legacy Messages, and the canonical adapter) accepts
  // text+image inside a tool_result. Without media blocks, content stays
  // a plain string : byte-identical to every prior tool_result. The
  // mode stamp / blob footers already folded into `content` above ride
  // along as that leading text block.
  const resultContent: string | ContentBlock[] =
    mediaBlocks && mediaBlocks.length > 0
      ? [
          ...(content.length > 0 ? [{ type: "text" as const, text: content }] : []),
          ...mediaBlocks.map(mediaBlockToLegacy),
        ]
      : content
  const resultBlock: ToolResultBlock = {
    type: "tool_result",
    tool_use_id: tool.id,
    content: resultContent,
    is_error: isError,
  }
  // Persist the live transcript's presentation overrides so
  // `--resume` can recreate the exact body / header the user
  // saw without re-running the tool. Without this, plugin-driven
  // tools (Edit's diff, Tasks' tree) lose their custom rendering
  // on resume and fall back to the model-facing `content` (e.g.
  // "File edited: ..." or JSON args). `aborted` runs go through
  // the canceled-footer renderer instead of `display`, so
  // there's nothing useful to persist in that case : keep the
  // record minimal so a resume of an aborted run renders the
  // same dim "canceled" footer the live agent drew. See the
  // matching consumer in `src/session-replay.ts`.
  const presentation: {
    display?: string
    displayHeader?: string
    displayFooter?: string
  } = {}
  if (!aborted) {
    if (display !== undefined) presentation.display = display
    if (displayHeader !== undefined) presentation.displayHeader = displayHeader
    if (displayFooter !== undefined) presentation.displayFooter = displayFooter
  }
  const hasPresentation =
    presentation.display !== undefined ||
    presentation.displayHeader !== undefined ||
    presentation.displayFooter !== undefined
  ctx.store?.appendToolResult(
    resultBlock,
    undefined,
    blobWrite
      ? { path: blobWrite.path, bytes: blobWrite.bytes, sha256: blobWrite.sha256 }
      : undefined,
    hasPresentation ? presentation : undefined,
  )
  return resultBlock
}

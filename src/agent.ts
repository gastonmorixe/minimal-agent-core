/**
 * Agent module: conversational state + tool execution loop + REPL.
 *
 * The {@link Agent} class owns the append-only conversation history and
 * provides two send methods:
 *
 * - {@link Agent.send} : single round-trip text reply (no tools)
 * - {@link Agent.run} : full agentic loop: send → tool_use → execute → tool_result → repeat
 *
 * Both yield text chunks via async generator and return a {@link StreamedResponse}
 * with the structured content blocks (thinking, tool_use, text). Thinking blocks
 * are preserved verbatim in history (with their signatures) so subsequent
 * requests can include them : required for the `redact-thinking-2026-02-12` beta.
 *
 * **Conversation history shape** (v2.1.118 block-based content):
 * ```
 * [
 *   { role: "user",      content: [{type:"text", text:"..."}] },
 *   { role: "assistant", content: [{type:"thinking",...}, {type:"tool_use",...}] },
 *   { role: "user",      content: [{type:"tool_result", tool_use_id:"...", content:"..."}] },
 *   { role: "assistant", content: [{type:"text", text:"..."}] },
 * ]
 * ```
 *
 * @module agent
 */

import { abortBus } from "./abort-bus.ts"
import type { AuthResult } from "./auth.ts"
import {
  type ContentBlock,
  listModels as defaultListModels,
  type Message,
  type ModelInfo,
  type SendOptions,
  type StreamedResponse,
  sendMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./client.ts"
import { Formatter } from "./formatter.ts"
import { buildSystemPrompt } from "./headers.ts"
import { RawInput } from "./input.ts"
import { ModeManager } from "./modes.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { PluginStream } from "./plugins/stream.ts"
import type { ManifestMode, ResolvedLiveAreaSlot } from "./plugins/types.ts"
import type { SessionStore } from "./session-store.ts"
import type { Spinner } from "./spinner.ts"
import { GLOBAL_STATUS_BUS, StatusBus, StatusRenderer, type StatusSpinnerTheme } from "./status.ts"
import { PALETTE } from "./palette.ts"
import { executeTool, TOOL_DEFINITIONS, type ToolDefinition } from "./tools.ts"
import { ToolFeedbackTracker } from "./tools/feedback-tracker.ts"
import type { TruncationInfo } from "./tools/truncation.ts"
import { displayWidth, truncateDisplayWidth } from "./term-width.ts"
import { truncHint } from "./truncate-hint.ts"
import { splitBashSegments, shouldSoftSplit } from "./bash-split.ts"

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

// Color helpers. The SGR open sequences live in `src/palette.ts` (the
// agent-owned single source of truth, also exported to plugins via
// `MINIMAL_AGENT_PALETTE` env). The wrappers here just close them.
const _fg = (open: string) => (s: string) => `${open}${s}\x1b[39m`
const _attr = (open: string, close: string) => (s: string) => `${open}${s}${close}`
const _combo = (open: string, close: string) => (s: string) => `${open}${s}${close}`

export const c = {
  dim: _attr("\x1b[2m", "\x1b[22m"),
  cyan: _fg(PALETTE.cyan),
  blue: _fg(PALETTE.blue),
  magenta: _fg(PALETTE.magenta),
  yellow: _fg(PALETTE.yellow),
  green: _fg(PALETTE.green),
  red: _fg(PALETTE.red),
  bold: _attr("\x1b[1m", "\x1b[22m"),
  italic: _attr("\x1b[3m", "\x1b[23m"),
  underline: _attr("\x1b[4m", "\x1b[24m"),
  brightCyan: _fg(PALETTE.brightCyan),
  brightYellow: _fg(PALETTE.brightYellow),
  brightGreen: _fg(PALETTE.brightGreen),
  brightRed: _fg(PALETTE.brightRed),
  brightMagenta: _fg(PALETTE.brightMagenta),
  boldCyan: _combo("\x1b[1;36m", "\x1b[22;39m"),
  boldGreen: _combo("\x1b[1;32m", "\x1b[22;39m"),
  boldRed: _combo("\x1b[1;31m", "\x1b[22;39m"),
  boldYellow: _combo("\x1b[1;33m", "\x1b[22;39m"),
  dimCyan: _combo("\x1b[2;36m", "\x1b[22;39m"),
  dimRed: _combo("\x1b[2;31m", "\x1b[22;39m"),
  faintWhite: _combo("\x1b[2;37m", "\x1b[22;39m"),
  // Strikethrough (SGR 9 / 29). Independent of bold/dim/fg, so it composes
  // with `c.dim` etc. without sharing close codes.
  strike: _attr("\x1b[9m", "\x1b[29m"),

  // Modern "Cool Summer" palette (Saturated & Powerful)
  orange: _fg(PALETTE.orange),
  pink: _fg(PALETTE.pink),
  purple: _fg(PALETTE.purple),
  lime: _fg(PALETTE.lime),
  sky: _fg(PALETTE.sky),
  violet: _fg(PALETTE.violet),
  gold: _fg(PALETTE.gold),
}

export const faintThinkingChunk = (s: string): string => {
  const trailingNewline = s.endsWith("\n")
  const body = trailingNewline ? s.slice(0, -1) : s
  if (body.length === 0) return trailingNewline ? "\n" : ""
  const redimmed = body
    .replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")
    .replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")
  return `\x1b[2m${redimmed}\x1b[22m${trailingNewline ? "\n" : ""}`
}

/**
 * Render an "aborted prompt echo" block: a faint, struck-through
 * reproduction of the user's just-rolled-back submission, prefixed with a
 * dim-red `⊘` badge and an `ABORTED` label. Replaces the old single-line
 * `⊘ aborted by user : prompt restored to editor` footer.
 *
 * The motivation: when a user aborts and re-submits, both the original
 * prompt (committed to scrollback at submit time) and the re-submitted
 * prompt look identical : bold pink `❯` followed by the same text. This
 * echo block sits between them in faint+strikethrough form so the
 * sequence reads unambiguously: "this got rolled back; the next bold
 * prompt is the one that was actually answered."
 *
 * Format:
 * ```
 *   ⊘ ABORTED · ❯ <line 1, dim+strikethrough>
 *     <line 2, dim+strikethrough, indented>
 *     <line 3, dim+strikethrough, indented>
 * ```
 *
 * Mode-aware: when `activeModeLabel` is supplied (e.g. `"ASK"`) it sits
 * between the separator and the arrow, matching the live prompt's
 * `ASK ❯` shape (also dimmed):
 * ```
 *   ⊘ ABORTED · ASK ❯ <text…>
 * ```
 *
 * Pure / no IO; the caller writes the returned string (followed by `\n`)
 * to the compositor's scrollback stream.
 *
 * @param text - The original user prompt text. Multi-line input is split
 *   on `\n`; each line is dimmed + strikethrough separately so terminal
 *   attribute state never leaks across line boundaries.
 * @param opts.activeModeLabel - Active mode label (e.g. `"ASK"`), or
 *   null/undefined for default mode. Uppercased on display.
 */
export function formatAbortedEcho(
  text: string,
  opts: { activeModeLabel?: string | null } = {},
): string {
  const badge = c.dimRed("⊘")
  const label = c.dim("ABORTED")
  const sep = c.dim("·")
  const modeLabel = opts.activeModeLabel ? ` ${c.dim(opts.activeModeLabel.toUpperCase())}` : ""
  const arrow = c.dim("❯")
  const head = `  ${badge} ${label} ${sep}${modeLabel} ${arrow}`

  // wrap: dim + strikethrough, with both attributes opened/closed per
  // line so multi-line output never relies on terminals carrying SGR
  // state across `\n` (some don't).
  const wrap = (line: string) => c.dim(c.strike(line))

  // Strip exactly one trailing newline so a buffer like "foo\n" doesn't
  // emit a phantom empty struck row. Interior blank lines are preserved.
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text
  const lines = normalized.split("\n")
  const first = `${head} ${wrap(lines[0] ?? "")}`
  // Continuation lines: 4-space indent (2 outer + 2 inner) so they
  // visually nest under the badge rather than aligning under the content
  // of line 1 : keeps the block compact for long submissions and makes
  // the `⊘ ABORTED` anchor unambiguous as the "left margin" of the echo.
  const rest = lines.slice(1).map((l) => `    ${wrap(l)}`)
  return [first, ...rest].join("\n")
}

type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Rolling cache helper
// ---------------------------------------------------------------------------

/**
 * Returns a defensive copy of `messages` with the last block of the last
 * message marked `cache_control: { type: "ephemeral", ttl: "1h" }` and any
 * earlier `cache_control` markers in messages stripped. Live 2.1.118 traffic
 * uses exactly one rolling tail breakpoint per request; combined with the two
 * static system-prompt breakpoints (instructions + session guidance) this
 * stays under the API's 4-breakpoint limit while letting the cached prefix
 * grow turn-over-turn.
 */
export function withRollingCacheBreakpoint(messages: Message[]): Message[] {
  if (messages.length === 0) return messages
  const out: Message[] = messages.map((m) => ({
    ...m,
    content:
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => {
            // cache_control is now declared on every ContentBlock variant, so
            // no cast is needed to destructure it out.
            const { cache_control: _drop, ...rest } = b
            return rest as ContentBlock
          }),
  }))
  const last = out[out.length - 1]
  if (typeof last.content === "string") {
    last.content = [{ type: "text", text: last.content }]
  }
  const blocks = last.content
  if (blocks.length === 0) return out
  const tail: ContentBlock = {
    ...blocks[blocks.length - 1],
    cache_control: { type: "ephemeral", ttl: "1h" },
  }
  blocks[blocks.length - 1] = tail
  return out
}

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * Conversational agent with append-only history and an agentic tool loop.
 *
 * The agent maintains its own message list and re-sends the full history
 * on every API call (no truncation, no compression : that's a server-side
 * concern enabled by the `context-management-2025-06-27` beta).
 *
 * Both {@link send} and {@link run} preserve all content block types in
 * history (thinking blocks, tool calls, tool results) so the model has
 * full context for follow-up turns.
 *
 * @example
 * ```ts
 * const agent = new Agent({ auth, model: "claude-sonnet-4-6" });
 *
 * // Simple text reply:
 * for await (const chunk of agent.send("hello")) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Full agentic with tools:
 * for await (const chunk of agent.run("read package.json")) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export class Agent {
  /**
   * Append-only conversation history.
   *
   * Read-only by convention : never mutate from outside the class. Use
   * {@link history} to get a defensive copy. Each message has block-based
   * content matching the v2.1.91 wire format.
   */
  readonly messages: Message[] = []
  /** Auth credentials used for every API call. Refresh closure stays attached. */
  private auth: AuthResult
  /** Model ID for all requests in this agent's lifetime. */
  private model: string
  /** Effort level for output_config.effort. Pass-through string; server validates. */
  private effort: string | undefined
  /**
   * Optional `thinking.display` override, threaded onto every API call.
   * `"summarized"` opts opus-4.7 / mythos into plaintext thinking_delta
   * streaming; `"omitted"` forces redaction on models that would otherwise
   * stream summaries. Unset → server default per model.
   */
  private thinkingDisplay: "summarized" | "omitted" | undefined
  /** Optional TUI plugin loader. When set, plugin tools merge with core tools. */
  private loader: PluginLoader | null
  /** Optional mode manager (mode-aware system prompt + tool filter). */
  private modeManager: ModeManager | null
  /**
   * Optional save-echo collector. When set, every `<memory-saved …>`
   * event the inline-tag handler (or the `MemoryTool` add action)
   * emits on the global bus is buffered here, and drained as
   * ContentBlock(s) prepended to the next user message. The model
   * thereby learns the id of every memory it just saved on its very
   * next turn, with no extra tool round-trip.
   *
   * Off by default; the agent is fully functional without it.
   * See `tui-plugins/memory/lib/save-echo.ts`.
   */
  private saveEcho: { consumeAll(): ContentBlock[] } | null
  /**
   * Optional short-term snapshot producer. When set, the per-session
   * `<short-term-memory>…</short-term-memory>` attachment is prepended
   * to the FIRST user message of each `run()` call.
   *
   * Only emitted at the initial seam (not at the loop seam after
   * tool_use rounds), to avoid re-emitting stale snapshots within the
   * same turn : see `tui-plugins/memory/lib/short-term-snapshot.ts`.
   */
  private shortTermSnapshot: { toAttachment(): ContentBlock | null } | null
  /**
   * Injectable transport. Defaults to the real {@link sendMessage} function.
   * Primary purpose is a testing seam so suites can drive tool_use flows
   * without making live API calls.
   */
  private sendFn: typeof sendMessage
  /**
   * Optional append-only session store. When set, the agent persists every
   * turn boundary (user submit, assistant turn complete, each tool result)
   * so the conversation can be resumed via `--resume <sid>`.
   * See `src/session-store.ts` for the FORMAT v1 record shape.
   */
  private store: SessionStore | null
  /**
   * Hard limit on tool execution rounds within a single `run()` call.
   * Prevents infinite loops if the model keeps calling tools forever.
   * Set generously (50) since real agentic sessions can hit 30+ rounds.
   */
  private maxToolRounds = 50
  /**
   * Streak / pattern soft-warning tracker : Layer 3 of the size-feedback
   * design. Observes per-tool consecutive truncations and emits a
   * `[note: ...]` line on the model-facing `tool_result.content` after a
   * threshold-th repeat (default 3). State is per-Agent and survives the
   * full conversation; reset across sessions / on resume.
   *
   * See `src/tools/feedback-tracker.ts` for the full behavior contract.
   */
  private feedbackTracker = new ToolFeedbackTracker()

  /**
   * Create an agent with auth, model, plugin, mode, and transport settings.
   *
   * @param opts.auth - Authenticated credentials from {@link getAuth}
   * @param opts.model - Model ID (default: `claude-sonnet-4-6`)
   * @param opts.loader - Optional TUI plugin loader. When provided, its tools
   *   merge with the core tools and its PROMPT.md fragments are appended to
   *   the system prompt's session-context block.
   * @param opts.sendFn - Injectable Messages API function (defaults to the
   *   real client). Testing seam.
   */
  constructor(opts: {
    auth: AuthResult
    model?: string
    effort?: string
    thinkingDisplay?: "summarized" | "omitted"
    loader?: PluginLoader | null
    modeManager?: ModeManager | null
    /**
     * Optional save-echo collector (see {@link Agent.saveEcho}). The
     * structural type avoids a hard dependency on the memory plugin's
     * implementation : `src/index.ts` constructs and injects it.
     */
    saveEcho?: { consumeAll(): ContentBlock[] } | null
    /**
     * Optional short-term snapshot producer (see
     * {@link Agent.shortTermSnapshot}). Same structural-type pattern.
     */
    shortTermSnapshot?: { toAttachment(): ContentBlock | null } | null
    sendFn?: typeof sendMessage
    store?: SessionStore | null
    /**
     * Pre-existing conversation to seed the agent with (used by
     * `--resume <sid>` to rehydrate from a saved log). Pushed onto
     * `this.messages` verbatim. The store, if any, is NOT re-written :
     * resume opens its store with `existsOk: true` so subsequent turns
     * append to the same file.
     */
    initialMessages?: Message[]
  }) {
    this.auth = opts.auth
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.effort = opts.effort
    this.thinkingDisplay = opts.thinkingDisplay
    this.loader = opts.loader ?? null
    this.modeManager = opts.modeManager ?? null
    this.saveEcho = opts.saveEcho ?? null
    this.shortTermSnapshot = opts.shortTermSnapshot ?? null
    this.sendFn = opts.sendFn ?? sendMessage
    this.store = opts.store ?? null
    if (opts.initialMessages && opts.initialMessages.length > 0) {
      for (const m of opts.initialMessages) this.messages.push(m)
    }
  }

  /** Access the plugin loader, if one was attached. */
  pluginLoader(): PluginLoader | null {
    return this.loader
  }

  /** Access the mode manager, if one was attached. */
  modes(): ModeManager | null {
    return this.modeManager
  }

  /** Currently active mode, or null when none. Convenience for the REPL. */
  getActiveMode(): ManifestMode | null {
    return this.modeManager?.active() ?? null
  }

  /** Currently configured model id used for outgoing requests. */
  getModel(): string {
    return this.model
  }

  /**
   * Replace the active model id. Takes effect on the next `run()` / `send()`.
   * The conversation history is preserved so subsequent turns continue with
   * the new model.
   */
  setModel(model: string): void {
    this.model = model
  }

  /**
   * Roll back the trailing user turn(s) that were not paired with an
   * assistant reply. Used after a request fails so the next attempt does
   * not send back-to-back user messages (which the API rejects for
   * alternating-role reasons), and so the user can resubmit cleanly.
   *
   * IMPORTANT: a user message that carries `tool_result` blocks is the
   * required pairing for the previous assistant `tool_use` : popping it
   * would leave a dangling tool_use, and every subsequent request would
   * 400 with "tool_use ids were found without tool_result blocks
   * immediately after". So we stop rolling back as soon as we hit such a
   * message and leave it in place. The actual API failure for that turn
   * is handled by re-sending, not by amputating history.
   *
   * @returns true if at least one message was discarded.
   */
  rollbackPendingTurn(): boolean {
    let removed = false
    while (
      this.messages.length > 0 &&
      this.messages[this.messages.length - 1].role !== "assistant"
    ) {
      const last = this.messages[this.messages.length - 1]
      const hasToolResult =
        Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")
      if (hasToolResult) break
      this.messages.pop()
      removed = true
    }
    return removed
  }

  /**
   * Send a user message and run the full agentic tool loop.
   *
   * Runs `send → execute_tools → send_results → ...` until the model returns
   * a response with no `tool_use` blocks (i.e. it's done) or the
   * {@link maxToolRounds} safety limit is hit.
   *
   * **What gets yielded**: only text chunks from the assistant's text blocks.
   * Tool calls and their outputs are NOT yielded : they're logged to stderr
   * with formatted previews so you can see what's happening without
   * polluting stdout.
   *
   * **What goes into history**: every assistant response (including thinking
   * and tool_use blocks) and every tool_result message is appended.
   *
   * @param userText - The user's message content
   * @param opts - Optional overrides for the underlying send (max_tokens, etc.)
   * @yields Text chunks from `text_delta` SSE events as they arrive
   * @returns The final {@link StreamedResponse} from the last API call
   *
   * @example
   * ```ts
   * const gen = agent.run("count the .ts files in src/");
   * while (true) {
   *   const { done, value } = await gen.next();
   *   if (done) {
   *     console.log("\nstop reason:", value.stopReason);
   *     break;
   *   }
   *   process.stdout.write(value);
   * }
   * ```
   */
  async *run(
    userText: string,
    opts?: Partial<SendOptions> & {
      onTranscriptLine?: (line: string) => void
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      /**
       * Optional. Fires when a `text` content_block stops streaming.
       * Useful for hosts that maintain per-text-block state : most
       * notably, the response formatter (e.g. `mdstream`): the same
       * formatter subprocess is shared across all sub-turns of a
       * `run()`, and without a per-block boundary its paragraph buffer
       * concatenates two unrelated sentences ("…before writing.I have
       * a complete picture…") at end-of-run. Use this hook to commit
       * the formatter's per-block partial (e.g. end+respawn) at the
       * right seam: AFTER the just-streamed text, BEFORE any tool_use
       * block lands in scrollback. See {@link SendMessageOptions.onTextStop}
       * for the canonical doc.
       */
      onTextStop?: () => MaybePromise<void>
      /**
       * Optional. Called at each tool-loop boundary (right after tool
       * results are computed, before the next API request). Returns text
       * the host wants to inject into the *current* turn as a follow-up
       * user message (queued user input). When non-null/non-empty, the
       * returned text is appended as a `text` content block to the same
       * user message that carries the tool_results, so the model sees
       * "tool outputs + new user instruction" in one user turn. Returning
       * `null` or `""` skips injection. The host owns the queue; this
       * callback is the drain.
       */
      drainQueuedUserText?: () => string | null
      /**
       * Optional. Notification hook fired immediately AFTER queued user
       * text has been injected at a tool-loop boundary. Use this to
       * commit the injected text to the host's scrollback (so the user
       * sees their queued message materialize, mirroring what an
       * editor.submit would have written). Distinct from
       * `onTranscriptLine` because the visual treatment for queued user
       * input usually mirrors a normal user prompt (e.g. `❯ <text>`),
       * not a tool transcript block (`╭ │ └`).
       */
      onQueueInject?: (text: string) => void
      /**
       * Optional cancellation signal for the entire turn. When aborted:
       *   - any in-flight `sendMessage` HTTP/2 stream is torn down,
       *   - any in-flight `executeTool` (Bash child process, etc.) is killed,
       *   - the generator throws `AbortError` so the caller can branch.
       *
       * The agent does NOT swallow the abort here : partial assistant
       * blocks are NOT pushed onto `messages[]` (the rollback path is the
       * caller's responsibility via {@link Agent.rollbackPendingTurn}).
       */
      signal?: AbortSignal
    },
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    // Split transport opts from the transcript callback. sendFn must not see
    // onTranscriptLine or the queue-injection hooks.
    const {
      onTranscriptLine,
      onThinkingStart,
      onThinkingChunk,
      onThinkingStop,
      onTextStop,
      drainQueuedUserText,
      onQueueInject,
      signal,
      ...sendOpts
    } = opts ?? {}
    const thinkingStart = onThinkingStart
    const onThinkingDelta = onThinkingChunk ?? sendOpts.onThinkingDelta
    const thinkingStop = onThinkingStop
    const textStop = onTextStop
    const writeTranscript = (line: string): void => {
      if (onTranscriptLine) onTranscriptLine(line)
      else console.error(line)
    }

    // Initial user message. If a mode toggle is pending advertisement,
    // prepend a `<mode-change>` text block : see ModeManager.consumePendingAttachment.
    // The attachment rides on the rolling-tail breakpoint (which is
    // invalidated every turn anyway by the user message changing), so
    // mode toggles cost zero additional cache invalidation. The system
    // prompt and tool list are mode-independent under this design.
    // Initial user message. Prepended attachments (in this order):
    //
    //   1. <mode-change from="…" to="…" />            : pending mode toggle.
    //   2. <short-term-memory>…</short-term-memory>    : session scratchpad.
    //   3. <memory-saved scope="…" id="…">…</…>+      : id echo for any
    //      memory(ies) the model saved on the previous turn.
    //   4. user text                                   : the actual user input.
    //
    // ORDER NOTE: short-term snapshot comes before save-echoes because
    // it's the persistent context the model needs every turn ("what we're
    // currently tracking"); save-echoes are deltas from the last turn and
    // read more naturally as a coda before the user text.
    const initialUserContent: ContentBlock[] = []
    const initialModeAttach = this.modeManager?.consumePendingAttachment() ?? null
    if (initialModeAttach) initialUserContent.push(initialModeAttach)
    const stmAttach = this.shortTermSnapshot?.toAttachment() ?? null
    if (stmAttach) initialUserContent.push(stmAttach)
    const initialSaveEchoes = this.saveEcho?.consumeAll() ?? []
    for (const e of initialSaveEchoes) initialUserContent.push(e)
    initialUserContent.push({ type: "text", text: userText })
    this.messages.push({
      role: "user",
      content: initialUserContent,
    })
    this.store?.appendUser(initialUserContent)

    let rounds = 0
    let lastResponse: StreamedResponse = {
      blocks: [],
      text: "",
      stopReason: null,
    }

    // Plugin system prompt + tools are computed once per run (plugins don't
    // change mid-turn). MODE STATE IS DELIBERATELY NOT COUPLED INTO THE
    // CACHED PREFIX:
    //   - Mode behavior text lives in each mode plugin's PROMPT.md, which
    //     is part of `pluginBlock` and is byte-stable across toggles.
    //   - Disallowed tools are gated at dispatch time below
    //     (modeManager.isToolAllowed) : the request still advertises
    //     every tool, so the `tools` array is byte-stable too.
    //   - The activation signal ("from = X, to = Y") rides as a small
    //     <mode-change> text block on the next user turn : see the
    //     consumePendingAttachment() calls above and below. That block
    //     sits behind the rolling-tail breakpoint that's invalidated
    //     every turn anyway, so mode toggles cost zero extra cache.
    // Use the async variant so plugin-contributed prompt fragments
    // (env-info, etc.) get awaited+memoized. The first turn pays the
    // fragment-resolution cost (bounded by each fragment's `timeoutMs`,
    // default 2s); subsequent turns hit the cache. The sync `getPromptBlock`
    // is reserved for the session hash in src/index.ts so volatile fragment
    // content (date, terminal size) doesn't bust resume drift detection.
    const pluginBlock = (await this.loader?.getPromptBlockAsync()) ?? null
    const system = pluginBlock ? buildSystemPrompt({ sessionContext: pluginBlock }) : undefined
    const allTools: ToolDefinition[] = this.loader
      ? [...TOOL_DEFINITIONS, ...(this.loader.getExtraTools() as ToolDefinition[])]
      : [...TOOL_DEFINITIONS]
    // Build a presentation map (icon + color) keyed by tool name for transcript
    // rendering, then strip those cosmetic fields before sending to the API.
    const toolPresentation = new Map<string, { icon?: string; color?: string }>()
    for (const t of allTools) {
      if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
    }
    // Mirror canonical presentation into alias slots so a tool_use the model
    // emits with an old/legacy name still renders with the canonical icon
    // and color in the transcript header. Aliases themselves are NOT in
    // `allTools` (the loader's `getExtraTools` advertises only canonical
    // names to the model); we read them straight from the loader.
    if (this.loader) {
      for (const [alias, canonical] of this.loader.getToolAliases()) {
        const pres = toolPresentation.get(canonical)
        if (pres && !toolPresentation.has(alias)) toolPresentation.set(alias, pres)
      }
    }
    const mergedTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }> = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    while (rounds < this.maxToolRounds) {
      // Short-circuit if the caller already aborted (e.g. user pressed Esc
      // while we were between API rounds). Without this, an abort that
      // landed during tool execution would still trigger a follow-up
      // sendFn call that immediately throws : wastes a network round-trip
      // and produces a confusing error path. Throw `AbortError` so the
      // caller's catch can branch on `err.name === "AbortError"`.
      if (signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      rounds++

      // Send messages to API. Mark the last block of the last message with a
      // rolling cache_control breakpoint so the growing transcript stays cached
      // across turns (see withRollingCacheBreakpoint).
      const gen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        tools: mergedTools,
        system,
        ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
        ...(this.thinkingDisplay
          ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
          : {}),
        ...sendOpts,
        ...(thinkingStart ? { onThinkingStart: thinkingStart } : {}),
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(thinkingStop ? { onThinkingStop: thinkingStop } : {}),
        ...(textStop ? { onTextStop: textStop } : {}),
        ...(signal ? { signal } : {}),
      })

      let response: StreamedResponse | undefined
      while (true) {
        const { done, value } = await gen.next()
        if (done) {
          response = value as unknown as StreamedResponse
          break
        }
        yield value
      }

      lastResponse = response ?? { blocks: [], text: "", stopReason: null }

      // Append assistant response to history
      if (lastResponse.blocks.length > 0) {
        this.messages.push({ role: "assistant", content: lastResponse.blocks })
        this.store?.appendAssistant(
          lastResponse.blocks,
          lastResponse.stopReason,
          // usage isn't surfaced on StreamedResponse yet : leave undefined
          // and add it later when the client exposes it.
          undefined,
        )
      }

      // Check for tool use blocks
      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")

      if (toolBlocks.length === 0) {
        // No tool calls : model is done
        break
      }

      // Execute tools and collect results
      const toolResults: ToolResultBlock[] = []
      for (const tool of toolBlocks) {
        const pres = toolPresentation.get(tool.name)
        const labelColor =
          pres?.color && (c as Record<string, (s: string) => string>)[pres.color]
            ? (c as Record<string, (s: string) => string>)[pres.color]
            : c.orange
        const icon = pres?.icon ? `${labelColor(pres.icon)} ` : ""
        // Pass live terminal width so single-line Bash commands that
        // would overflow get soft-split at top-level operators (`&&`,
        // `||`, `|`, `;`) into `↳`-prefixed continuation rows. See
        // `src/bash-split.ts` for the splitter and activation predicate.
        const renderCols = process.stdout.columns
        writeTranscript(
          `\n  ${c.dimCyan("╭")} ${icon}${c.bold(labelColor(tool.name))}  ${c.dim(formatToolInput(tool, renderCols))}`,
        )
        // Continuation rows. Two shapes:
        //   - `> <line>` : PS2-style for `\n`-separated multi-line input
        //     (heredocs, for-loops). Existing behavior.
        //   - `↳ <op> <body>` : soft-split for overflowing single-line
        //     pipelines. Operator leads each row (shfmt convention).
        // Both use the same `│` connector. Empty for non-Bash and for
        // single-line Bash that fits the width.
        for (const cont of formatToolInputContinuation(tool, renderCols)) {
          writeTranscript(`  ${c.dimCyan("│")} ${c.dim(cont)}`)
        }
        // Header→body separator: a single empty gutter row (`│` glyph, no
        // payload). Always emitted, regardless of body length, so the visual
        // shape of every tool block is consistent : short outputs get the
        // same breather as long ones. Inherited by both the streamed-Bash
        // path (which writes `│ <line>` rows directly into scrollback) and
        // the post-block render path (`formatToolPreview`). The refusal
        // branch below also inherits it; if we ever decide that a denied
        // tool should sit closer to its header, gate this single line on
        // `gate.allowed` and the change is local.
        writeTranscript(`  ${c.dimCyan("│")}`)

        let content: string
        let isError: boolean | undefined
        let display: string | undefined
        let truncInfo: TruncationInfo | undefined
        let streamedRendered = false

        // Mode dispatch gate. Tools stay registered in the request body
        // (so the cached prefix is mode-independent), but the harness
        // refuses to actually invoke a tool the active mode disallows.
        // The synthesized error tool_result teaches the model how to
        // adapt : see ManifestMode.refusalHint. No spinner, no execution
        // side effects.
        const gate = this.modeManager?.isToolAllowed(tool.name) ?? { allowed: true as const }
        if (!gate.allowed) {
          content = gate.message
          isError = true
          // Render a denial line in the transcript so the user sees what
          // got blocked. ⊘ glyph + dim red label + the refusal message.
          writeTranscript(`  ${c.dimCyan("│")} ${c.boldRed("⊘")} ${c.dim(content)}`)
          writeTranscript(
            `  ${c.dimCyan("╰")} ${c.dim(`(refused by ${this.modeManager?.activeId() ?? "mode"})`)}`,
          )
        } else {
          const toolStatus = GLOBAL_STATUS_BUS.create(`Running ${tool.name}`, {
            notificationId: "tool.running",
            category: "tool",
          })

          try {
            if (this.loader?.hasTool(tool.name)) {
              // Plugin-provided tool: delegate to the loader dispatcher. Plugin
              // handlers may draw their own interactive UI; we do not preview
              // their stdout here.
              const pluginResult = await this.loader.dispatch(
                {
                  type: "tool",
                  name: tool.name,
                  input: tool.input,
                  tool_use_id: tool.id,
                },
                process.cwd(),
              )
              if (pluginResult.kind === "tool_result") {
                content = pluginResult.content
                isError = pluginResult.is_error
                display = pluginResult.display
              } else {
                content = `Plugin tool "${tool.name}" returned a non-tool_result value`
                isError = true
              }
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
              const isBash = tool.name === "Bash"
              const STREAM_BUDGET = TOOL_PREVIEW_LINES[tool.name] ?? TOOL_PREVIEW_LINES_DEFAULT
              let streamedLineCount = 0
              let bufferedLastLine: string | null = null
              let pendingChunk = ""
              let didStream = false

              const flushLineToBuffer = (raw: string) => {
                didStream = true
                if (streamedLineCount >= STREAM_BUDGET) {
                  streamedLineCount++
                  return
                }
                if (bufferedLastLine !== null) {
                  writeTranscript(`  ${c.dimCyan("│")} ${c.dim(bufferedLastLine)}`)
                }
                let line = raw
                if (displayWidth(line) > TOOL_PREVIEW_LINE_WIDTH) {
                  const trimmed = truncateDisplayWidth(line, TOOL_PREVIEW_LINE_WIDTH, "")
                  // eslint-disable-next-line typescript-eslint/no-misused-spread
                  const cpCut = [...line].length - [...trimmed].length
                  line = `${trimmed}${truncHint(cpCut, "ch")}`
                }
                bufferedLastLine = line
                streamedLineCount++
              }

              const onChunk = (s: string) => {
                pendingChunk += s
                let nl: number
                while ((nl = pendingChunk.indexOf("\n")) !== -1) {
                  flushLineToBuffer(pendingChunk.slice(0, nl))
                  pendingChunk = pendingChunk.slice(nl + 1)
                }
              }

              const result = await executeTool(tool.name, tool.input, {
                signal,
                onStdout: isBash ? onChunk : undefined,
                onStderr: isBash ? onChunk : undefined,
              })
              content = result.content
              isError = result.is_error
              display = result.display
              truncInfo = result._truncInfo

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
                const streakNote = this.feedbackTracker.observe(
                  tool.name,
                  truncInfo?.truncated ?? false,
                )
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
                  streamedLineCount,
                  budget: STREAM_BUDGET,
                  truncInfo,
                  isError,
                  writeTranscript,
                })
                streamedRendered = true
              }
            }
          } finally {
            toolStatus.clear()
          }

          if (!streamedRendered) {
            for (const line of formatToolPreview(content, isError, display, {
              tool: tool.name,
              info: truncInfo,
            })) {
              writeTranscript(line)
            }
          }
        }

        const resultBlock: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: tool.id,
          content,
          is_error: isError,
        }
        toolResults.push(resultBlock)
        this.store?.appendToolResult(resultBlock)
      }

      // Send tool results back. Before the next API request, give the host
      // a chance to drain queued user text and inject it into THIS user
      // message, alongside the tool_results : this is the fastest natural
      // injection point for "I want to add context mid-loop without
      // canceling" because it rides the existing user→assistant turn
      // boundary. If injected, mirror it into the store as a separate
      // text-only user payload so session replay can distinguish queued
      // injection from the tool_result message itself.
      // ORDER MATTERS: the Anthropic API requires `tool_result` blocks to
      // come *immediately* after the prior assistant `tool_use` : i.e.
      // they must be the first blocks of this user message. A
      // `<mode-change>` text block (or any other text) in front of them
      // produces:
      //   "tool_use ids were found without tool_result blocks
      //    immediately after"
      // and 400s the entire turn. So tool_results go FIRST; the
      // mode-change attachment trails them. The model still sees the
      // mode shift in the same user turn, just after the results, which
      // is fine : the activation block is advisory, not load-bearing.
      // consumePendingAttachment is idempotent: returns null if no
      // toggle has happened since the last consume, so steady-state
      // turns pay nothing. This ordering is also cache-safe: the
      // rolling breakpoint just lands on whatever the last block is,
      // and the historical prefix (prior turns) is untouched.
      const userContent: ContentBlock[] = []
      // Same ordering rule as initial seam, with two changes for the
      // loop: tool_result blocks MUST come first (Anthropic API
      // requirement), and we do NOT re-emit the short-term snapshot
      // (already sent at the initial seam this turn : re-emitting on
      // every tool round just balloons the conversation with stale
      // repeats; the model can call MemoryTool to re-fetch if it cares).
      userContent.push(...toolResults)
      const loopModeAttach = this.modeManager?.consumePendingAttachment() ?? null
      if (loopModeAttach) userContent.push(loopModeAttach)
      const loopSaveEchoes = this.saveEcho?.consumeAll() ?? []
      for (const e of loopSaveEchoes) userContent.push(e)
      const queuedText = drainQueuedUserText?.() ?? null
      if (queuedText && queuedText.trim().length > 0) {
        userContent.push({ type: "text", text: queuedText })
        this.store?.appendUser([{ type: "text", text: queuedText }])
        onQueueInject?.(queuedText)
      }
      this.messages.push({ role: "user", content: userContent })
    }

    if (rounds >= this.maxToolRounds) {
      writeTranscript(
        `\n  ${c.boldYellow("!")} ${c.yellow(`Safety limit reached (${this.maxToolRounds} tool rounds)`)}`,
      )
    }

    return lastResponse
  }

  /**
   * Send a user message without enabling tools : single round-trip.
   *
   * Use this when you want a plain text reply without the agentic loop.
   * The model will not be told about any tools, so it cannot call them.
   * For agentic behavior, use {@link run} instead.
   *
   * @param userText - The user's message content
   * @param opts - Optional overrides for the underlying send
   * @yields Text chunks from `text_delta` SSE events as they arrive
   * @returns The {@link StreamedResponse} containing all content blocks
   */
  async *send(
    userText: string,
    opts?: Partial<SendOptions>,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    this.messages.push({
      role: "user",
      content: [{ type: "text", text: userText }],
    })

    const gen = sendMessage({
      auth: this.auth,
      messages: withRollingCacheBreakpoint(this.messages),
      model: this.model,
      ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
      ...(this.thinkingDisplay
        ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
        : {}),
      ...opts,
    })

    let response: StreamedResponse | undefined
    while (true) {
      const { done, value } = await gen.next()
      if (done) {
        response = value as unknown as StreamedResponse
        break
      }
      yield value
    }

    const result = response ?? { blocks: [], text: "", stopReason: null }

    if (result.blocks.length > 0) {
      this.messages.push({ role: "assistant", content: result.blocks })
    }

    return result
  }

  /**
   * Return a defensive copy of the conversation history.
   *
   * The internal {@link messages} array is read-only by convention but
   * not enforced; this method exists so external code can safely iterate
   * without risking mutation.
   */
  history(): Message[] {
    return [...this.messages]
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Per-tool char cap for the bordered tool **header** line ("╭ Bash $ ..."),
 * applied only when the input field truly overflows. The cap is generous
 * (500 chars for Bash, 200 for the JSON fallback) : much wider than the
 * old 80-ch hard slice that often cut Bash commands mid-token. We never
 * pad to terminal width; if the line overflows the terminal cells, the
 * terminal wraps and that's fine.
 */
const HEADER_BASH_MAX = 500
const HEADER_JSON_MAX = 200

/**
 * Trim `s` to at most `max` characters, preferring a word boundary so we
 * don't cut mid-token. The primary failure mode of the old hard slice
 * was things like `… | head...(+4ch)` : four characters short of
 * `head -50`, useless. Here we walk back to the last whitespace within
 * the trailing 15% of the budget and prefer it over a hard cut. If no
 * whitespace exists in that window (single-token blob), we fall through
 * to the hard cut so we never balloon past `max` itself.
 */
function trimAtWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s
  const slack = Math.floor(max * 0.15)
  const window = s.slice(0, max)
  // Find the last whitespace within the last `slack` chars of the window.
  const wsIdx = window.search(/\s\S*$/)
  if (wsIdx >= max - slack) return s.slice(0, wsIdx)
  return window
}

/**
 * Max continuation lines we render for a multi-line Bash command in the
 * bordered block before collapsing the rest into a `> ... +NL more` row.
 * Generous enough to show typical heredocs / for-loops / function bodies
 * without dominating the screen.
 */
const BASH_CONT_MAX_LINES = 8

/**
 * Format a `tool_use` block's input for the bordered tool header. Picks
 * the most informative field per tool (command for Bash, file_path for
 * file tools, pattern for search tools). Falls back to JSON-stringified
 * input for unknown tools.
 *
 * Returns ONLY the header line (single-line, no embedded newlines).
 * Multi-line Bash commands render their continuation via the sibling
 * {@link formatToolInputContinuation} : the caller writes those after the
 * header as `│ ...` rows inside the same bordered block.
 *
 * # Style: programmer-native + dot-separated chunks
 *
 * Beyond the primary field (path/pattern/command), each tool can carry
 * "subordinate" inputs : `offset`/`limit` for Read, `replace_all` for
 * Edit, `path`/`glob`/`-i`/`-A`/etc. for Grep. Surfacing them in the
 * header is what lets the user see *what was actually run* (e.g.
 * "Read first 4 lines" vs. "Read whole file" : same tool name, very
 * different operation).
 *
 * The vocabulary is "Style A" : programmer-native shorthand:
 *
 *  - **Read**: `<path> · L<start>-<end>` (closed range, 1-indexed to match
 *    the body's line-number gutter), or `· from L<start>` (open-ended,
 *    `offset` only). Bare reads (neither set) render byte-identical to
 *    the pre-extras form.
 *  - **Edit**: `<path> · g` for `replace_all` (sed `s/.../.../g` flavor).
 *  - **Glob**: `<pattern> · in <path>` when `path` is set.
 *  - **Grep**: regex flags appended to the pattern (`/foo/i` for `-i`,
 *    `/foo/m` for `multiline`, `/foo/im` for both). Modifiers chain after
 *    ` · `: `in <path>` (where), `<glob>` (filter), `↓N`/`↑N`/`↕N` (after/
 *    before/around context : `-C` takes precedence over `-A`/`-B` since
 *    it's symmetric), `≤N` (`head_limit`), `count`/`paths` (output mode).
 *
 * The ` · ` mid-dot is the same separator used in the truncation footer
 * (`shown 15/1831 L · 8.0 KB/1.5 MB · cut at L1000`), keeping a single
 * visual language across the tool block.
 *
 * Truncation strategy:
 *  - **Bash**: first line only (multi-line continuation rendered separately
 *    by {@link formatToolInputContinuation}); word-boundary trim at 500 chars.
 *  - **Read/Write/Edit/Glob/Grep**: file_path / pattern only : typically
 *    well under 200 chars; no truncation in the common case. Composed
 *    Grep headers (all flags set) come in under ~80 cells in practice;
 *    if real usage ever overflows, prioritize pattern → path → context.
 *  - **Unknown**: JSON.stringify, hard slice at 200 chars (unknown tools
 *    have unknown shape, so word boundaries aren't meaningful).
 */
export function formatToolInput(tool: ToolUseBlock, cols?: number): string {
  const input = tool.input
  if (tool.name === "Bash" && input.command) {
    const cmd = String(input.command)
    const firstNl = cmd.indexOf("\n")
    const firstLine = firstNl === -1 ? cmd : cmd.slice(0, firstNl)
    // Width-aware soft-split: when the first \n-line would overflow the
    // available terminal cells, route through `splitBashSegments` and
    // use only the lead segment in the header. The remaining segments
    // are emitted as `↳`-prefixed continuation rows by
    // `formatToolInputContinuation`, followed by the existing PS2 `> `
    // rows for any subsequent \n-lines (heredoc bodies, inline scripts).
    //
    // Soft-split applies to the FIRST \n-line independent of whether
    // there are more \n-lines after it : early versions gated this on
    // `firstNl === -1`, which made multi-line commands (python3 -c with
    // embedded \n, heredocs, for-loops) bypass soft-split entirely and
    // let the long first line truncate+wrap. Reported by user, May 2026.
    //
    // Default `cols` rule: when neither arg nor TTY width is available
    // (e.g. unit tests, piped output), treat as Infinity so we never
    // trigger soft-split : the lead-only header would otherwise be a
    // regression for non-TTY callers.
    const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY
    const headerBody = shouldSoftSplit(firstLine, effectiveCols)
      ? splitBashSegments(firstLine).lead || firstLine
      : firstLine
    const trimmed = trimAtWordBoundary(headerBody, HEADER_BASH_MAX)
    const charsCut = headerBody.length - trimmed.length
    const truncated = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
    // Header line only : continuation rendered by formatToolInputContinuation.
    return `$ ${truncated}`
  }
  if (tool.name === "Read" && input.file_path) {
    const path = String(input.file_path)
    // `offset` is zero-based in the schema; `execRead` prints body lines
    // 1-indexed (`${start + i + 1}\t…`), so we surface the same 1-indexed
    // range here and the header promise matches what the body shows.
    // Bare reads (no offset/limit) render byte-identical to the
    // pre-extras form : the common case is undisturbed.
    const off = typeof input.offset === "number" ? input.offset : undefined
    const lim = typeof input.limit === "number" ? input.limit : undefined
    if (off === undefined && lim === undefined) return path
    const startL = (off ?? 0) + 1
    if (lim !== undefined) return `${path} · L${startL}-${startL + lim - 1}`
    return `${path} · from L${startL}`
  }
  if (tool.name === "Write" && input.file_path) {
    return String(input.file_path)
  }
  if (tool.name === "Edit" && input.file_path) {
    const path = String(input.file_path)
    // `g` flag : borrowed from sed's `s/old/new/g`. Cheap, recognizable,
    // attaches the modifier visually to the path it modifies.
    return input.replace_all ? `${path} · g` : path
  }
  if (tool.name === "Glob" && input.pattern) {
    const pat = String(input.pattern)
    return input.path ? `${pat} · in ${input.path}` : pat
  }
  if (tool.name === "Grep" && input.pattern) {
    // Pattern carries its own JS-regex flags: `i` for -i, `m` for
    // multiline. Then ` · ` between major chunks: where (path, then
    // optional glob filter), context (↑↓↕N), head limit (≤N), output
    // mode. `-n` (line numbers) is intentionally not surfaced : it's the
    // default and would just clutter.
    const flags = `${input["-i"] ? "i" : ""}${input.multiline ? "m" : ""}`
    const parts: string[] = [`/${input.pattern}/${flags}`]
    if (input.path) parts.push(`in ${input.path}`)
    if (input.glob) parts.push(String(input.glob))
    // Context arrows. `-C N` (or its `context` alias) takes precedence :
    // it's symmetric so `↕` reads more naturally than two arrows. When
    // only `-A`/`-B` are set, render whichever (or both) are present.
    const ctxC = (input["-C"] as number | undefined) ?? (input.context as number | undefined)
    if (typeof ctxC === "number") {
      parts.push(`↕${ctxC}`)
    } else {
      if (typeof input["-A"] === "number") parts.push(`↓${input["-A"]}`)
      if (typeof input["-B"] === "number") parts.push(`↑${input["-B"]}`)
    }
    if (typeof input.head_limit === "number") parts.push(`≤${input.head_limit}`)
    if (input.output_mode === "count") parts.push("count")
    else if (input.output_mode === "files_with_matches") parts.push("paths")
    return parts.join(" · ")
  }
  const json = JSON.stringify(input)
  const charsCut = json.length > HEADER_JSON_MAX ? json.length - HEADER_JSON_MAX : 0
  return charsCut > 0 ? `${json.slice(0, HEADER_JSON_MAX)}${truncHint(charsCut, "ch")}` : json
}

/**
 * Continuation rows for a multi-line tool input : rendered as `│ ...` rows
 * between the header and the output. Currently emits rows only for
 * multi-line **Bash** commands; other tools have single-line headers.
 *
 * Each returned line carries a leading `> ` (mirroring bash's secondary
 * prompt) so it's visually distinguishable from output rows (which have
 * no prefix). Heredoc-shaped commands like:
 *
 * ```
 *   $ cat > /tmp/x.txt << "EOF"
 *   foo
 *   bar
 *   EOF
 * ```
 *
 * render as:
 *
 * ```
 *   ╭ » Bash  $ cat > /tmp/x.txt << "EOF"
 *   │ > foo
 *   │ > bar
 *   │ > EOF
 *   ╰ (no output)
 * ```
 *
 * Capped at {@link BASH_CONT_MAX_LINES} (default 8). Beyond the cap, a
 * synthetic last row reads `> ... +NL more` so the user knows the rest
 * was elided. Per-line word-boundary trim mirrors `formatToolInput`'s
 * 500-char Bash budget.
 */
export function formatToolInputContinuation(tool: ToolUseBlock, cols?: number): string[] {
  const input = tool.input
  if (tool.name !== "Bash" || !input.command) return []
  const cmd = String(input.command)
  const all = cmd.split("\n")
  const firstLine = all[0] ?? ""
  const tail = all.slice(1)
  const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY

  // Zone A : soft-split rows for the FIRST \n-line. Activates whenever
  // the first line would overflow AND has top-level operators
  // (`&&`, `||`, `|`, `;`) : independent of whether there are more
  // \n-lines after it. Each row is prefixed `↳ ` and leads with the
  // operator (shellcheck/shfmt convention). Visually distinct from
  // Zone B's `> ` PS2 rows.
  const softSplitRows: string[] = (() => {
    if (!shouldSoftSplit(firstLine, effectiveCols)) return []
    const { rest } = splitBashSegments(firstLine)
    if (rest.length === 0) return []
    return rest.map(({ op, body }) => {
      const segLine = `${op} ${body}`
      const trimmed = trimAtWordBoundary(segLine, HEADER_BASH_MAX)
      const charsCut = segLine.length - trimmed.length
      const finalBody = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
      return `↳ ${finalBody}`
    })
  })()

  // Zone B : PS2 (`> `) rows for subsequent \n-lines (heredoc bodies,
  // inline scripts, for-loop bodies). Existing behavior, preserved.
  const ps2Rows: string[] = tail.map((line) => {
    const trimmed = trimAtWordBoundary(line, HEADER_BASH_MAX)
    const charsCut = line.length - trimmed.length
    const body = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
    return `> ${body}`
  })

  // Combined cap. Concatenate Zone A then Zone B, then clip to
  // `BASH_CONT_MAX_LINES` with a single trailing elision row that
  // counts both elided categories together. Putting the cap on the
  // combined list (rather than per-zone) keeps the visual block from
  // ballooning when a model emits a long pipeline AND a multi-line
  // heredoc body in the same call.
  const combined = [...softSplitRows, ...ps2Rows]
  if (combined.length === 0) return []
  if (combined.length <= BASH_CONT_MAX_LINES) return combined
  const visible = combined.slice(0, BASH_CONT_MAX_LINES)
  const elided = combined.length - visible.length
  // Elision-row prefix mirrors whichever zone the LAST visible row
  // came from, so the eye stays oriented (`↳` if we cut inside the
  // operator-split zone, `>` if we cut inside the heredoc zone).
  const lastPrefix = visible[visible.length - 1].startsWith("↳ ") ? "↳" : ">"
  visible.push(`${lastPrefix} ${truncHint(elided, "L")} more`)
  return visible
}

/**
 * Per-tool body line budget for the bordered transcript preview. Tuned by
 * shape of typical output:
 *  - **Bash**: 10 lines : output is variable; 10 covers "exit code + last
 *    few lines" without dominating the screen.
 *  - **Read**: 15 lines : content is dense (line-numbered) and structural;
 *    a few extra lines is high-value.
 *  - **Grep**: 12 lines : content mode; for files-only / count modes
 *    we'd want more, but those are explicit user choices and rarely hit
 *    the cap.
 *  - **Glob**: 25 lines : paths are short, dense, easy to scan.
 *  - **Default**: 10 lines : sensible mid-range for unknown tools.
 *
 * These are TUI display caps, not API caps. The model still sees up to
 * the universal {@link MAX_TOOL_OUTPUT_LINES} (1000 lines) per
 * `tool_result.content`. See `src/tools/truncation.ts` for the API cap.
 */
const TOOL_PREVIEW_LINES: Record<string, number> = {
  Bash: 10,
  Read: 15,
  Grep: 12,
  Glob: 25,
  Edit: 1000, // diff display channel; effectively unbounded
  Write: 1000,
}
const TOOL_PREVIEW_LINES_DEFAULT = 10

/**
 * Per-line display-width cap for body lines. A single 10_000-char minified
 * JSON line in a Read result shouldn't dominate the preview; clamp to a
 * fixed value (NOT terminal width : we don't reflow on resize). 300 chars
 * is generous enough to read most code and structured output without one
 * pathological line eating the screen.
 */
const TOOL_PREVIEW_LINE_WIDTH = 300

/**
 * Format the body of a `tool_result` for the bordered transcript preview.
 *
 * Audience split (this matters): the **model** receives the full clamped
 * `content` including the trailing `[truncated: shown N of M bytes ...]`
 * notice with its action-verb resume hint. The **TUI** (you, looking at
 * the transcript) receives this function's output: the body preview only,
 * plus a bare-facts footer (`shown N/M L · X/Y B · cut at L`) when
 * truncation happened. No verbs, no advice : those go to the model where
 * they're actionable.
 *
 * The `info` parameter, when supplied (see `executeTool`'s `_truncInfo`),
 * is the source of truth for the footer. Without it we fall back to the
 * pre-info legacy behavior (slice at 200 chars + `...(+Nch)` hint) so
 * older callers keep working.
 *
 * Per-tool body line budgets live in {@link TOOL_PREVIEW_LINES}; per-line
 * display width is capped at {@link TOOL_PREVIEW_LINE_WIDTH}.
 */
export function formatToolPreview(
  content: string,
  isError?: boolean,
  display?: string,
  opts?: { tool?: string; info?: TruncationInfo },
): string[] {
  // If the tool provided a pre-rendered display string (e.g. ANSI-colored
  // unified diff from Edit/Write), render it as-is, line by line, with the
  // standard `│ ... └` connector gutter. No truncation: diffs are the point.
  if (display && !isError) {
    const dlines = display.split("\n")
    const out: string[] = []
    for (let i = 0; i < dlines.length; i++) {
      const connector = i === dlines.length - 1 ? "╰" : "│"
      out.push(`  ${c.dimCyan(connector)} ${dlines[i]}`)
    }
    return out
  }

  const tool = opts?.tool
  const info = opts?.info
  const color = isError ? c.red : c.dim

  // 1. Strip the model-facing trailing notice from what we display to the
  //    human. The notice is everything from `\n\n[truncated: ` to the end
  //    when present. The structured `info` (when supplied) carries the
  //    same numbers in machine form : we'll render those as the bare-facts
  //    footer instead.
  const noticeIdx = content.lastIndexOf("\n\n[truncated:")
  let body = noticeIdx >= 0 ? content.slice(0, noticeIdx) : content

  // 2. Per-line width clamp (display-width-aware so wide chars / emoji /
  //    CJK don't blow past the budget).
  const maxLines = TOOL_PREVIEW_LINES[tool ?? ""] ?? TOOL_PREVIEW_LINES_DEFAULT
  const allLines = (body || "(no output)").split("\n")
  const visible = allLines.slice(0, maxLines)
  const linesElided = allLines.length - visible.length
  const renderedLines: string[] = visible.map((line) => {
    if (displayWidth(line) <= TOOL_PREVIEW_LINE_WIDTH) return line
    const trimmed = truncateDisplayWidth(line, TOOL_PREVIEW_LINE_WIDTH, "")
    // eslint-disable-next-line typescript-eslint/no-misused-spread
    const cpCut = [...line].length - [...trimmed].length
    return `${trimmed}${truncHint(cpCut, "ch")}`
  })

  // 3. Build the footer.
  //    The footer always reads "shown <visible-in-TUI> / <real-source-total>"
  //    : one ratio, two domains. The user immediately sees how much of the
  //    underlying tool result they're actually looking at.
  //    - API truncation present (info.truncated): include byte ratio
  //      (model-shown / source-total) and the cut line.
  //    - TUI-only elision (long body but the API did not clamp): just the
  //      line ratio. Bytes are uniformative when nothing was cut at the API.
  //    - Body fits within budget AND no API truncation: no footer at all.
  let footerStat: string | null = null
  if (info?.truncated) {
    footerStat = formatTruncFooter(info, visible.length)
  } else if (linesElided > 0) {
    const totalLines = info?.totalLines ?? allLines.length
    footerStat = `shown ${visible.length}/${totalLines} L`
  }

  // 4. Stitch lines + footer with the bordered gutter.
  //    When a truncation footer is present we slot a `┊` (light-dotted
  //    vertical) row between the last body line and the `╰ <footer>` row.
  //    The dotted glyph reads as "something has been cut here" : visually
  //    foreshadowing the bare-facts footer below it (e.g. `shown 10/520 L`).
  //    No `┊` is emitted on a clean run (body fits, no API clamp): in that
  //    case there's nothing missing, so the body just closes with `╰`.
  const out: string[] = []
  const totalRender = renderedLines.length
  for (let i = 0; i < totalRender; i++) {
    // Last rendered line is `╰` only when there's no footer below it.
    const isLast = i === totalRender - 1 && footerStat === null
    const connector = isLast ? "╰" : "│"
    out.push(`  ${c.dimCyan(connector)} ${color(renderedLines[i])}`)
  }
  if (footerStat !== null) {
    out.push(`  ${c.dimCyan("┊")}`)
    out.push(`  ${c.dimCyan("╰")} ${c.dim(footerStat)}`)
  }
  return out
}

/**
 * Emit the closing rows for a tool whose body was already streamed `│`-line
 * by `│`-line into scrollback (live, while the child process ran). We held
 * back the LAST emitted line so we can either:
 *
 *   - rewrite it as `╰ <line>` when there's nothing to summarize (clean
 *     run, body fits in budget, no truncation), OR
 *   - emit it as `│ <line>`, then a `┊` truncation separator, then a
 *     `╰ <footer>` row when there IS something to say (truncation, elision,
 *     or zero-output abort). The `┊` reads as "something cut here" and
 *     visually foreshadows the bare-facts footer (e.g. `shown 10/520 L`).
 *
 * Scrollback is permanent : once a `│` row is written we can't rewrite it
 * : so the buffered-last-line trick is the only way to keep the close
 * glyph attached to the body in the no-footer case.
 *
 * Mirrors the audience-split invariant in {@link formatToolPreview}: footer
 * carries bare facts (lines / bytes / cut location); no verbs / advice.
 * Mirrors its `┊`-before-`╰` convention too, so streamed and non-streamed
 * tool blocks have identical shape from the user's eye.
 */
function renderStreamedTail(opts: {
  bufferedLastLine: string | null
  streamedLineCount: number
  budget: number
  truncInfo?: TruncationInfo
  isError?: boolean
  writeTranscript: (line: string) => void
}): void {
  const { bufferedLastLine, streamedLineCount, budget, truncInfo, isError, writeTranscript } = opts
  const visibleCount = Math.min(streamedLineCount, budget)
  const color = isError ? c.red : c.dim

  let footer: string | null = null
  if (truncInfo?.truncated) {
    footer = formatTruncFooter(truncInfo, visibleCount)
  } else if (streamedLineCount > budget) {
    const totalLines = truncInfo?.totalLines ?? streamedLineCount
    footer = `shown ${visibleCount}/${totalLines} L`
  }

  if (bufferedLastLine === null) {
    // Stream produced nothing (shouldn't happen : caller only invokes us
    // when didStream=true, which implies at least one flushLineToBuffer
    // call). Defensive close glyph anyway. Skip the `┊` separator: with
    // zero body rows above it, a dotted divider has nothing to "cut from"
    // and would just look like floating noise.
    writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer ?? "(no output)")}`)
    return
  }

  if (footer === null) {
    writeTranscript(`  ${c.dimCyan("╰")} ${color(bufferedLastLine)}`)
    return
  }

  writeTranscript(`  ${c.dimCyan("│")} ${color(bufferedLastLine)}`)
  writeTranscript(`  ${c.dimCyan("┊")}`)
  writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer)}`)
}

/**
 * Format a {@link TruncationInfo} as the bare-facts footer string.
 * No verbs, no advice : totals and cut location only.
 *
 * Format: `shown <V>/<T> L · <X>/<Y> B · cut at L<L>`
 *
 *   - **V** = lines visible in the TUI right now (`tuiVisible` argument).
 *     This is what the user is looking at : the most user-relevant count.
 *   - **T** = total lines the underlying source produced (`info.totalLines`).
 *     The denominator the user cares about ("how big was this really?").
 *   - **X** = bytes shown to the model (`info.shownBytes`). Note: this is
 *     model-domain, not user-domain : the user sees fewer body bytes than
 *     the model when the TUI body budget is below the API cap. Showing
 *     model-bytes here gives the user the size of the actual `tool_result`
 *     ride-back, which is what tokens are spent on.
 *   - **Y** = total bytes from the source (`info.totalBytes`).
 *   - **L** = cut line index (`info.cutLine`).
 */
function formatTruncFooter(info: TruncationInfo, tuiVisible: number): string {
  const totalL = info.totalLines ?? info.shownLines
  const totalB = info.totalBytes ?? info.shownBytes
  const lineFrag = `shown ${tuiVisible}/${totalL} L`
  const byteFrag = `${formatBytes(info.shownBytes)}/${formatBytes(totalB)}`
  const cutFrag = `cut at L${info.cutLine}`
  return `${lineFrag} · ${byteFrag} · ${cutFrag}`
}

/** Format byte counts with K/M suffix for compactness. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// REPL
// ---------------------------------------------------------------------------

export interface ReplAgentLike {
  pluginLoader(): PluginLoader | null
  /** Optional: mode manager for prompt/status/cycling integration. */
  modes?(): ModeManager | null
  /** Optional: convenience for the active mode (if any). */
  getActiveMode?(): ManifestMode | null
  run(
    userText: string,
    opts?: {
      onTranscriptLine?: (line: string) => void
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      onTextStop?: () => MaybePromise<void>
      drainQueuedUserText?: () => string | null
      onQueueInject?: (text: string) => void
      /**
       * Optional cancellation signal. The live-area REPL forwards
       * {@link AbortBus.beginTurn}'s controller signal here so a user-press
       * Esc / Ctrl+C tears down the SDK stream and any in-flight tool
       * (Bash child gets SIGTERM → SIGKILL escalation).
       */
      signal?: AbortSignal
    },
  ): AsyncGenerator<string, StreamedResponse, undefined>
  /** Optional: current model id (for diagnostics/recovery prompts). */
  getModel?(): string
  /** Optional: switch model in place after a failure. */
  setModel?(model: string): void
  /** Optional: discard trailing user turn after a failed send. */
  rollbackPendingTurn?(): boolean
}

type ReplOutput = Pick<NodeJS.WriteStream, "write"> & {
  isTTY?: boolean
  columns?: number
  rows?: number
}

type ReplErrOutput = Pick<NodeJS.WriteStream, "write">

/**
 * Minimal subset of StatusRenderer that runRepl interacts with. Extracted
 * so tests can swap in a spy without building a full renderer.
 */
export interface StatusController {
  start(): void
  stop(): void
  suspend(): void
  resume(): void
}

type ReplInput = Pick<RawInput, "read">

/**
 * Subset of {@link Compositor} that {@link runRepl} needs in live-area mode.
 * Decoupled so tests can supply a fake without escape-sequence assertions.
 */
export interface ReplCompositor {
  mount(initialLiveHeight: number): void
  unmount(): void
  writeStream(chunk: string): void
  flushStream?(): void
  withSuspendedLiveArea<T>(fn: () => T | Promise<T>): Promise<T>
}

/**
 * Subset of {@link EditorController} that {@link runRepl} needs in
 * live-area mode. The controller emits `submit` (with text) and `cancel`.
 */
export interface ReplEditor {
  start(): void
  stop(): void
  on(event: "submit", listener: (text: string) => void): unknown
  on(event: "cancel", listener: () => void): unknown
  off?(event: "submit" | "cancel", listener: (...args: unknown[]) => void): unknown
  /** Called by the live-area status controller to push the spinner row. */
  setStatus?(text: string | null): void
  /** Called after terminal resize so live-area rows can reflow immediately. */
  notifyResize?(): void
  /**
   * Optional. Wire Shift+Tab / Ctrl+Shift+Tab to mode cycling. Live-area
   * REPL calls this when the agent has any modes loaded. Editors without
   * mode support can omit it.
   */
  setModeCycleHandlers?(forward: (() => void) | null, backward: (() => void) | null): void
  /**
   * Optional. Update the editor's prompt prefix (e.g. when the active mode
   * changes). Repaint should happen synchronously inside the call.
   */
  setPrompt?(prompt: string, continuationPrompt?: string): void
  /**
   * Optional. Render decoration rows between the status row and the editor
   * prompt : used by the REPL to display the queued-message buffer (lines
   * the user submitted while the agent was streaming, awaiting injection
   * at the next safe boundary). Pass `[]` to clear.
   */
  setDecorationLines?(lines: string[]): void
  /**
   * Optional. Render footer rows BELOW the editor input in the live area.
   * Used by plugin-contributed live-area slots (see `liveAreaSlots` in
   * the manifest schema) to surface ambient status : quota %, git
   * branch state, background-job progress : without competing with
   * what the user is typing. Pass `[]` to clear.
   *
   * Editors without footer support can omit this; the live-area
   * scheduler in `runReplLiveArea` no-ops when it's missing.
   */
  setFooterLines?(lines: string[]): void
  /**
   * Optional. Restore the editor buffer to a given text. Used by the abort
   * flow (`runReplLiveArea` → `handleAbort`) so that when the user cancels
   * an in-flight turn, the prompt they just sent is put back into the editor
   * for tweaking and resubmission. Cursor lands at the end of the inserted
   * text.
   */
  setBuffer?(text: string): void
}

/**
 * Run an interactive read-eval-print loop with full tool execution.
 *
 * Reads lines from stdin, sends each non-empty line to the agent via
 * {@link Agent.run}, and prints streamed text chunks to stdout. Tool
 * calls and outputs are logged to stderr. Exit with Ctrl+C.
 *
 * **Formatter integration**: if `opts.formatterCmd` is provided, each user
 * turn pipes the streamed text through that external process (see
 * {@link Formatter}). A fresh formatter is spawned per turn so the
 * markdown rendering state resets between user messages : this avoids
 * the formatter getting confused by stale state from previous turns.
 *
 * @param agent - Initialized agent instance
 * @param opts.formatterCmd - Optional formatter argv (e.g. `["mdstream"]`)
 *
 * @example
 * ```ts
 * await runRepl(agent);
 * await runRepl(agent, { formatterCmd: ["mdstream"] });
 * await runRepl(agent, { formatterCmd: ["bat", "--language=md", "--paging=never"] });
 * ```
 */
export async function runRepl(
  agent: ReplAgentLike,
  opts?: {
    formatterCmd?: string[]
    input?: ReplInput
    output?: ReplOutput
    errOutput?: ReplErrOutput
    statusBus?: StatusBus
    statusRenderer?: StatusController | null
    /**
     * Optional spinner instance used by the default StatusRenderer /
     * LiveAreaStatusController. Ignored when `statusRenderer` is also
     * provided. Comes from `--spinner <preset>` at the CLI layer.
     */
    spinner?: Spinner<StatusSpinnerTheme>
    /**
     * Auth used to fetch the available model list when a "model not found"
     * error happens. When omitted, the picker is skipped and we just print
     * the error and continue.
     */
    auth?: AuthResult
    /** Override for testing : defaults to the real listModels client call. */
    listModels?: (auth: AuthResult) => Promise<ModelInfo[]>
    /**
     * Enable the persistent live-area UI: the multiline input is pinned to
     * the bottom of the terminal and stays visible while the agent works.
     * Requires `compositor` and `editor` (or sensible defaults wired by the
     * caller). When false (the legacy default), `runRepl` reads turns one
     * at a time via {@link RawInput} and writes streamed output straight to
     * stdout : same as before.
     */
    useLiveArea?: boolean
    compositor?: ReplCompositor
    editor?: ReplEditor
    /** Forwarded to {@link runReplLiveArea}; see its docs. */
    initialStdinBytes?: string
  },
): Promise<void> {
  if (opts?.useLiveArea) {
    return runReplLiveArea(agent, opts)
  }
  const output = opts?.output ?? process.stdout
  const errOutput = opts?.errOutput ?? process.stderr
  const statusBus = opts?.statusBus ?? GLOBAL_STATUS_BUS
  const continuationPrompt = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? ""
  const baseArrow = `${c.bold(c.pink("❯"))} `
  const modeManager = agent.modes?.() ?? null
  const buildPrompt = (): string => (modeManager ? modeManager.promptPrefix(baseArrow) : baseArrow)
  // ❯
  const input = opts?.input ?? new RawInput(buildPrompt(), continuationPrompt)
  const statusRenderer: StatusController | null =
    opts && "statusRenderer" in opts
      ? (opts.statusRenderer ?? null)
      : output.isTTY === false
        ? null
        : new StatusRenderer(statusBus, output, { spinner: opts?.spinner })

  statusRenderer?.start()

  // Wire mode cycling: Shift+Tab cycles forward, Ctrl+Shift+Tab cycles back.
  //
  // The cycle handler runs in two contexts:
  //
  // 1. While the user is at the prompt (input is in "reading" mode): the
  //    apply() return value triggers a re-render so the new prompt prefix
  //    appears immediately.
  // 2. While a turn is streaming (input is in "ambient" mode): the prompt
  //    isn't drawn yet, so we just update the stored prompt string. The
  //    next call to `read()` will draw it.
  //
  // To deliver case 2 we put RawInput in ambient mode for the entire REPL
  // via enable() below. enable() takes persistent stdin ownership.
  if (modeManager && modeManager.hasModes() && input instanceof RawInput) {
    const onChange = () => {
      input.setPrompt(buildPrompt(), continuationPrompt)
      // If we're at the prompt, repaint so the new label appears live.
      input.redraw()
    }
    modeManager.subscribe(onChange)
    input.setModeCycleHandlers(
      () => modeManager.cycleNext(),
      () => modeManager.cyclePrev(),
    )
  }
  if (input instanceof RawInput) input.enable()

  const dot = c.faintWhite("·")
  const baseHint =
    `${c.faintWhite("enter")} ${c.bold("send")}  ${dot}  ` +
    `${c.faintWhite("shift+enter")} ${c.bold("new line")}  ${dot}  ` +
    `${c.faintWhite("ctrl+c")} ${c.bold("quit")}`
  const modeHint =
    modeManager && modeManager.hasModes()
      ? `  ${dot}  ${c.faintWhite("shift+tab")} ${c.bold("cycle mode")}`
      : ""
  output.write(
    `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n  ${baseHint}${modeHint}\n\n`,
  )

  const loader = agent.pluginLoader()

  try {
    while (true) {
      const text = await input.read()
      if (text === null) break

      if (!text.trim()) continue

      // Main response formatter : see `runReplLiveArea` for the full
      // rationale on per-text-block lifecycle (mdstream's `partial`
      // paragraph buffer would otherwise concatenate two unrelated
      // text blocks within one `run()` and smash them together at
      // end-of-turn). Lifted into a factory so `onTextStop` (below)
      // can end+respawn at every text-block seam.
      let formatter: Formatter | null = null
      const spawnMainFormatter = (): Formatter | null => {
        if (!opts?.formatterCmd) return null
        const f = new Formatter(opts.formatterCmd, output)
        f.start()
        return f
      }
      formatter = spawnMainFormatter()

      let wroteOutput = false
      let lastChunkEndedWithNewline = false
      const statusText = modeManager ? modeManager.statusLabel("Thinking") : "Thinking"
      const turnStatus = statusBus.create(statusText, {
        notificationId: "agent.thinking",
        category: "agent",
      })

      // See live-area REPL for the rationale: track text↔transcript
      // boundaries so we always render exactly one blank line between
      // streamed markdown and tool transcript blocks.
      let lastKind: "none" | "text" | "transcript" = "none"

      const writeDirectSink = (s: string) => {
        if (s.length === 0) return
        // Ensure visual separator between status/prompt and response text.
        if (!wroteOutput) {
          statusRenderer?.suspend()
          output.write("\n")
        }
        if (lastKind === "transcript") {
          statusRenderer?.suspend()
          // Use errOutput so the blank line lands in the same stream as the
          // transcript that preceded it (legacy mode splits stdout/stderr).
          errOutput.write("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        statusRenderer?.suspend()
        output.write(s)
      }

      const baseSink = (s: string) => {
        if (s.length === 0) return
        // Ensure visual separator between status/prompt and response text.
        if (!wroteOutput) {
          statusRenderer?.suspend()
          output.write("\n")
        }
        if (lastKind === "transcript") {
          statusRenderer?.suspend()
          // Use errOutput so the blank line lands in the same stream as the
          // transcript that preceded it (legacy mode splits stdout/stderr).
          errOutput.write("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        statusRenderer?.suspend()
        if (formatter) formatter.write(s)
        else output.write(s)
      }
      const pluginStream = loader ? new PluginStream(baseSink, loader, process.cwd()) : null
      let thinkingFormatter: Formatter | null = null
      const thinkingOutput = {
        get columns() {
          return output.columns
        },
        get rows() {
          return output.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
          writeDirectSink(faintThinkingChunk(s))
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const ensureThinkingFormatter = (): Formatter | null => {
        if (!opts?.formatterCmd) return null
        if (!thinkingFormatter) {
          thinkingFormatter = new Formatter(opts.formatterCmd, thinkingOutput)
          thinkingFormatter.start()
        }
        return thinkingFormatter
      }
      const endThinkingFormatter = async (): Promise<void> => {
        if (!thinkingFormatter) return
        const active = thinkingFormatter
        thinkingFormatter = null
        await active.end()
      }

      const onTranscriptLine = (line: string): void => {
        // Coordinate stderr transcript with the stdout spinner: clear the
        // spinner line before the write so nothing races the stream, then
        // resume so the next tool/round keeps its spinner.
        statusRenderer?.suspend()
        if (lastKind === "text" && !lastChunkEndedWithNewline) {
          // Close partial text line before transcript begins. The agent's
          // tool header (`\n  ┌ ...`) then yields a blank separator.
          output.write("\n")
          lastChunkEndedWithNewline = true
        }
        errOutput.write(`${line}\n`)
        lastKind = "transcript"
        statusRenderer?.resume()
      }
      const onThinkingStart = (): void => {
        ensureThinkingFormatter()
      }
      const onThinkingChunk = (chunk: string): void => {
        const active = ensureThinkingFormatter()
        if (active) active.write(chunk)
        else writeDirectSink(faintThinkingChunk(chunk))
      }
      const onThinkingStop = async (): Promise<void> => {
        await endThinkingFormatter()
        writeDirectSink("\n")
      }
      // Per-text-block formatter boundary. See `runReplLiveArea` for the
      // full rationale; this is the legacy `runRepl` (non-live-area) twin.
      const onTextStop = async (): Promise<void> => {
        if (!formatter && !opts?.formatterCmd) return
        const old = formatter
        formatter = null
        if (old) await old.end()
        formatter = spawnMainFormatter()
      }

      let turnError: unknown = null
      try {
        const gen = agent.run(text, {
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
          onTextStop,
        })
        while (true) {
          const { done, value } = await gen.next()
          if (done) break
          if (pluginStream) {
            const p = pluginStream.feed(value)
            if (p) await p
          } else {
            baseSink(value)
          }
        }
        if (pluginStream) await pluginStream.end()
      } catch (err) {
        turnError = err
      } finally {
        turnStatus.clear()
        statusRenderer?.resume()
        await endThinkingFormatter()
        if (formatter) await formatter.end()
      }

      if (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError)
        statusRenderer?.suspend()
        errOutput.write(`\n  ${c.boldRed("error")} ${msg}\n`)
        // Discard the failed user turn so the next attempt doesn't send
        // two back-to-back user messages (the API rejects that).
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()

        // Detect errors that indicate the current model selection won't
        // work for this account (unknown model, or a beta the subscription
        // can't use) and offer the model picker again.
        const modelErr =
          parseModelNotFoundError(msg) ?? parseModelUnavailableError(msg, agent.getModel?.())
        if (modelErr && opts?.auth && agent.setModel) {
          const lister = opts.listModels ?? defaultListModels
          try {
            const models = await lister(opts.auth)
            const picked = await promptModelPicker(
              models,
              agent.getModel?.() ?? modelErr,
              errOutput,
            )
            if (picked) {
              agent.setModel(picked)
              errOutput.write(`  ${c.boldGreen("ok")} model set to ${c.cyan(picked)}\n`)
            } else {
              errOutput.write(
                `  ${c.dim("kept current model")} ${c.cyan(agent.getModel?.() ?? "")}\n`,
              )
            }
          } catch (listErr) {
            errOutput.write(
              `  ${c.boldRed("error")} could not list models: ${listErr instanceof Error ? listErr.message : String(listErr)}\n`,
            )
          }
        }
        statusRenderer?.resume()
        output.write("\n")
        continue
      }

      // Terminate the partial response line so the next prompt starts at
      // column 0. No extra blank separator : the prompt sits directly
      // below the response. Skip when the response already ended with `\n`
      // (or we wrote nothing at all).
      if (wroteOutput && !lastChunkEndedWithNewline) output.write("\n")
    }
  } finally {
    statusRenderer?.stop()
    if (input instanceof RawInput) input.disable()
  }

  output.write(`\n${c.dim("Goodbye.")}\n`)
}

/**
 * Live-area REPL: the multiline input is pinned to the bottom of the
 * terminal and stays visible across agent work. Streamed output is written
 * through the {@link ReplCompositor} (which scrolls inside a region above
 * the live area), and the {@link ReplEditor} stays mounted for the entire
 * session : submits emit events; the buffer clears in place.
 *
 * Submits arriving while a turn is in flight are queued and processed in
 * order. A `cancel` event ends the loop cleanly.
 *
 * Required opts: `compositor`, `editor`. The caller is responsible for
 * starting the editor's I/O (we call `editor.start()` here) and for
 * providing a compositor that has not yet been mounted.
 */
async function runReplLiveArea(
  agent: ReplAgentLike,
  opts: {
    formatterCmd?: string[]
    output?: ReplOutput
    errOutput?: ReplErrOutput
    statusBus?: StatusBus
    statusRenderer?: StatusController | null
    spinner?: Spinner<StatusSpinnerTheme>
    auth?: AuthResult
    listModels?: (auth: AuthResult) => Promise<ModelInfo[]>
    compositor?: ReplCompositor
    editor?: ReplEditor
    /**
     * Bytes captured from stdin BEFORE the editor's data listener was
     * attached (typically during the term-caps DECRPM probe at startup).
     * Re-emitted to `process.stdin` immediately after `editor.start()` so
     * a fast-typing user doesn't lose the first keystroke of the session.
     */
    initialStdinBytes?: string
  },
): Promise<void> {
  if (!opts.compositor || !opts.editor) {
    throw new Error("runRepl: useLiveArea requires both compositor and editor")
  }
  const compositor = opts.compositor
  const editor = opts.editor
  const statusBus = opts.statusBus ?? GLOBAL_STATUS_BUS
  const modeManager = agent.modes?.() ?? null

  // Wire mode cycling (Shift+Tab forward, Ctrl+Shift+Tab back) to the
  // editor. Mirrors the legacy `runRepl` wiring so users get the same UX
  // whether or not the live area is active. We also subscribe to mode
  // changes so the editor's prompt prefix repaints with the active mode's
  // label and color.
  const continuationPromptForRebuild = process.env.MINIMAL_AGENT_CONTINUATION_PROMPT ?? "  "
  const baseArrow = `${c.bold(c.pink("❯"))} `
  if (
    modeManager &&
    modeManager.hasModes() &&
    typeof editor.setModeCycleHandlers === "function" &&
    typeof editor.setPrompt === "function"
  ) {
    const repaintPrompt = () => {
      editor.setPrompt?.(modeManager.promptPrefix(baseArrow), continuationPromptForRebuild)
    }
    modeManager.subscribe(repaintPrompt)
    editor.setModeCycleHandlers(
      () => modeManager.cycleNext(),
      () => modeManager.cyclePrev(),
    )
    // Apply the current prompt immediately in case a default mode is
    // already active at startup.
    repaintPrompt()
  }
  // Live-area status defaults to a LiveAreaStatusController that paints the
  // spinner+label as the top row of the live area. Tests can pass `null` to
  // disable, or supply their own controller.
  let statusRenderer: StatusController | null
  if (opts && "statusRenderer" in opts) {
    statusRenderer = opts.statusRenderer ?? null
  } else {
    const { LiveAreaStatusController } = await import("./live-area-status.ts")
    if (typeof editor.setStatus !== "function") {
      throw new Error("runRepl: editor.setStatus is required when statusRenderer is omitted")
    }
    const sink: { setStatus(text: string | null): void } = {
      setStatus: (t) => editor.setStatus?.(t),
    }
    statusRenderer = new LiveAreaStatusController(statusBus, sink, {
      spinner: opts.spinner,
    })
  }
  const loader = agent.pluginLoader()

  // Initial live-area height: 1 row (the prompt). The editor will grow it
  // as needed via setLiveHeight().
  compositor.mount(1)
  editor.start()
  // Replay stdin bytes captured while term-caps held raw mode : but ONLY
  // bytes that look like real keystrokes, never bytes that look like a
  // terminal reply (ESC-prefixed CSI/OSC). The DECRPM probe sometimes
  // races the timeout: the reply lands JUST after we resolve, gets
  // captured as "unparsed", and re-emitting it injects `^[ [ ? 2026 ; 1 $ y`
  // into the editor : which can read as a Ctrl+`[` (Esc) followed by
  // garbage and, depending on key bindings, cancel the editor or
  // submit/clear the buffer. Since real typeahead during the 80ms probe
  // is extremely rare and ESC-leading garbage is the common failure
  // mode, we discard ESC-leading buffers entirely.
  if (
    opts.initialStdinBytes &&
    opts.initialStdinBytes.length > 0 &&
    !opts.initialStdinBytes.startsWith("\x1b")
  ) {
    process.stdin.emit("data", opts.initialStdinBytes)
  }
  statusRenderer?.start()

  // Plugin-contributed live-area slots: schedule periodic producers that
  // populate the editor's footer (and, in future cuts, decoration). The
  // scheduler is started AFTER editor.start() so the first repaint
  // lands in an already-mounted live area; stopped at REPL teardown.
  const slotRows = loader?.getLiveAreaSlots() ?? []
  let liveAreaScheduler: import("./live-area-providers.ts").LiveAreaScheduler | null = null
  if (slotRows.length > 0 && typeof editor.setFooterLines === "function") {
    const { LiveAreaScheduler } = await import("./live-area-providers.ts")
    liveAreaScheduler = new LiveAreaScheduler(
      slotRows as ResolvedLiveAreaSlot[],
      {
        setFooterLines: (lines) => editor.setFooterLines?.(lines),
      },
      {
        // Wire the loader's event bus so slots with a `refreshOn` list
        // re-fire on the named events (e.g. `quota.headersReceived`
        // emitted from `client.ts` after every successful response).
        // When `loader` is absent (degenerate test paths) we still
        // create the scheduler but skip event-driven refresh.
        bus: loader?.bus(),
      },
    )
    liveAreaScheduler.start()
  }

  // One-time ready banner above the prompt. Goes through writeStream so
  // it lands in normal scrollback (above the pinned live area).
  const dot = c.faintWhite("·")
  const baseHint =
    `${c.faintWhite("enter")} ${c.bold("send")}  ${dot}  ` +
    `${c.faintWhite("shift+enter")} ${c.bold("new line")}  ${dot}  ` +
    `${c.faintWhite("ctrl+c")} ${c.bold("quit")}`
  const modeHint =
    modeManager && modeManager.hasModes()
      ? `  ${dot}  ${c.faintWhite("shift+tab")} ${c.bold("cycle mode")}`
      : ""
  // NOTE: single trailing `\n` here. The compositor no longer draws a
  // blank separator row above the live area, so the prompt follows the
  // hint text directly (no extra blank line needed or wanted).
  compositor.writeStream(
    `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n  ${baseHint}${modeHint}\n`,
  )

  // Submit queue: keystrokes never block, but we serialize agent turns.
  const queue: string[] = []
  let cancelled = false
  let resolveWaiter: (() => void) | null = null
  const wakeWaiter = () => {
    const r = resolveWaiter
    resolveWaiter = null
    if (r) r()
  }

  // Track whether a turn is currently running. Submits that arrive while
  // running become queued user input : eligible for mid-turn injection at
  // the next agent tool-loop boundary (see drainQueuedUserText below) AND
  // surfaced visually above the editor prompt via setDecorationLines.
  let running = false

  /**
   * Build the queued-message decoration block shown between the live-area
   * status row and the editor prompt. Only rendered while a turn is in
   * flight (steady-state idle should not display the queue : items are
   * drained immediately by the main loop and would visually flash).
   * Truncates each item to a single ~70-col preview so a multi-line paste
   * doesn't dominate the screen.
   */
  const renderDecoration = (): void => {
    if (typeof editor.setDecorationLines !== "function") return
    if (!running || queue.length === 0) {
      editor.setDecorationLines([])
      return
    }
    const dim = (s: string) => `\x1b[2m${s}\x1b[22m`
    // ⏳ is wide-emoji (2 cells in iTerm/WezTerm/most modern terminals).
    // The `┊` glyph below is 1 cell, so we pad each item line with one
    // extra space to make text columns line up under the `2 queued` text.
    const arrow = c.faintWhite("⏳")
    const count = queue.length
    const header = `  ${arrow} ${dim(`${count} queued`)}`
    const maxItems = 3
    const lines: string[] = [header]
    for (let i = 0; i < Math.min(maxItems, queue.length); i++) {
      const oneLine = queue[i].replace(/\s+/g, " ").trim()
      // Display-width-aware truncation. The previous `oneLine.slice(0, 70)`
      // was a UTF-16 code-unit slice that could split surrogate pairs (lone
      // high surrogate → `�`) and miscount wide chars (CJK at 2 cells/cp,
      // emoji at 2 cells, combining marks at 0). For ASCII it's identical;
      // for everything else `truncateDisplayWidth` is correct. (Bug 3.)
      const PREVIEW_W = 70
      let preview: string
      if (displayWidth(oneLine) <= PREVIEW_W) {
        preview = oneLine
      } else {
        const truncated = truncateDisplayWidth(oneLine, PREVIEW_W, "")
        // Report code-points cut, not cells (matches user mental model:
        // "I typed N more characters past the preview"). Counts via the
        // string iterator, which steps grapheme-naively but per-codepoint
        // : close enough for the queue preview's purpose.
        // eslint-disable-next-line typescript-eslint/no-misused-spread
        const cpCut = [...oneLine].length - [...truncated].length
        preview = `${truncated}${truncHint(cpCut, "ch")}`
      }
      lines.push(`  ${dim("┊")}  ${dim(preview)}`)
    }
    if (queue.length > maxItems) {
      lines.push(`  ${dim(`┊  ... and ${queue.length - maxItems} more`)}`)
    }
    editor.setDecorationLines(lines)
  }

  const onSubmit = (text: string): void => {
    if (!text.trim()) return
    queue.push(text)
    renderDecoration()
    wakeWaiter()
  }
  const onCancel = (): void => {
    cancelled = true
    wakeWaiter()
  }

  editor.on("submit", onSubmit)
  editor.on("cancel", onCancel)

  try {
    while (!cancelled) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve
        })
        continue
      }
      const text = queue.shift()
      if (text === undefined) continue

      const statusText = modeManager ? modeManager.statusLabel("Thinking") : "Thinking"
      const turnStatus = statusBus.create(statusText, {
        notificationId: "agent.thinking",
        category: "agent",
      })

      let turnError: unknown = null
      let lastChunkEndedWithNewline = false
      let wroteOutput = false

      // If --formatter was passed, spawn one per turn so markdown state
      // resets between user messages. The formatter's stdout is fed into
      // compositor.writeStream so it lands above the pinned live area.
      //
      // **Per text-block lifecycle, not per turn.** Inside one `run()` a
      // turn can produce multiple text blocks (text → tool → text → …).
      // Mdstream's `partial` paragraph buffer is keyed to ONE process and
      // would otherwise accumulate every text-block into one paragraph;
      // at `finish()` it then re-renders the *combined* buffer, smashing
      // unrelated sentences together with no separator. We respawn the
      // formatter on every `onTextStop` boundary (defined below) : each
      // text block gets its own subprocess, each gets its own `finish()`,
      // each paragraph commits independently and on its own row.
      let formatter: Formatter | null = null
      // Some formatters (notably mdstream) emit a trailing `\n\n` at the end
      // of a render to ensure block-level separation. In our REPL that lands
      // as TWO blank rows between the response and the next prompt instead
      // of one. We solve this by buffering trailing `\n` chunks: any run of
      // `\n` characters at the tail of a chunk is held back, and flushed
      // only when more body content arrives (preserving internal blank
      // lines). At end-of-turn we flush at most a single `\n`.
      let pendingTrailingNewlines = ""
      const flushTrailingNewlines = () => {
        if (pendingTrailingNewlines.length > 0) {
          compositor.writeStream(pendingTrailingNewlines)
          lastChunkEndedWithNewline = pendingTrailingNewlines.endsWith("\n")
          pendingTrailingNewlines = ""
        }
      }
      const writeFormatterChunk = (s: string) => {
        if (s.length === 0) return
        let i = s.length
        while (i > 0 && s[i - 1] === "\n") i--
        const body = s.slice(0, i)
        const tail = s.slice(i)
        if (body.length > 0) {
          // Body resumes after a tail-only run; flush any held newlines
          // verbatim so the internal layout is preserved.
          flushTrailingNewlines()
          compositor.writeStream(body)
        }
        pendingTrailingNewlines += tail
      }
      // Shared sink + decoder: lifted out of the original
      // `if (opts.formatterCmd)` block so `spawnMainFormatter()` (below) can
      // reuse them when respawning at text-block boundaries.
      const formatterDecoder = new TextDecoder()
      const compositorSink: Pick<NodeJS.WriteStream, "write"> & {
        columns?: number
        rows?: number
      } = {
        get columns() {
          return opts.output?.columns ?? process.stdout.columns
        },
        get rows() {
          return opts.output?.rows ?? process.stdout.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : formatterDecoder.decode(chunk)
          writeFormatterChunk(s)
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const spawnMainFormatter = (): Formatter | null => {
        if (!opts.formatterCmd) return null
        const f = new Formatter(opts.formatterCmd, compositorSink)
        f.start()
        return f
      }
      formatter = spawnMainFormatter()

      // Track the last kind of write so we can insert a blank-line separator
      // at text↔transcript boundaries. Without this, streamed markdown butts
      // directly against `└` lines (and vice versa), which the user reads as
      // "missing empty line between tool call and response".
      let lastKind: "none" | "text" | "transcript" = "none"

      const writeDirectSink = (s: string) => {
        if (s.length === 0) return
        if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ ...` and the next text.
          compositor.writeStream("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        compositor.writeStream(s)
      }

      const baseSink = (s: string) => {
        if (s.length === 0) return
        if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ ...` and the next text.
          compositor.writeStream("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        if (formatter) formatter.write(s)
        else compositor.writeStream(s)
      }
      const ps = loader ? new PluginStream(baseSink, loader, process.cwd()) : null
      let thinkingFormatter: Formatter | null = null
      const thinkingDecoder = new TextDecoder()
      const thinkingOutput: Pick<NodeJS.WriteStream, "write"> & {
        columns?: number
        rows?: number
      } = {
        get columns() {
          return opts.output?.columns ?? process.stdout.columns
        },
        get rows() {
          return opts.output?.rows ?? process.stdout.rows
        },
        write: ((chunk: string | Uint8Array) => {
          const s = typeof chunk === "string" ? chunk : thinkingDecoder.decode(chunk)
          writeDirectSink(faintThinkingChunk(s))
          return true
        }) as NodeJS.WriteStream["write"],
      }
      const ensureThinkingFormatter = (): Formatter | null => {
        if (!opts.formatterCmd) return null
        if (!thinkingFormatter) {
          thinkingFormatter = new Formatter(opts.formatterCmd, thinkingOutput)
          thinkingFormatter.start()
        }
        return thinkingFormatter
      }
      const endThinkingFormatter = async (): Promise<void> => {
        if (!thinkingFormatter) return
        const active = thinkingFormatter
        thinkingFormatter = null
        await active.end()
      }

      const onTranscriptLine = (line: string): void => {
        // Transitioning from text to transcript: the formatter may have
        // held back a trailing `\n`/`\n\n` in `pendingTrailingNewlines`
        // (mdstream-style block-end run). Flush it FIRST so the text
        // section ends with its proper line terminator before the tool
        // header : otherwise the text line and the tool's `╭` would
        // collide on adjacent rows with no blank between them. The
        // capBlankLines cap in the compositor still ensures we never
        // get more than one blank row from the combined `\n` run.
        if (lastKind === "text") {
          flushTrailingNewlines()
          if (!lastChunkEndedWithNewline) {
            compositor.writeStream("\n")
            lastChunkEndedWithNewline = true
          }
        }
        // When lastKind === "none" we do NOT add an extra `\n`: the agent's
        // tool header already starts with `\n`, and submit() flushed the
        // prompt with a trailing `\n`. Those two together yield exactly
        // one blank row between the prompt and `╭`. Adding another `\n`
        // here (as we do in baseSink for streamed text, which has no
        // leading newline) would produce two blank rows.
        compositor.writeStream(`${line}\n`)
        lastKind = "transcript"
      }
      const onThinkingStart = (): void => {
        ensureThinkingFormatter()
      }
      const onThinkingChunk = (chunk: string): void => {
        const active = ensureThinkingFormatter()
        if (active) active.write(chunk)
        else writeDirectSink(faintThinkingChunk(chunk))
      }
      const onThinkingStop = async (): Promise<void> => {
        await endThinkingFormatter()
        writeDirectSink("\n")
      }
      // Mark the turn as running so submits arriving from this point on are
      // captured as queued user input rather than racing into the next
      // queue.shift() iteration. The decoration is rendered on every queue
      // mutation; clearing happens in the finally below.
      running = true
      renderDecoration()
      // drain: splice ALL pending items into one combined injection. We
      // batch because the user's typical mental model when queuing
      // multiple messages mid-turn is "give the model all this extra
      // context at once" rather than "respond to each as a separate
      // turn". If they wanted serialization they'd wait for a response
      // between submits. Items not drained here (because no tool boundary
      // ever fired) fall through to next-turn processing via the
      // existing FIFO queue.shift() loop.
      const drainQueuedUserText = (): string | null => {
        if (queue.length === 0) return null
        const drained = queue.splice(0).join("\n\n")
        renderDecoration()
        return drained
      }
      // onQueueInject: NO-OP for scrollback rendering. The user's submitted
      // text was already committed to scrollback by EditorController.submit
      // at the moment they pressed Enter : that's the immediate-feedback
      // contract of the editor. Re-rendering it here at the tool-boundary
      // injection point produced a visible duplicate (prompt appears twice:
      // once before the tool block, once after). The hook is retained as a
      // notification point in case future code wants to react to the
      // injection, but it must not write to scrollback.
      const onQueueInject = (_qtext: string): void => {
        /* intentionally empty : see comment above */
      }
      // Begin a turn on the global abort bus. From this point on, the
      // editor's bare-Esc / Ctrl+C handlers (see `EditorController`) will
      // route to `abortBus.requestAbort(...)` instead of clearing the
      // buffer or emitting `cancel`. We pass `ctrl.signal` into `agent.run`
      // so an abort tears down the SDK stream AND any in-flight tool
      // (Bash child gets SIGTERM → SIGKILL escalation, Read/Write/etc.
      // throw before further IO).
      const ctrl = abortBus.beginTurn()
      let aborted = false
      const onBusAbort = (): void => {
        aborted = true
      }
      abortBus.once("abort", onBusAbort)
      // Per-text-block formatter boundary. See the `spawnMainFormatter`
      // doc-cluster and the `onTextStop` field on `SendMessageOptions`:
      // ends the current main formatter (awaited : drains mdstream's
      // `finish()` output through `drainOutput` → `compositorSink`
      // synchronously w.r.t. our control flow) and respawns a fresh one
      // so the *next* text block starts with an empty `partial` paragraph
      // buffer. Without this, two text blocks in one `run()` get smashed
      // together at end-of-run by mdstream's final re-render.
      const onTextStop = async (): Promise<void> => {
        if (!formatter && !opts.formatterCmd) return
        const old = formatter
        formatter = null
        if (old) await old.end()
        // After `end()` returns, drainOutput has consumed every byte
        // mdstream emitted (incl. the `erase_partial` + final markdown
        // render produced by `finish()`). Any trailing `\n`/`\n\n` is
        // now held in `pendingTrailingNewlines`; we deliberately leave
        // it there. The existing flush sites : next baseSink body
        // chunk, onTranscriptLine's text→transcript flush, or
        // end-of-turn discard : still work unchanged.
        formatter = spawnMainFormatter()
      }
      try {
        const gen = agent.run(text, {
          signal: ctrl.signal,
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
          onTextStop,
          drainQueuedUserText,
          onQueueInject,
        })
        while (true) {
          const { done, value } = await gen.next()
          if (done) break
          if (ps) {
            const p = ps.feed(value)
            if (p) await p
          } else {
            baseSink(value)
          }
        }
        if (ps) await ps.end()
      } catch (err) {
        turnError = err
      } finally {
        // Always end the turn FIRST so the bus is in a clean state for the
        // next iteration even if endThinkingFormatter / formatter.end()
        // throw. `off` keeps the listener count stable across turns.
        abortBus.off("abort", onBusAbort)
        abortBus.endTurn()
        running = false
        renderDecoration()
        turnStatus.clear()
        await endThinkingFormatter()
        if (formatter) await formatter.end()
        // Discard the formatter's trailing-newline buffer entirely. The
        // compositor's drawLiveSeq handles the response→prompt boundary:
        // when the body ends mid-line (streamCol > 0) it emits a `\r\n`
        // line terminator so the live area starts at col 0. Writing our
        // own `\n` here would add an extra blank row. We still mark
        // `lastChunkEndedWithNewline` so the post-turn terminator below
        // doesn't fire either: the held tail represents the formatter's
        // intent to terminate, and the compositor handles the rest.
        if (pendingTrailingNewlines.length > 0) {
          pendingTrailingNewlines = ""
          lastChunkEndedWithNewline = true
        }
        compositor.flushStream?.()
      }

      // Abort path: distinguish user-initiated cancellation from a real
      // error. `agent.run` throws `Error("aborted")` with `name === "AbortError"`
      // when the signal trips. We swallow it, emit a single dim footer,
      // restore the in-flight prompt to the editor (so the user can edit
      // and resubmit), and rollback the orphan user turn.
      const isAbortError =
        aborted || (turnError instanceof Error && (turnError as Error).name === "AbortError")
      if (isAbortError) {
        // Make sure the abort echo starts on a fresh line.
        if (wroteOutput && !lastChunkEndedWithNewline) compositor.writeStream("\n")
        // Render the faint+strikethrough echo of the rolled-back submission.
        // The visual semantics are unambiguous: the struck-through block
        // shows what got aborted; the next bold `❯ ` prompt (which appears
        // right below once the editor restores the buffer via setBuffer)
        // is the live editor showing the same text, available for edit and
        // re-submission. No separate "prompt restored to editor" line is
        // needed : the editor's own redraw is the proof.
        const activeMode = modeManager?.active()
        const modeLabel = activeMode?.label ?? activeMode?.id ?? null
        compositor.writeStream(`${formatAbortedEcho(text, { activeModeLabel: modeLabel })}\n`)
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()
        if (typeof editor.setBuffer === "function") editor.setBuffer(text)
      } else if (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError)
        compositor.writeStream(`\n  ${c.boldRed("error")} ${msg}\n`)
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()
      } else if (wroteOutput && !lastChunkEndedWithNewline) {
        // Terminate the partial response line so the next stream write (or
        // the editor's submit flush) starts at column 0. No extra blank
        // line: the live-area prompt sits directly below the response.
        // When the response already ended with `\n` we skip this entirely
        // : avoids both the extra blank row AND the erase/redraw flicker
        // of an unnecessary writeStream call.
        compositor.writeStream("\n")
      }
    }
  } finally {
    liveAreaScheduler?.stop()
    statusRenderer?.stop()
    editor.stop()
    compositor.unmount()
  }
}

/**
 * Detect "model: <id>" not_found_error responses from the Messages API.
 * Returns the offending model id, or null if the error is unrelated.
 *
 * Example payload (status 404):
 *   `API 404: {"type":"error","error":{"type":"not_found_error","message":"model: claude-haiku-4-7"},...}`
 */
export function parseModelNotFoundError(message: string): string | null {
  if (!message.includes("not_found_error")) return null
  const match = message.match(/"message"\s*:\s*"model:\s*([^"]+)"/)
  return match ? match[1] : null
}

/**
 * Detect API errors that don't say "model not found" but still mean the
 * current model selection won't work for this account : e.g. picking a
 * `[1m]` variant on a subscription without long-context access:
 *
 *   `API 400: {"type":"error","error":{"type":"invalid_request_error",
 *    "message":"The long context beta is not yet available for this subscription."},...}`
 *
 * Returns the current model id (so the caller can re-open the picker), or
 * null if the error is unrelated to model selection.
 */
export function parseModelUnavailableError(
  message: string,
  currentModel: string | undefined,
): string | null {
  if (!currentModel) return null
  if (message.includes("long context beta is not yet available")) return currentModel
  return null
}

/**
 * Show the user a numbered list of available models and read a selection.
 * Returns the picked model id, or null when the user skips (empty input).
 *
 * The user may type a number (1-based), or any model id (including the
 * client-side `[1m]` suffix variants synthesized by `listModels`).
 */
async function promptModelPicker(
  models: ModelInfo[],
  currentModel: string,
  errOutput: ReplErrOutput,
): Promise<string | null> {
  errOutput.write(`\n  ${c.bold("available models")} ${c.dim(`(current: ${currentModel})`)}\n`)
  const width = String(models.length).length
  for (let i = 0; i < models.length; i++) {
    const m = models[i]
    const num = c.cyan(String(i + 1).padStart(width))
    const name = m.display_name ? c.dim(` ${m.display_name}`) : ""
    errOutput.write(`    ${num}) ${m.id}${name}\n`)
  }
  errOutput.write("\n")
  const picker = new RawInput(
    `${c.bold(c.pink("❯"))} ${c.dim("pick model (number or id, empty to skip):")} `,
    "",
  )
  const ans = await picker.read()
  if (!ans) return null
  const trimmed = ans.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (Number.isInteger(n) && n >= 1 && n <= models.length) {
    return models[n - 1].id
  }
  // Accept any user-typed id verbatim (covers `[1m]` variants and forward
  // compatibility with future model ids the catalog may not yet list).
  return trimmed
}

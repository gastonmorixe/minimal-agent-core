/**
 * Agent module: conversational state + tool execution loop + REPL.
 *
 * The {@link Agent} class owns the append-only conversation history and
 * provides two send methods:
 *
 * - {@link Agent.send} — single round-trip text reply (no tools)
 * - {@link Agent.run} — full agentic loop: send → tool_use → execute → tool_result → repeat
 *
 * Both yield text chunks via async generator and return a {@link StreamedResponse}
 * with the structured content blocks (thinking, tool_use, text). Thinking blocks
 * are preserved verbatim in history (with their signatures) so subsequent
 * requests can include them — required for the `redact-thinking-2026-02-12` beta.
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
import type { ManifestMode } from "./plugins/types.ts"
import type { SessionStore } from "./session-store.ts"
import type { Spinner } from "./spinner.ts"
import { GLOBAL_STATUS_BUS, StatusBus, StatusRenderer, type StatusSpinnerTheme } from "./status.ts"
import { executeTool, TOOL_DEFINITIONS, type ToolDefinition } from "./tools.ts"

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  italic: (s: string) => `\x1b[3m${s}\x1b[23m`,
  underline: (s: string) => `\x1b[4m${s}\x1b[24m`,
  brightCyan: (s: string) => `\x1b[96m${s}\x1b[39m`,
  brightYellow: (s: string) => `\x1b[93m${s}\x1b[39m`,
  brightGreen: (s: string) => `\x1b[92m${s}\x1b[39m`,
  brightRed: (s: string) => `\x1b[91m${s}\x1b[39m`,
  brightMagenta: (s: string) => `\x1b[95m${s}\x1b[39m`,
  boldCyan: (s: string) => `\x1b[1;36m${s}\x1b[22;39m`,
  boldGreen: (s: string) => `\x1b[1;32m${s}\x1b[22;39m`,
  boldRed: (s: string) => `\x1b[1;31m${s}\x1b[22;39m`,
  boldYellow: (s: string) => `\x1b[1;33m${s}\x1b[22;39m`,
  dimCyan: (s: string) => `\x1b[2;36m${s}\x1b[22;39m`,
  faintWhite: (s: string) => `\x1b[2;37m${s}\x1b[22;39m`,

  // Modern "Cool Summer" palette (Saturated & Powerful)
  orange: (s: string) => `\x1b[38;5;208m${s}\x1b[39m`,
  pink: (s: string) => `\x1b[38;5;199m${s}\x1b[39m`,
  purple: (s: string) => `\x1b[38;5;98m${s}\x1b[39m`,
  lime: (s: string) => `\x1b[38;5;118m${s}\x1b[39m`,
  sky: (s: string) => `\x1b[38;5;45m${s}\x1b[39m`,
  violet: (s: string) => `\x1b[38;5;93m${s}\x1b[39m`,
  gold: (s: string) => `\x1b[38;5;214m${s}\x1b[39m`,
}

const faintThinkingChunk = (s: string): string => {
  const trailingNewline = s.endsWith("\n")
  const body = trailingNewline ? s.slice(0, -1) : s
  if (body.length === 0) return trailingNewline ? "\n" : ""
  const redimmed = body
    .replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")
    .replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")
  return `\x1b[2m${redimmed}\x1b[22m${trailingNewline ? "\n" : ""}`
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
 * on every API call (no truncation, no compression — that's a server-side
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
   * Read-only by convention — never mutate from outside the class. Use
   * {@link history} to get a defensive copy. Each message has block-based
   * content matching the v2.1.91 wire format.
   */
  readonly messages: Message[] = []
  /** Auth credentials used for every API call. Refresh closure stays attached. */
  private auth: AuthResult
  /** Model ID for all requests in this agent's lifetime. */
  private model: string
  /** Effort level for output_config.effort. */
  private effort: "high" | "medium" | "low" | "max" | undefined
  /** Optional TUI plugin loader. When set, plugin tools merge with core tools. */
  private loader: PluginLoader | null
  /** Optional mode manager (mode-aware system prompt + tool filter). */
  private modeManager: ModeManager | null
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
    effort?: "high" | "medium" | "low" | "max"
    loader?: PluginLoader | null
    modeManager?: ModeManager | null
    sendFn?: typeof sendMessage
    store?: SessionStore | null
    /**
     * Pre-existing conversation to seed the agent with (used by
     * `--resume <sid>` to rehydrate from a saved log). Pushed onto
     * `this.messages` verbatim. The store, if any, is NOT re-written —
     * resume opens its store with `existsOk: true` so subsequent turns
     * append to the same file.
     */
    initialMessages?: Message[]
  }) {
    this.auth = opts.auth
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.effort = opts.effort
    this.loader = opts.loader ?? null
    this.modeManager = opts.modeManager ?? null
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
   * @returns true if at least one message was discarded.
   */
  rollbackPendingTurn(): boolean {
    let removed = false
    while (
      this.messages.length > 0 &&
      this.messages[this.messages.length - 1].role !== "assistant"
    ) {
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
   * Tool calls and their outputs are NOT yielded — they're logged to stderr
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
    },
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    // Split transport opts from the transcript callback. sendFn must not see
    // onTranscriptLine.
    const { onTranscriptLine, onThinkingStart, onThinkingChunk, onThinkingStop, ...sendOpts } =
      opts ?? {}
    const thinkingStart = onThinkingStart
    const onThinkingDelta = onThinkingChunk ?? sendOpts.onThinkingDelta
    const thinkingStop = onThinkingStop
    const writeTranscript = (line: string): void => {
      if (onTranscriptLine) onTranscriptLine(line)
      else console.error(line)
    }

    // Initial user message
    const initialUserContent: ContentBlock[] = [{ type: "text", text: userText }]
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
    // change mid-turn). The active mode (if any) layers on top: its
    // systemPromptAppend joins the session-context block, and its
    // disallowedTools filter removes tools from the request.
    // Use the async variant so plugin-contributed prompt fragments
    // (env-info, etc.) get awaited+memoized. The first turn pays the
    // fragment-resolution cost (bounded by each fragment's `timeoutMs`,
    // default 2s); subsequent turns hit the cache. The sync `getPromptBlock`
    // is reserved for the session hash in src/index.ts so volatile fragment
    // content (date, terminal size) doesn't bust resume drift detection.
    const pluginBlock = (await this.loader?.getPromptBlockAsync()) ?? null
    const modeAddition = this.modeManager?.systemPromptAddition() ?? ""
    const sessionContext: string | null =
      pluginBlock && modeAddition
        ? `${pluginBlock}\n\n${modeAddition}`
        : pluginBlock != null
          ? pluginBlock
          : modeAddition !== ""
            ? modeAddition
            : null
    const system = sessionContext ? buildSystemPrompt({ sessionContext }) : undefined
    const allTools: ToolDefinition[] = this.loader
      ? [...TOOL_DEFINITIONS, ...(this.loader.getExtraTools() as ToolDefinition[])]
      : [...TOOL_DEFINITIONS]
    // Build a presentation map (icon + color) keyed by tool name for transcript
    // rendering, then strip those cosmetic fields before sending to the API.
    const toolPresentation = new Map<string, { icon?: string; color?: string }>()
    for (const t of allTools) {
      if (t.icon || t.color) toolPresentation.set(t.name, { icon: t.icon, color: t.color })
    }
    let mergedTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }> = allTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
    if (this.modeManager) {
      mergedTools = this.modeManager.filterTools(mergedTools)
    }

    while (rounds < this.maxToolRounds) {
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
        ...sendOpts,
        ...(thinkingStart ? { onThinkingStart: thinkingStart } : {}),
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(thinkingStop ? { onThinkingStop: thinkingStop } : {}),
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
          // usage isn't surfaced on StreamedResponse yet — leave undefined
          // and add it later when the client exposes it.
          undefined,
        )
      }

      // Check for tool use blocks
      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")

      if (toolBlocks.length === 0) {
        // No tool calls — model is done
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
        writeTranscript(
          `\n  ${c.dimCyan("╭")} ${icon}${c.bold(labelColor(tool.name))}  ${c.dim(formatToolInput(tool))}`,
        )

        let content: string
        let isError: boolean | undefined
        let display: string | undefined
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
            } else {
              content = `Plugin tool "${tool.name}" returned a non-tool_result value`
              isError = true
            }
          } else {
            const result = executeTool(tool.name, tool.input)
            content = result.content
            isError = result.is_error
            display = result.display
          }
        } finally {
          toolStatus.clear()
        }

        for (const line of formatToolPreview(content, isError, display)) {
          writeTranscript(line)
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

      // Send tool results back
      this.messages.push({ role: "user", content: toolResults })
    }

    if (rounds >= this.maxToolRounds) {
      writeTranscript(
        `\n  ${c.boldYellow("!")} ${c.yellow(`Safety limit reached (${this.maxToolRounds} tool rounds)`)}`,
      )
    }

    return lastResponse
  }

  /**
   * Send a user message without enabling tools — single round-trip.
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
 * Format a `tool_use` block's input for compact stderr display.
 *
 * Picks the most informative field per tool (command for Bash, file_path
 * for file tools, pattern for search tools) and truncates to ~80 chars.
 * Falls back to JSON-stringified input for unknown tools.
 */
export function formatToolInput(tool: ToolUseBlock): string {
  const input = tool.input
  if (tool.name === "Bash" && input.command) {
    // First line only — multi-line commands (heredocs etc.) would otherwise
    // shred the bordered tool block by injecting raw newlines into the header.
    const cmd = String(input.command)
    const firstNl = cmd.indexOf("\n")
    const firstLine = firstNl === -1 ? cmd : cmd.slice(0, firstNl)
    const truncated = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine
    const ellipsis = firstNl !== -1 && firstLine.length <= 80 ? " …" : ""
    return `$ ${truncated}${ellipsis}`
  }
  if (tool.name === "Read" && input.file_path) {
    return String(input.file_path)
  }
  if (tool.name === "Write" && input.file_path) {
    return String(input.file_path)
  }
  if (tool.name === "Edit" && input.file_path) {
    return String(input.file_path)
  }
  if (tool.name === "Glob" && input.pattern) {
    return String(input.pattern)
  }
  if (tool.name === "Grep" && input.pattern) {
    return `/${input.pattern}/` + (input.path ? ` in ${input.path}` : "")
  }
  return JSON.stringify(input).slice(0, 80)
}

export function formatToolPreview(content: string, isError?: boolean, display?: string): string[] {
  // If the tool provided a pre-rendered display string (e.g. ANSI-colored
  // unified diff from Edit/Write), render it as-is, line by line, with the
  // standard `│ … └` connector gutter. No truncation: diffs are the point.
  if (display && !isError) {
    const dlines = display.split("\n")
    const out: string[] = []
    for (let i = 0; i < dlines.length; i++) {
      const connector = i === dlines.length - 1 ? "╰" : "│"
      out.push(`  ${c.dimCyan(connector)} ${dlines[i]}`)
    }
    return out
  }

  const preview = content.slice(0, 200)
  const lines = (preview || "(no output)").split("\n")
  if (content.length > 200) {
    lines[lines.length - 1] += "..."
  }

  const color = isError ? c.red : c.dim
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const connector = i === lines.length - 1 ? "╰" : "│"
    out.push(`  ${c.dimCyan(connector)} ${color(lines[i])}`)
  }
  return out
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
 * markdown rendering state resets between user messages — this avoids
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
    /** Override for testing — defaults to the real listModels client call. */
    listModels?: (auth: AuthResult) => Promise<ModelInfo[]>
    /**
     * Enable the persistent live-area UI: the multiline input is pinned to
     * the bottom of the terminal and stays visible while the agent works.
     * Requires `compositor` and `editor` (or sensible defaults wired by the
     * caller). When false (the legacy default), `runRepl` reads turns one
     * at a time via {@link RawInput} and writes streamed output straight to
     * stdout — same as before.
     */
    useLiveArea?: boolean
    compositor?: ReplCompositor
    editor?: ReplEditor
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

      let formatter: Formatter | null = null
      if (opts?.formatterCmd) {
        formatter = new Formatter(opts.formatterCmd, output)
        formatter.start()
      }

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
          // tool header (`\n  ┌ …`) then yields a blank separator.
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

      let turnError: unknown = null
      try {
        const gen = agent.run(text, {
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
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
      // column 0. No extra blank separator — the prompt sits directly
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
 * session — submits emit events; the buffer clears in place.
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
  statusRenderer?.start()

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
  compositor.writeStream(
    `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n  ${baseHint}${modeHint}\n\n`,
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

  const onSubmit = (text: string): void => {
    if (!text.trim()) return
    queue.push(text)
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
      let formatter: Formatter | null = null
      if (opts.formatterCmd) {
        const decoder = new TextDecoder()
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
            const s = typeof chunk === "string" ? chunk : decoder.decode(chunk)
            if (s.length > 0) compositor.writeStream(s)
            return true
          }) as NodeJS.WriteStream["write"],
        }
        formatter = new Formatter(opts.formatterCmd, compositorSink)
        formatter.start()
      }

      // Track the last kind of write so we can insert a blank-line separator
      // at text↔transcript boundaries. Without this, streamed markdown butts
      // directly against `└` lines (and vice versa), which the user reads as
      // "missing empty line between tool call and response".
      let lastKind: "none" | "text" | "transcript" = "none"

      const writeDirectSink = (s: string) => {
        if (s.length === 0) return
        if (lastKind === "none") {
          // First write of the turn. The user's just-submitted prompt sits
          // immediately above in scrollback; without a separator the model's
          // response butts directly against it (no color/space contrast),
          // which reads as cramped. One blank line gives the eye an anchor.
          compositor.writeStream("\n")
        } else if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ …` and the next text.
          compositor.writeStream("\n")
        }
        wroteOutput = true
        lastChunkEndedWithNewline = s.endsWith("\n")
        lastKind = "text"
        compositor.writeStream(s)
      }

      const baseSink = (s: string) => {
        if (s.length === 0) return
        if (lastKind === "none") {
          // First write of the turn. The user's just-submitted prompt sits
          // immediately above in scrollback; without a separator the model's
          // response butts directly against it (no color/space contrast),
          // which reads as cramped. One blank line gives the eye an anchor.
          compositor.writeStream("\n")
        } else if (lastKind === "transcript") {
          // Transcript lines always end with `\n`; one more `\n` here yields
          // exactly one blank line between the `└ …` and the next text.
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
        // If we're transitioning from a partial text line into transcript
        // (`  ┌ …`), close the text line first. The agent's tool header
        // already starts with `\n`, so adding `\n` here yields a blank
        // separator line. When previous text already ended with `\n` the
        // header's leading `\n` alone is the blank line — don't double it.
        if (lastKind === "text" && !lastChunkEndedWithNewline) {
          compositor.writeStream("\n")
          lastChunkEndedWithNewline = true
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
      try {
        const gen = agent.run(text, {
          onTranscriptLine,
          onThinkingStart,
          onThinkingChunk,
          onThinkingStop,
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
        turnStatus.clear()
        await endThinkingFormatter()
        if (formatter) await formatter.end()
        compositor.flushStream?.()
      }

      if (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError)
        compositor.writeStream(`\n  ${c.boldRed("error")} ${msg}\n`)
        if (agent.rollbackPendingTurn) agent.rollbackPendingTurn()
      } else if (wroteOutput && !lastChunkEndedWithNewline) {
        // Terminate the partial response line so the next stream write (or
        // the editor's submit flush) starts at column 0. No extra blank
        // line: the live-area prompt sits directly below the response.
        // When the response already ended with `\n` we skip this entirely
        // — avoids both the extra blank row AND the erase/redraw flicker
        // of an unnecessary writeStream call.
        compositor.writeStream("\n")
      }
    }
  } finally {
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
 * current model selection won't work for this account — e.g. picking a
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

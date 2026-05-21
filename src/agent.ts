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
import { shouldSoftSplit, splitBashSegments } from "./bash-split.ts"
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
import { isErrorDiagEmitted } from "./diagnostic-bus.ts"
import { Formatter } from "./formatter.ts"
import { printGoodbye } from "./goodbye-banner.ts"
import {
  buildSystemPrompt,
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
} from "./headers.ts"
import { RawInput } from "./input.ts"
import { ModeManager } from "./modes.ts"
import { PALETTE } from "./palette.ts"
import { PluginLoader } from "./plugins/loader.ts"
import { PluginStream } from "./plugins/stream.ts"
import type { ManifestMode, ResolvedLiveAreaSlot } from "./plugins/types.ts"
import { buildQueueDecorationLines } from "./queue-decoration.ts"
import { createReflectionAckStripper } from "./reflection-ack-stripper.ts"
import type { SessionStore } from "./session-store.ts"
import type { Spinner } from "./spinner.ts"
import { GLOBAL_STATUS_BUS, StatusBus, StatusRenderer, type StatusSpinnerTheme } from "./status.ts"
import { displayWidth, truncateDisplayWidth } from "./term-width.ts"
import type { ToolTimeTracker } from "./tool-time.ts"
import { ToolFeedbackTracker } from "./tools/feedback-tracker.ts"
import type { TruncationInfo } from "./tools/truncation.ts"
import { executeTool, TOOL_DEFINITIONS, type ToolDefinition } from "./tools.ts"
import { truncHint } from "./truncate-hint.ts"

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
// Reflection checkpoint helpers
// ---------------------------------------------------------------------------

/**
 * Regex matching a `<ma::reflection-ack silence-for="K" reason="..." />`
 * tag in assistant response text. Both attributes are optional in either
 * order. Anchored to `\b` boundaries on the attribute names so a typo
 * like `silencefor` doesn't accidentally match.
 *
 * Captures: group 1 = silence-for value (digits), group 2 = reason text.
 * When the attribute is absent the capture is `undefined`. The model is
 * expected to emit this tag at most once per response : when multiple
 * tags appear the LAST well-formed one wins (see {@link parseReflectionAck}).
 */
const REFLECTION_ACK_RE =
  /<ma::reflection-ack(?:\s+(?:silence-for="(\d+)"|reason="([^"]*)")){0,2}\s*\/>/g

/**
 * Parse `<ma::reflection-ack ... />` tags out of an assistant response.
 *
 * Returns the LAST well-formed tag's parsed values (or `null` if none),
 * so a model that hedges by emitting multiple acks ends with the value
 * it most recently committed to. `silenceFor` defaults to 1 when the
 * attribute is omitted; a 0 disables the ack (no silence applied).
 * Reason is stored verbatim for transcript logging.
 */
export function parseReflectionAck(
  responseText: string,
): { silenceFor: number; reason: string } | null {
  let result: { silenceFor: number; reason: string } | null = null
  for (const m of responseText.matchAll(REFLECTION_ACK_RE)) {
    const silenceForRaw = m[1]
    const reason = m[2] ?? ""
    const silenceFor = silenceForRaw === undefined ? 1 : Number.parseInt(silenceForRaw, 10)
    if (!Number.isFinite(silenceFor) || silenceFor < 0) continue
    result = { silenceFor, reason }
  }
  return result
}

/**
 * Wall-clock cooldown applied at a reflection checkpoint. Surfaces a
 * live countdown in the global status bus (same channel the spinner /
 * `Running <tool>` indicator uses), so the human watching sees
 * `⏸ reflection @ round 50 · 59s remaining · press Esc to interrupt`
 * tick down in the live area without spamming scrollback.
 *
 * The pause is interruptible via the optional `AbortSignal`. When
 * aborted, the helper resolves immediately and the caller's existing
 * abort path (the top-of-loop `if (signal?.aborted) throw AbortError`)
 * handles teardown.
 *
 * No-op when `totalMs <= 0` : the checkpoint attachment is still
 * injected by the caller in that case (model-facing marker without
 * the wall-clock penalty).
 */
async function runReflectionCooldown(opts: {
  totalMs: number
  round: number
  signal?: AbortSignal
  statusBus: StatusBus
}): Promise<void> {
  const { totalMs, round, signal, statusBus } = opts
  if (totalMs <= 0) return
  if (signal?.aborted) return
  const totalSec = Math.max(1, Math.ceil(totalMs / 1000))
  const fmt = (sec: number) =>
    `⏸ reflection @ round ${round} · ${sec}s remaining · press Esc to interrupt`
  const handle = statusBus.create(fmt(totalSec), {
    notificationId: "agent.reflection-cooldown",
    category: "reflection",
  })
  let remaining = totalSec
  const tick = setInterval(() => {
    remaining = Math.max(0, remaining - 1)
    if (remaining > 0) handle.update(fmt(remaining))
  }, 1000)
  try {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const onAbort = (): void => {
        if (timer !== null) clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort)
        resolve()
      }, totalMs)
      if (signal) signal.addEventListener("abort", onAbort, { once: true })
    })
  } finally {
    clearInterval(tick)
    handle.clear()
  }
}

/**
 * Build the `<ma::reflection-checkpoint ... />` attachment text that
 * gets injected into the next user content after a cooldown. The
 * `cooldown-applied-seconds` attribute carries the wall-clock penalty
 * the model can reason about; the trailing prose restates the soft-
 * checkpoint contract so a model that didn't read the system-prompt
 * paragraph carefully still has the ack syntax right next to where it
 * matters.
 */
function buildReflectionCheckpointBlock(round: number, cooldownMs: number): ContentBlock {
  const cooldownSec = Math.max(0, Math.round(cooldownMs / 1000))
  return {
    type: "text",
    text:
      `<ma::reflection-checkpoint round="${round}" cooldown-applied-seconds="${cooldownSec}" />\n` +
      `Soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user. ` +
      `Emit \`<ma::reflection-ack silence-for="K" reason="..." />\` anywhere in your response to suppress the next K checkpoints (skipping both the cooldown and this attachment).`,
  }
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
   * Optional tasks-list attachment producer. When set, the per-session
   * `<ma::tui::tasks …>…</ma::tui::tasks>` attachment is prepended to
   * the FIRST user message of each `run()` call. Mirrors
   * {@link Agent.shortTermSnapshot} exactly : same structural-type
   * pattern, same initial-seam-only emission rule, same null-on-empty
   * behavior (zero token cost when the session has no tasks).
   *
   * See `tui-plugins/tasks/lib/attachment.ts`.
   */
  private tasksAttachment: { toAttachment(): ContentBlock | null } | null
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
   * Emergency hard cap on tool-execution rounds within a single `run()`
   * call. **Defaults to {@link Number.POSITIVE_INFINITY}** : there is NO
   * hard stop by default, because long autonomous tasks (refactors,
   * audits, sustained research) legitimately run for hundreds of rounds
   * and a fixed cap defeats the point.
   *
   * Hosts that want a finite ceiling (cost-bounded batch jobs, sandboxes)
   * can opt in via the constructor `maxToolRounds` option. When a finite
   * cap is set and reached, the loop does NOT abruptly exit with an
   * orphaned tool_use : instead it sends ONE final API request with
   * tools disabled and a `<ma::emergency-cap-triggered round="N" />`
   * attachment so the model can write a clean wrap-up summary.
   *
   * The actual safety device against runaway loops is the reflection
   * checkpoint mechanism : see {@link reflectionInterval} below.
   */
  private maxToolRounds: number = Number.POSITIVE_INFINITY
  /**
   * Reflection checkpoint cadence (in tool rounds). Every Nth round a
   * `<ma::reflection-checkpoint round="N" cooldown-applied-seconds="..." />`
   * attachment is injected into the next user content, preceded by a
   * wall-clock cooldown (see {@link reflectionCooldownMs}). This is the
   * default-on safety device : not a stop signal, but a "are you on
   * track?" nudge that also gives a human watching a window to press Esc.
   *
   * Defaults to {@link DEFAULT_REFLECTION_INTERVAL} (50). Set to 0 to
   * disable checkpoints entirely.
   */
  private reflectionInterval: number = DEFAULT_REFLECTION_INTERVAL
  /**
   * Wall-clock cooldown (ms) applied at each reflection checkpoint before
   * the next API request goes out. Surfaces to the model via the
   * `cooldown-applied-seconds` attribute on the checkpoint tag (so the
   * model can reason about elapsed wall time) and gives a human watching
   * the agent a chance to interrupt with Esc.
   *
   * Defaults to {@link DEFAULT_REFLECTION_COOLDOWN_MS} (60s). Set to 0
   * to keep the checkpoint attachment but skip the pause.
   */
  private reflectionCooldownMs: number = DEFAULT_REFLECTION_COOLDOWN_MS
  /**
   * Per-run counter for the ack/silence opt-out. When the model emits
   * `<ma::reflection-ack silence-for="K" reason="..." />` in its
   * response, this is set to K and decremented at each would-be
   * checkpoint. While positive, both the cooldown and the attachment are
   * skipped. Reset to 0 at the start of every `run()` call : silence is
   * per-turn, not session-wide.
   */
  private reflectionSilenceRemaining = 0
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
   * Optional tool-header time-hint tracker. When set, every tool block's
   * `╭ <icon> <label>  <content>` header gets a dim ` · <time>` suffix
   * showing when the tool was executed. The tracker carries day-state
   * across calls so the date prefix only repaints on calendar rollover
   * (per-session day key) — see {@link ToolTimeTracker} and
   * {@link fmtToolTime} in `src/tool-time.ts`.
   *
   * Off by default (no suffix emitted). `src/index.ts` constructs and
   * injects one for production; tests opt in per-case so existing
   * byte-exact header assertions stay stable.
   */
  private toolTimeTracker: ToolTimeTracker | null = null

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
    /**
     * Optional tasks-list attachment producer (see
     * {@link Agent.tasksAttachment}). Same structural-type pattern.
     */
    tasksAttachment?: { toAttachment(): ContentBlock | null } | null
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
    /**
     * Reflection checkpoint cadence (rounds). Default
     * {@link DEFAULT_REFLECTION_INTERVAL} (50). Pass 0 to disable
     * checkpoints entirely. See {@link Agent.reflectionInterval}.
     */
    reflectionInterval?: number
    /**
     * Wall-clock cooldown (ms) at each reflection checkpoint. Default
     * {@link DEFAULT_REFLECTION_COOLDOWN_MS} (60_000). Pass 0 to skip
     * the pause and only inject the attachment. See
     * {@link Agent.reflectionCooldownMs}.
     */
    reflectionCooldownMs?: number
    /**
     * Emergency hard cap on tool-execution rounds per `run()`. Default
     * `Number.POSITIVE_INFINITY` (no hard stop). Set to a finite number
     * to opt into the graceful-wrap-up safety net. See
     * {@link Agent.maxToolRounds}.
     */
    maxToolRounds?: number
    /**
     * Optional tool-header time-hint tracker. When provided, every tool
     * block's `╭` header is augmented with a dim ` · <time>` suffix
     * (e.g. `· May 14 15:42:03` on cold-start / day-rollover; `· 15:42:03`
     * thereafter). When omitted (the default) no suffix is appended :
     * existing tests asserting on exact header bytes stay green.
     * See {@link Agent.toolTimeTracker} and `src/tool-time.ts`.
     */
    toolTimeTracker?: ToolTimeTracker | null
  }) {
    this.auth = opts.auth
    this.model = opts.model ?? "claude-sonnet-4-6"
    this.effort = opts.effort
    this.thinkingDisplay = opts.thinkingDisplay
    this.loader = opts.loader ?? null
    this.modeManager = opts.modeManager ?? null
    this.saveEcho = opts.saveEcho ?? null
    this.shortTermSnapshot = opts.shortTermSnapshot ?? null
    this.tasksAttachment = opts.tasksAttachment ?? null
    this.sendFn = opts.sendFn ?? sendMessage
    this.store = opts.store ?? null
    // Loop-safety knobs : defaults are "no hard cap, 50-round reflection
    // checkpoint with 60s cooldown". See the field JSDoc for the why.
    // Negative values are coerced to 0 (disabled) defensively : we never
    // want a negative interval/cooldown leaking through to the loop math.
    if (typeof opts.reflectionInterval === "number" && opts.reflectionInterval >= 0) {
      this.reflectionInterval = Math.floor(opts.reflectionInterval)
    }
    if (typeof opts.reflectionCooldownMs === "number" && opts.reflectionCooldownMs >= 0) {
      this.reflectionCooldownMs = Math.floor(opts.reflectionCooldownMs)
    }
    if (typeof opts.maxToolRounds === "number" && opts.maxToolRounds > 0) {
      this.maxToolRounds = Math.floor(opts.maxToolRounds)
    }
    if (opts.toolTimeTracker !== undefined) {
      this.toolTimeTracker = opts.toolTimeTracker
    }
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
    //   3. <ma::tui::tasks …>…</ma::tui::tasks>        : active task list.
    //   4. <memory-saved scope="…" id="…">…</…>+      : id echo for any
    //      memory(ies) the model saved on the previous turn.
    //   5. user text                                   : the actual user input.
    //
    // ORDER NOTE: short-term snapshot and tasks both come before
    // save-echoes because they're persistent context the model needs
    // every turn ("what we're tracking" and "what's the plan");
    // save-echoes are deltas from the last turn and read more naturally
    // as a coda before the user text. Tasks sits AFTER short-term-memory
    // because short-term is more ambient (current symptoms / hypotheses);
    // tasks is the structured plan and reads better closer to the user
    // text it's anchored to.
    const initialUserContent: ContentBlock[] = []
    const initialModeAttach = this.modeManager?.consumePendingAttachment() ?? null
    if (initialModeAttach) initialUserContent.push(initialModeAttach)
    const stmAttach = this.shortTermSnapshot?.toAttachment() ?? null
    if (stmAttach) initialUserContent.push(stmAttach)
    const tasksAttach = this.tasksAttachment?.toAttachment() ?? null
    if (tasksAttach) initialUserContent.push(tasksAttach)
    const initialSaveEchoes = this.saveEcho?.consumeAll() ?? []
    for (const e of initialSaveEchoes) initialUserContent.push(e)
    initialUserContent.push({ type: "text", text: userText })
    this.messages.push({
      role: "user",
      content: initialUserContent,
    })
    this.store?.appendUser(initialUserContent)

    let rounds = 0
    // Silence is per-turn : the model has to re-ack each new user turn.
    // Reset here at the seam between turns so a stale silence counter
    // from the previous `run()` can't suppress checkpoints in this one.
    this.reflectionSilenceRemaining = 0
    // True iff we exited the loop because `rounds < this.maxToolRounds`
    // became false (i.e. an explicit finite emergency cap was reached
    // mid-task). Stays false on natural exit (model returned no tool_use
    // and we `break`'d). Used post-loop to decide whether to run the
    // graceful wrap-up turn : pessimistic default so a hypothetical
    // missing-break code path doesn't silently skip the wrap-up.
    let exitedByCap = true
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
    // Always pass the loop-safety knobs so the appended "Tool-use loop
    // safety" paragraph in system[2] reflects the runtime config (interval,
    // cooldown, emergency cap). Default values produce stable text, so the
    // cache key matches the corresponding systemHash computed at session
    // open in index.ts when both call sites use the same Agent defaults.
    const system = pluginBlock
      ? buildSystemPrompt({
          sessionContext: pluginBlock,
          reflectionInterval: this.reflectionInterval,
          reflectionCooldownMs: this.reflectionCooldownMs,
          maxToolRounds: this.maxToolRounds,
        })
      : undefined
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
      // Strip `<ma::reflection-ack ... />` from the streamed text channel
      // before it reaches the REPL sink. The agent still parses the tag
      // out of `lastResponse.text` (built from the same SSE deltas inside
      // the client) and surfaces a dim transcript line — that's the
      // user-visible artifact; the raw XML is internal protocol and
      // should not appear in scrollback. See
      // `src/reflection-ack-stripper.ts`.
      const ackStripper = createReflectionAckStripper()
      while (true) {
        const { done, value } = await gen.next()
        if (done) {
          response = value as unknown as StreamedResponse
          const tail = ackStripper.flush()
          if (tail.length > 0) yield tail
          break
        }
        const cleaned = ackStripper.write(value)
        if (cleaned.length > 0) yield cleaned
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

      // Reflection ack scan. The model can opt out of the next K
      // reflection checkpoints by emitting a `<ma::reflection-ack
      // silence-for="K" reason="..." />` tag anywhere in its assistant
      // text. We scan the concatenated response text (cheaper and more
      // robust than walking each text block individually : the regex is
      // anchored and content-blind to surrounding prose). The reason is
      // surfaced via writeTranscript so the human running the agent sees
      // WHY the model silenced itself : helps catch a model that's just
      // pattern-matching the syntax without a genuine autonomous-work
      // justification.
      if (this.reflectionInterval > 0 && lastResponse.text.length > 0) {
        const ack = parseReflectionAck(lastResponse.text)
        if (ack !== null && ack.silenceFor > 0) {
          this.reflectionSilenceRemaining = ack.silenceFor
          const reasonSuffix = ack.reason.length > 0 ? ` — ${ack.reason}` : ""
          writeTranscript(
            `  ${c.dim("›")} ${c.dim(`reflection ack: silencing next ${ack.silenceFor} checkpoint${ack.silenceFor === 1 ? "" : "s"}${reasonSuffix}`)}`,
          )
        }
      }

      // Check for tool use blocks
      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")

      if (toolBlocks.length === 0) {
        // No tool calls : model is done. Mark this as a natural exit so
        // the post-loop wrap-up turn does NOT fire : the model already
        // wrote its final text, we'd just be duplicating output (and
        // wasting an API call) if we sent another request.
        exitedByCap = false
        break
      }

      // Execute tools and collect results
      const toolResults: ToolResultBlock[] = []
      for (const tool of toolBlocks) {
        const pres = toolPresentation.get(tool.name)
        const renderCols = process.stdout.columns
        const pluginTool = this.loader?.hasTool(tool.name) ?? false
        let headerWritten = false
        const writeToolHeader = (override?: string): void => {
          if (headerWritten) return
          headerWritten = true
          // Header layout is always `╭ [icon] [label]  [content] [· <time>]`.
          // The icon and label come from the manifest unconditionally (so
          // the tool's identity stays visible regardless of what the plugin
          // renders); the content slot is the only thing a plugin can
          // customize, via `displayHeader`. When no override is provided,
          // the slot is filled with the default `formatToolInput` summary
          // plus any continuation rows the formatter wants to add. The
          // optional ` · <time>` suffix is appended last when an
          // Agent.toolTimeTracker is wired up (production always; tests
          // opt in). See src/tool-time.ts for the format ladder
          // (HH:MM:SS / Mon DD HH:MM:SS).
          const labelColor =
            pres?.color && (c as Record<string, (s: string) => string>)[pres.color]
              ? (c as Record<string, (s: string) => string>)[pres.color]
              : c.orange
          const icon = pres?.icon ? `${labelColor(pres.icon)} ` : ""
          const label = c.bold(labelColor(tool.name))
          // Capture the time-hint BEFORE formatting the content so
          // soft-split (and continuation rows) can be told to leave room
          // for it on the right. First-tool / day-rollover suffix is
          // "May 14 15:42:03" (15 cells); steady-state is "15:42:03"
          // (8 cells). The leading ` · ` separator adds 3 more, plus a
          // small gutter so the suffix doesn't visually butt against the
          // wrap edge. Both formatToolInput AND formatToolInputContinuation
          // get the SAME adjusted cols so the soft-split decision is
          // consistent across the first row and continuation rows.
          // `suppressToolTime` is set by plugins that draw their own
          // trailing date+time inside `displayHeader` (e.g. the tasks
          // plugin renders `· YYYY-MM-DD HH:MM:SS` with year). Skip the
          // agent's `· HH:MM:SS` suffix entirely AND do NOT advance the
          // ToolTimeTracker — letting a later non-suppressed tool emit
          // the normal day-rollover prefix if appropriate.
          const timeText = suppressToolTime ? undefined : this.toolTimeTracker?.format(Date.now())
          const timeSuffix = timeText !== undefined ? ` · ${timeText}` : ""
          const TIME_HINT_GUTTER = 2
          const adjustedCols =
            renderCols !== undefined && timeSuffix.length > 0
              ? Math.max(20, renderCols - displayWidth(timeSuffix) - TIME_HINT_GUTTER)
              : renderCols
          const dimTimeSuffix = timeSuffix.length > 0 ? c.dim(timeSuffix) : ""
          const content = override ?? c.dim(formatToolInput(tool, adjustedCols))
          const headerLine =
            content.length === 0
              ? `${icon}${label}${dimTimeSuffix}`
              : `${icon}${label}  ${content}${dimTimeSuffix}`
          // Outer-row clamp catches cases the inner soft-split machinery
          // doesn't (Bash commands with no operators, long file paths,
          // generic JSON-fallback headers). Pre-clamp the row INCLUDING
          // its `  ╭ ` gutter prefix so it never overflows the visible
          // column count. See {@link clampTranscriptRow}.
          writeTranscript(
            `\n${clampTranscriptRow(`  ${c.dimCyan("╭")} ${headerLine}`, renderCols)}`,
          )
          if (override === undefined) {
            // Indent so `↳`/`>` aligns directly under the start of the
            // command body in the header (under `c` of `cd …`). See
            // {@link toolContinuationIndentCells} for the layout walk.
            const indent = " ".repeat(toolContinuationIndentCells(tool.name, pres?.icon))
            for (const cont of formatToolInputContinuation(tool, adjustedCols)) {
              writeTranscript(
                clampTranscriptRow(`  ${c.dimCyan("│")} ${indent}${c.dim(cont)}`, renderCols),
              )
            }
          }
          writeTranscript(`  ${c.dimCyan("│")}`)
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
        const gate = this.modeManager?.isToolAllowed(tool.name) ?? { allowed: true as const }
        if (!gate.allowed) {
          writeToolHeader()
          content = gate.message
          isError = true
          // Render a denial line in the transcript so the user sees what
          // got blocked. ⊘ glyph + dim red label + the refusal message.
          writeTranscript(`  ${c.dimCyan("│")} ${c.boldRed("⊘")} ${c.dim(content)}`)
          writeTranscript(
            `  ${c.dimCyan("╰")} ${c.dim(`(refused by ${this.modeManager?.activeId() ?? "mode"})`)}`,
          )
        } else {
          if (!pluginTool) writeToolHeader()
          const toolStartedAt = Date.now()
          const toolStatus = GLOBAL_STATUS_BUS.create(`Running ${tool.name}`, {
            notificationId: "tool.running",
            category: "tool",
            // Seed `direction:"down"` AND `lastChunkAt: toolStartedAt` so
            // the activity infix auto-flips to the amber
            //   `⋯ stalled · last byte Ns ago`
            // form after 2s of no chunks (see STALL_THRESHOLD_MS in
            // status.ts → formatActivityInfix). This is the visible
            // signal that distinguishes a subprocess that's working
            // silently from one that's piping into a buffering filter
            // like `tail -N` / `head -N` / `sort` (which holds all stdout
            // until EOF — the user observes this as "Bash is frozen").
            // When chunks DO start arriving (onChunk below), `lastChunkAt`
            // is bumped and the stalled state clears, giving way to
            // `↓ 1.2 KB · 12 B/s` etc.
            activity: {
              direction: "down",
              startedAt: toolStartedAt,
              recvBytes: 0,
              lastChunkAt: toolStartedAt,
            },
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
                // Per-line width clamp : `min(terminal_cols - gutter,
                // TOOL_PREVIEW_LINE_WIDTH)` at the moment this line is
                // emitted. Live width (no `cols` arg → reads
                // `process.stdout.columns` now), so a mid-stream resize
                // takes effect on the very next line. Scrollback above
                // never re-renders, but no NEW line will overflow the
                // current visible columns. See {@link
                // effectiveBodyLineWidth} and {@link clampBodyWithHint}.
                bufferedLastLine = clampBodyWithHint(raw, effectiveBodyLineWidth())
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
            if (!headerWritten) writeToolHeader(displayHeader)
            for (const line of formatToolPreview(content, isError, display, {
              tool: tool.name,
              info: truncInfo,
              footer: displayFooter,
              cols: renderCols,
            })) {
              writeTranscript(line)
            }
          }

          // Layer 1b of size-feedback (companion to truncation.ts notice and
          // feedback-tracker.ts streak note): when the user's transcript
          // clamped MORE lines than the API cap did (every tool with a tight
          // preview budget : Bash=10, Read=15, Grep=12, Glob=25), append a
          // model-only `<ma::tui-preview …>` annotation to `content` BEFORE
          // we push it to `toolResults`, so the model knows the audiences
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
              const hint = tuiPreviewHint(tool.name)
              content =
                `${content}\n\n<ma::tui-preview ` +
                `shown="${e.shown}" total="${e.total}" tool="${tool.name}">` +
                hint +
                `</ma::tui-preview>`
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

      // Reflection checkpoint. After a full round (assistant response +
      // tool execution) at every Nth round, apply the wall-clock cooldown
      // (interruptible via Esc through the existing AbortSignal path),
      // then inject the model-facing `<ma::reflection-checkpoint>` marker.
      // The ack/silence counter (set by parseReflectionAck on the
      // assistant response above) gates BOTH the cooldown and the
      // attachment : when silenceRemaining > 0 we decrement and skip
      // both, so the model gets exactly what it asked for. Order: the
      // checkpoint attachment goes LAST in userContent so it's the most
      // recent context the model reads on the next request (peak
      // salience for "act on this now").
      if (this.reflectionInterval > 0 && rounds % this.reflectionInterval === 0) {
        if (this.reflectionSilenceRemaining > 0) {
          this.reflectionSilenceRemaining -= 1
        } else {
          await runReflectionCooldown({
            totalMs: this.reflectionCooldownMs,
            round: rounds,
            statusBus: GLOBAL_STATUS_BUS,
            ...(signal ? { signal } : {}),
          })
          // If Esc landed during the cooldown the top-of-loop check on
          // the next iteration will throw AbortError; pushing the
          // checkpoint marker here is still safe because the messages
          // history stays well-formed (tool_result-first ordering is
          // preserved, the trailing text is a normal user-message
          // continuation).
          userContent.push(buildReflectionCheckpointBlock(rounds, this.reflectionCooldownMs))
        }
      }

      this.messages.push({ role: "user", content: userContent })
    }

    // Graceful emergency-cap wrap-up turn. Only fires when a host has
    // explicitly configured a finite `maxToolRounds` AND we exited the
    // loop because that cap was reached (not because the model returned
    // a tool_use-free response on its own). Default-configured Agents
    // have `maxToolRounds === Number.POSITIVE_INFINITY` so this branch
    // is dead code unless opted into.
    //
    // The wrap-up replaces the old abrupt-cliff behavior (last assistant
    // turn was a `tool_use` that got no `tool_result` and no follow-up
    // text). Instead we append a model-facing
    // `<ma::emergency-cap-triggered>` marker to the last user message
    // (which already carries the tool_results from the cap-th round,
    // satisfying the Anthropic API's "tool_result must follow tool_use
    // immediately" constraint) and send one more request with `tools`
    // undefined : the model can't call tools, so it has to write a
    // summary text. We update `lastResponse` so the caller sees that
    // clean final response instead of the orphaned tool_use round.
    if (exitedByCap && Number.isFinite(this.maxToolRounds)) {
      writeTranscript(
        `\n  ${c.boldYellow("!")} ${c.yellow(`Emergency cap reached (${this.maxToolRounds} tool rounds) — sending final tools-disabled wrap-up`)}`,
      )

      const lastMsg = this.messages[this.messages.length - 1]
      if (lastMsg && lastMsg.role === "user") {
        const content = Array.isArray(lastMsg.content)
          ? lastMsg.content
          : [{ type: "text" as const, text: lastMsg.content }]
        content.push({
          type: "text",
          text:
            `<ma::emergency-cap-triggered round="${this.maxToolRounds}" />\n` +
            `You have reached the configured emergency tool-round cap for this user turn. Tools are disabled for this final response. Summarize what you accomplished, surface anything the user should know, and stop.`,
        })
        lastMsg.content = content
      }

      const wrapGen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        // tools intentionally omitted : the model cannot call tools on
        // this final turn, so it MUST write text and finish.
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
      let wrapResponse: StreamedResponse | undefined
      // Fresh stripper for the wrap-up turn — separate stream from the
      // main loop above so it gets its own tail buffer.
      const wrapAckStripper = createReflectionAckStripper()
      while (true) {
        const { done, value } = await wrapGen.next()
        if (done) {
          wrapResponse = value as unknown as StreamedResponse
          const tail = wrapAckStripper.flush()
          if (tail.length > 0) yield tail
          break
        }
        const cleaned = wrapAckStripper.write(value)
        if (cleaned.length > 0) yield cleaned
      }
      if (wrapResponse) {
        lastResponse = wrapResponse
        if (wrapResponse.blocks.length > 0) {
          this.messages.push({ role: "assistant", content: wrapResponse.blocks })
          this.store?.appendAssistant(wrapResponse.blocks, wrapResponse.stopReason, undefined)
        }
      }
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

    // Use `this.sendFn` (the injectable transport) so tests can stub the
    // SSE layer the same way they do for `run()`. Previously this called
    // `sendMessage` directly, which left `send()` un-testable without
    // hitting the real API.
    const gen = this.sendFn({
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
    // Strip `<ma::reflection-ack ... />` from the streamed text channel.
    // `send()` is the no-tools single-shot variant and doesn't run the
    // reflection-checkpoint loop, so a model rarely has reason to emit
    // the tag here — but we strip defensively so accidental emissions
    // don't leak into scrollback. See `src/reflection-ack-stripper.ts`.
    const ackStripper = createReflectionAckStripper()
    while (true) {
      const { done, value } = await gen.next()
      if (done) {
        response = value as unknown as StreamedResponse
        const tail = ackStripper.flush()
        if (tail.length > 0) yield tail
        break
      }
      const cleaned = ackStripper.write(value)
      if (cleaned.length > 0) yield cleaned
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
 * Cell count of the indent that continuation rows need *after* their
 * `  │ ` frame so the `↳`/`>` sigil aligns directly under the start of
 * the command body in the header row.
 *
 * Header layout (live agent):
 *
 * ```
 *   ╭ » Bash  $ cd /Users/...
 *               ^ command body starts here (col 14)
 * ```
 *
 * Continuation layout (what this indent achieves):
 *
 * ```
 *   │           ↳ && git push ...
 *               ^ ↳ aligned with `c` of `cd` (col 14)
 * ```
 *
 * The math walks the visible cells in the header BEFORE the command
 * body: icon (if any) + trailing space + label + 2-space gap + `$ `
 * sigil. Stripped ANSI is implicit because callers pass the bare text
 * (`tool.name`, manifest `icon`) not the colored render.
 *
 * Returns `0` for non-Bash tools (no continuation rows exist there
 * today). For Bash:
 *  - with `»` icon → 10 cells of padding
 *  - without icon (session-replay header) → 8 cells of padding
 *
 * Two emit sites consume this: `agent.ts` (live agent transcript) and
 * `session-replay.ts` (--resume scrollback rehydration). Keeping the
 * arithmetic in one helper makes both stay in sync if header shape
 * changes later.
 */
export function toolContinuationIndentCells(toolName: string, iconText?: string): number {
  if (toolName !== "Bash") return 0
  const iconCells = iconText ? displayWidth(iconText) + 1 : 0
  const labelCells = displayWidth(toolName)
  const gapCells = 2
  const cmdSigilCells = 2 // "$ " from formatToolInput
  return iconCells + labelCells + gapCells + cmdSigilCells
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
 * Three flavors of model-only annotation can ride at the end of
 * `tool_result.content`:
 *
 *  - `\n\n[truncated: ...]`           : universal API-cap notice
 *    (see `tools/truncation.ts`).
 *  - `\n\n[note: ...]`                : streak tracker note
 *    (see `tools/feedback-tracker.ts`).
 *  - `\n\n<ma::tui-preview …>…</ma::tui-preview>` : Layer 1b annotation
 *    (this file).
 *
 * Order at end of content is fixed: `[truncated:]` → `[note:]` →
 * `<ma::tui-preview>`. `findAnnotationStart` returns the index of the
 * EARLIEST true annotation (= start of the annotation region) so callers
 * can slice the body cleanly. Using per-pattern `lastIndexOf` (not a
 * single regex with `.match()`) hardens against the case where the body
 * itself legitimately contains the prefix (e.g. a `Read` of a log that
 * happens to include the string `[truncated:`) : the last occurrence
 * is the real annotation, body-internal occurrences are earlier.
 *
 * Convention note: `[truncated:]` and `[note:]` are legacy bracket-string
 * shapes. New annotations use the `<ma::…>` XML-like namespace (per
 * project convention). When the legacy ones are eventually retrofitted
 * (cross-version replay-breaking change), this collapses to a single
 * `<ma::…>` test.
 */
const ANNOTATION_PREFIXES = ["\n\n[truncated:", "\n\n[note:", "\n\n<ma::tui-preview"] as const

function findAnnotationStart(content: string): number {
  let earliest = -1
  for (const p of ANNOTATION_PREFIXES) {
    const i = content.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest
}

/**
 * Compute the TUI vs body line gap for the `<ma::tui-preview>` annotation.
 * Returns `null` when the body fits in the per-tool budget or there's no
 * body at all.
 *
 * Strips any trailing annotation from `content` before counting lines, so
 * re-application of the note is idempotent (a peer agent's prior note in
 * historical content doesn't double up). The line count is taken AFTER
 * stripping, so the note reads "user saw N of M lines of *what you saw*"
 * : accurate even when the API ALSO truncated (in which case `[truncated:]`
 * carries the separate source→model ratio).
 */
function computeTuiElision(content: string, tool: string): { shown: number; total: number } | null {
  const idx = findAnnotationStart(content)
  const body = idx >= 0 ? content.slice(0, idx) : content
  if (!body) return null
  const total = body.split("\n").length
  const budget = TOOL_PREVIEW_LINES[tool] ?? TOOL_PREVIEW_LINES_DEFAULT
  if (total <= budget) return null
  return { shown: budget, total }
}

/**
 * Per-tool hint body for `<ma::tui-preview>`. Bash is the worst offender
 * (model often picks it as a "render visual content to the user" channel
 * even though the transcript clamps at 10 lines), so we point it at the
 * right channel explicitly. Other tools get a gentler "summarize for the
 * user" nudge.
 */
function tuiPreviewHint(tool: string): string {
  switch (tool) {
    case "Bash":
      return (
        "the user only saw a fraction of this output. If you used Bash to " +
        "render visual content (ASCII art, ANSI TUI preview, formatted " +
        "tables) for the user, put it in your text reply instead : the " +
        "user reads that in full."
      )
    default:
      return (
        "the user only saw a fraction of this output. If you intended this " +
        "for the user, summarize the key parts in your text reply (the " +
        "user reads it in full)."
      )
  }
}

/**
 * Hard per-line cap for body lines. Protects against pathological cases
 * (e.g. a 10_000-char minified JSON line in a `Read` result) on terminals
 * wider than this value : without the cap, one mega-line would still
 * dominate the preview even when it physically fits. 300 cells is
 * generous enough to read most code and structured output.
 *
 * The terminal width takes precedence when narrower : see
 * {@link effectiveBodyLineWidth}. Lines are truncated **at render time**
 * with the current `process.stdout.columns` (or the snapshot the caller
 * passed via `opts.cols`), so a body line never overflows the visible
 * column count and the terminal never has to wrap it. Scrollback is
 * permanent : a later resize does not re-render older blocks, but every
 * new tool block paints correctly under the new width.
 */
const TOOL_PREVIEW_LINE_WIDTH = 300
const TOOL_PREVIEW_GUTTER_WIDTH = 4
const TOOL_PREVIEW_WRAP_SAFETY_WIDTH = 1

/**
 * Compute the safe body width for a tool transcript line as
 * `terminal_cols - gutter - wrap_safety`. Returns `undefined` when the
 * caller has no width signal (non-TTY contexts like unit tests where
 * `process.stdout.columns` is also unset). That sentinel lets the
 * display-channel branch (Edit/Write diffs) opt out of clamping when
 * width is unknown : tests get deterministic full-width output, and
 * production gets a real number.
 *
 * The `gutter` accounts for the `"  │ "` (or `"  ╰ "`) prefix every row
 * carries (4 cells); the 1-cell `WRAP_SAFETY` keeps a column free at the
 * right edge so a single off-by-one in a wide-glyph terminal can't tip
 * the line into a wrap.
 */
function toolPreviewBodyWidth(cols?: number): number | undefined {
  const raw = cols ?? process.stdout.columns
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  const max = Math.floor(raw) - TOOL_PREVIEW_GUTTER_WIDTH - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  return max > 0 ? max : 0
}

/**
 * Body-line render width for the main preview path : the effective
 * `min(terminal_cols - gutter - safety, TOOL_PREVIEW_LINE_WIDTH)`.
 *
 * Always returns a positive integer. When the terminal width signal is
 * missing OR pathologically small (≤ gutter), falls back to the fixed
 * hard cap so the behavior in unit tests (no TTY, no `cols` argument)
 * stays deterministic at 300 cells. In production with a real TTY the
 * terminal-derived width almost always wins (e.g. an 127-col terminal
 * gives 127 − 4 − 1 = 122, well below the 300 cap).
 *
 * Mirrors the semantic of `toolPreviewBodyWidth` but collapses the
 * "no width" sentinel to the hard cap so callers don't need a separate
 * fallback branch.
 */
function effectiveBodyLineWidth(cols?: number): number {
  const termBased = toolPreviewBodyWidth(cols)
  if (termBased === undefined || termBased <= 0) return TOOL_PREVIEW_LINE_WIDTH
  return Math.min(termBased, TOOL_PREVIEW_LINE_WIDTH)
}

function clampToolPreviewBodyLine(line: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || displayWidth(line) <= maxWidth) return line
  return truncateDisplayWidth(line, maxWidth, "...")
}

/**
 * Width budget reserved for the `truncHint("ch")` marker
 * (`...(+NNNNch)`) when a body line is clamped. The marker is appended
 * AFTER the trim, so the trim itself must leave room for it inside
 * `maxWidth` : otherwise `body = trimmed + hint` exceeds the visible
 * column count and the terminal soft-wraps the row into the gutter.
 *
 * 12 cells covers `"...(+99999ch)"` (worst realistic case for `head -c`
 * sized output) ; rare overshoots (cut > 99_999 chars) drift one cell
 * past the cap, far below the `WRAP_SAFETY` slop on the outside of the
 * row. Picked over an iterative "compute hint width, re-trim" loop for
 * simplicity : the lost 1–2 body cells are imperceptible.
 */
const TOOL_PREVIEW_HINT_RESERVE_WIDTH = 12

/**
 * Trim a body line to `maxWidth` cells with the standard `...(+Nch)`
 * truncation marker. Reserves {@link TOOL_PREVIEW_HINT_RESERVE_WIDTH}
 * cells for the marker so the rendered total (`trimmed + hint`) never
 * exceeds `maxWidth`. Returns the line unmodified when it already fits.
 *
 * Shared by the live Bash stream renderer (`flushLineToBuffer`) and the
 * batched `formatToolPreview` body path so both paths produce identical
 * shape under identical widths.
 */
function clampBodyWithHint(line: string, maxWidth: number): string {
  if (displayWidth(line) <= maxWidth) return line
  const trimWidth = Math.max(1, maxWidth - TOOL_PREVIEW_HINT_RESERVE_WIDTH)
  const trimmed = truncateDisplayWidth(line, trimWidth, "")
  // eslint-disable-next-line typescript-eslint/no-misused-spread
  const cpCut = [...line].length - [...trimmed].length
  return `${trimmed}${truncHint(cpCut, "ch")}`
}

/**
 * Outer-row clamp for a fully-composed transcript line including its
 * gutter prefix (`  ╭ …` / `  │ …` / `  ╰ …`). When `cols` is known
 * and the row's display width exceeds it, truncate to fit with the
 * standard `...(+Nch)` hint marker; otherwise pass through verbatim.
 *
 * Used by `writeToolHeader` to catch the cases the inner soft-split
 * machinery doesn't cover : Bash commands with no operators that
 * overflow, long single-path Read/Write/Edit/Glob/Grep headers,
 * generic JSON-fallback headers. The body preview path already
 * handles this in `formatToolPreview` (see `clampBodyWithHint`).
 *
 * Trade-off: when a header truly overflows, the trailing time-hint
 * suffix (` · 07:30:26`) gets eaten by the trim. That's preferable to
 * the alternative (preserve time, lose the path tail) since the path
 * tail is far more semantically valuable than the timestamp.
 */
export function clampTranscriptRow(row: string, cols?: number): string {
  if (cols === undefined || !Number.isFinite(cols) || cols <= 0) return row
  const maxWidth = Math.floor(cols) - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  if (maxWidth <= 0) return row
  return clampBodyWithHint(row, maxWidth)
}

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

/**
 * True when `line` is the **outer frame closer** of a tool transcript block
 * (the bottom-left `╰` glyph in the gutter). The live-area sink uses this
 * signal to add one blank row of breathing room before the next block.
 *
 * The discriminator must be specific to the **outer-gutter** position
 * (immediately after the 2 leading spaces and any ANSI prefix), NOT a
 * blanket "anywhere in the line" check : body content can legitimately
 * carry `╰` as a tree-last connector (e.g. the tasks plugin's `treeLast`
 * glyph in the subtask block), in titles, in user-supplied filenames,
 * etc. A blanket match misclassifies those rows as block-closers and
 * the sink emits an extra `\n`, producing a bare blank row with no `│`
 * gutter behind it.
 *
 * Recognized shapes (all match):
 *   "  ╰ 5 done · 1 doing · 2 todo"
 *   "  \x1b[36m╰\x1b[0m  0/3"
 *   "  \x1b[36;2m╰\x1b[0m"               (just the glyph, no body)
 *
 * Non-matches (body rows that happen to contain ╰):
 *   "  │        ╰  ○  #abc  Add regression test"   ← tasks treeLast
 *   "  │ note: file named ╰.txt"                   ← body content
 */
// Match the outer-gutter `╰`: start-of-line, optional ≤2 leading spaces
// (the gutter indent), then any number of ANSI CSI SGR sequences
// (`\x1b[<digits-and-semicolons>m`), then the `╰` glyph. Anchored at
// `^` so it cannot fire on `╰` appearing later in the body.
//
// Why CSI-only: every glyph emitted at this position goes through one of
// the `c.*` color combinators in this file, which exclusively use SGR
// (CSI `m`) sequences : we don't need to handle OSC / DCS / etc. here.
const OUTER_FRAME_CLOSE_RE = /^ {0,2}(?:\x1b\[[\d;]*m)*╰/

/**
 * Detect whether a transcript line is the outermost-gutter `╰` closer of
 * a tool block (as opposed to a body line that incidentally contains the
 * `╰` glyph — e.g. tasks subtree connectors, Bash grep output, Edit diff
 * bodies). Used by `runReplLiveArea`'s transcript sink to decide whether
 * to emit the extra trailing `\n` that visually separates one tool block
 * from the next.
 *
 * Strict anchor at `^`, ≤2 leading spaces (the outer gutter indent),
 * optional SGR CSI sequences for color, then `╰`. NOT a substring match —
 * see regression coverage in `src/agent.outer-frame-close.test.ts`.
 */
export function isOuterFrameClose(line: string): boolean {
  return OUTER_FRAME_CLOSE_RE.test(line)
}

/**
 * Render a tool's result block for the transcript: the rows between
 * `╭ <header>` (written separately by the caller) and the closing `╰`.
 * Inserts the `│ ` gutter on each row, applies the per-tool body line
 * budget (`TOOL_PREVIEW_LINES`), and appends a structured footer for
 * truncation / line-count overflow when applicable.
 *
 * When `display` is provided AND `isError` is falsy, the pre-rendered
 * ANSI string (Edit/Write diffs, plugin custom payloads) is emitted
 * verbatim without truncation — diffs and structured renders are the
 * point of the override channel.
 *
 * @param content   Raw tool output (model-facing payload); may carry a
 *                  trailing `[truncated: ...]` notice which is stripped
 *                  before display (the human-facing footer carries the
 *                  same facts in compact form).
 * @param isError   When true, render bias toward visibility (no display
 *                  override, no overflow trim).
 * @param display   Optional pre-rendered ANSI payload to use instead of
 *                  the truncated `content`.
 * @param opts      `tool` (line budget), `info` (truncation facts for
 *                  the footer), `footer` (display-mode footer override),
 *                  `cols` (per-line clamp width).
 */
export function formatToolPreview(
  content: string,
  isError?: boolean,
  display?: string,
  opts?: { tool?: string; info?: TruncationInfo; footer?: string; cols?: number },
): string[] {
  // If the tool provided a pre-rendered display string (e.g. ANSI-colored
  // unified diff from Edit/Write), render it as-is, line by line, with the
  // standard `│ ... └` connector gutter. Per-line clamp to the live
  // terminal width still applies so a 400-char diff line in a 90-col
  // terminal doesn't soft-wrap into the gutter ; we don't apply the 300-
  // cell preview cap here (diffs are the point on wide terminals). When
  // the caller has no width signal (e.g. unit tests with no TTY and no
  // `opts.cols`), `toolPreviewBodyWidth` returns `undefined` and
  // `clampToolPreviewBodyLine` becomes a no-op : full-width verbatim
  // output for tests, terminal-aware clamping in production.
  if (display !== undefined && !isError) {
    const out: string[] = []
    const footer = opts?.footer
    const bodyWidth = toolPreviewBodyWidth(opts?.cols)
    const body = footer === undefined ? display.replace(/\n$/, "") : display
    const dlines = body.length === 0 ? [] : body.split("\n")
    if (dlines.length === 0 && footer === undefined) {
      out.push(`  ${c.dimCyan("╰")}`)
      return out
    }
    for (let i = 0; i < dlines.length; i++) {
      const connector = footer === undefined && i === dlines.length - 1 ? "╰" : "│"
      const line = clampToolPreviewBodyLine(dlines[i], bodyWidth)
      out.push(
        line.length === 0 ? `  ${c.dimCyan(connector)}` : `  ${c.dimCyan(connector)} ${line}`,
      )
    }
    if (footer !== undefined) {
      const footerLine = clampToolPreviewBodyLine(footer, bodyWidth)
      out.push(
        footerLine.length === 0 ? `  ${c.dimCyan("╰")}` : `  ${c.dimCyan("╰")} ${footerLine}`,
      )
    }
    return out
  }

  const tool = opts?.tool
  const info = opts?.info
  const color = isError ? c.red : c.dim

  // 1. Strip ALL model-only trailing annotations from what we display to
  //    the human. Three flavors today : `[truncated: ...]`, `[note: ...]`,
  //    `<ma::tui-preview ...>...</ma::tui-preview>` (see
  //    `findAnnotationStart`). They live at end-of-content separated by
  //    `\n\n` and stack in a fixed order, so the earliest of their
  //    last-occurrences is the start of the annotation region and we slice
  //    from there. The structured `info` (when supplied) carries the same
  //    truncation numbers in machine form : we render those as the
  //    bare-facts footer instead.
  const noticeIdx = findAnnotationStart(content)
  let body = noticeIdx >= 0 ? content.slice(0, noticeIdx) : content

  // 2. Per-line width clamp (display-width-aware so wide chars / emoji /
  //    CJK don't blow past the budget). The clamp is the effective body
  //    width : `min(terminal_cols - gutter, TOOL_PREVIEW_LINE_WIDTH)`.
  //    Without the terminal-width factor an N-cell preview line in an
  //    M-col terminal where N > M would soft-wrap and produce the
  //    "  │ start..." / "...end of line" split scrollback (user-reported,
  //    May 2026). Scrollback never re-renders on resize, but every new
  //    tool block paints under the live width. See {@link
  //    effectiveBodyLineWidth} for the cap rationale and {@link
  //    clampBodyWithHint} for the hint-reserve detail.
  const maxLines = TOOL_PREVIEW_LINES[tool ?? ""] ?? TOOL_PREVIEW_LINES_DEFAULT
  const allLines = (body || "(no output)").split("\n")
  const visible = allLines.slice(0, maxLines)
  const linesElided = allLines.length - visible.length
  const lineWidth = effectiveBodyLineWidth(opts?.cols)
  const renderedLines: string[] = visible.map((line) => clampBodyWithHint(line, lineWidth))

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
  /**
   * Submit event. The optional `commitLines` argument carries the
   * pre-rendered scrollback lines for the just-submitted prompt :
   * the host writes them to scrollback at TURN START (or tool-boundary
   * drain time for queued items), NOT at submit time, so a prompt that
   * sits queued does not appear in both scrollback and the queue widget
   * (Bug 393). Listeners that only care about `text` can ignore it.
   */
  on(event: "submit", listener: (text: string, commitLines?: string[]) => void): unknown
  on(event: "cancel", listener: (reason?: string) => void): unknown
  /**
   * Emitted by the abort-quit FSM when the user has confirmed a quit
   * (second Ctrl+C inside the 10s armed window OR the escape-hatch
   * "rapid double Ctrl+C"). Reason indicates which path fired. The
   * legacy `"cancel"` event is also emitted for back-compat (with the
   * same reason argument).
   */
  on(event: "quit", listener: (reason: "confirmed" | "escape-hatch") => void): unknown
  off?(event: "submit" | "cancel" | "quit", listener: (...args: unknown[]) => void): unknown
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
  /**
   * Optional. Notify the editor's abort-quit FSM that a turn has started.
   * The FSM transitions idle/armed → working and dismisses any armed
   * footer. No-op when the editor doesn't implement quit-confirm.
   */
  notifyTurnStart?(): void
  /**
   * Optional. Notify the editor that a turn has settled (success, error,
   * or aborted). Transitions working → idle (or stays armed if a Ctrl+C
   * abort had already pushed us into armed:post-abort).
   */
  notifyTurnEnd?(): void
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
    /**
     * Forwarded to {@link runReplLiveArea} for the goodbye banner. When
     * provided, a quit (confirmed Ctrl+C×2 or escape-hatch) prints the
     * resume hint with this id. Omit / empty → degraded copy.
     */
    sessionId?: string
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

  // Ready banner is now written from `src/index.ts` BEFORE any resume
  // replay (see `buildReadyBanner` in `./ready-banner.ts`). This REPL
  // entry point no longer emits it : keeps the banner at the top of
  // scrollback for both fresh starts and `--resume` sessions instead of
  // landing below the replayed content.

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
        // Same gating as the live-REPL path: when the throw already
        // routed through `diag.error(...)`, the ScrollbackDiagnosticSink
        // has rendered the failure as a rich block. Skip the bare
        // fallback line to avoid duplicating the message.
        if (!isErrorDiagEmitted(turnError)) {
          errOutput.write(`\n  ${c.boldRed("error")} ${msg}\n`)
        }
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
    /**
     * Session id used in the goodbye banner's `--resume <id>` hint. When
     * the user quits (confirmed Ctrl+C×2 OR escape-hatch), the banner is
     * printed AFTER the editor/compositor teardown so it lands in normal
     * scrollback. Omit / empty → degraded copy without the resume line.
     */
    sessionId?: string
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

  // Host-side listener for `editor.buffer.set` — plugins (e.g. a future
  // Ctrl+R search modal in `history`) may need to replace the editor
  // buffer OUTSIDE the `editor.key` flow (where they can already do so
  // via `result.buffer`). Payload: `{text}`. setBuffer parks the cursor
  // at end-of-buffer; plugins that need finer cursor placement should
  // use the `editor.key` payload's `result.cursor` instead.
  //
  // No-op when no plugins are loaded; the listener never fires.
  if (loader) {
    loader.hooks().on(
      "editor.buffer.set",
      (payload: unknown) => {
        if (!payload || typeof payload !== "object") return
        const p = payload as { text?: unknown }
        if (typeof p.text !== "string") return
        if (typeof editor.setBuffer === "function") editor.setBuffer(p.text)
      },
      { source: "agent", priority: 5000, label: "agent:editor.buffer.set" },
    )
  }

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

  // Footer band setup is deferred to AFTER `editor.on("submit", ...)`
  // registration below : the dynamic imports here suspend execution
  // for ≥3 microtask cycles, and any stdin bytes that arrive during
  // that window fire the editor's "submit" event into the void
  // (no listener attached yet). Tests that submit immediately after
  // `runRepl(...)` + 2 `await Promise.resolve()` ticks would lose
  // their first keystroke. We pre-declare the locals here so the
  // `finally` block at end-of-fn can still reference them.
  const slotRows = loader?.getLiveAreaSlots() ?? []
  let liveAreaScheduler: import("./live-area-providers.ts").LiveAreaScheduler | null = null
  let tuiDiagnosticSurface: import("./log-tui.ts").TuiDiagnosticSurface | null = null

  // Ready banner is now written from `src/index.ts` via direct stdout
  // BEFORE the compositor mounts and BEFORE any resume replay. See
  // `buildReadyBanner` in `./ready-banner.ts` for the rationale (on
  // resume the banner used to land below the replayed content because
  // the replay had already streamed straight to stdout pre-mount;
  // moving the banner to the top of the scrollback phase fixes that).
  //
  // The trailing `\n\n` in the banner provides the one blank row of
  // breathing room above whatever comes next (resume separator or
  // prompt), so we no longer need to emit it here.

  // Submit queue: keystrokes never block, but we serialize agent turns.
  // Each queue item carries BOTH the user's text (for the agent) AND the
  // pre-rendered scrollback lines (for the TUI). The scrollback write is
  // deferred from EditorController.submit() to TURN START / drain time
  // here, so a queued prompt never appears in BOTH the scrollback and
  // the queue widget at the same time (Bug 393).
  type QueueItem = { text: string; commitLines: string[] }
  const queue: QueueItem[] = []
  /** Flush a queue item's pre-rendered scrollback lines, if any. */
  const flushQueueItemToScrollback = (item: QueueItem): void => {
    if (item.commitLines.length === 0) return
    if (typeof compositor.writeStream !== "function") return
    // Matches the lead `EditorController.submit` used to emit before
    // the scrollback-write was deferred here : `\n\n\n` for two blank
    // rows of breathing room (capBlankLines collapses to ≤2 in actual
    // scrollback), trailing `\n` to terminate the prompt line.
    compositor.writeStream(`\n\n\n${item.commitLines.join("\n")}\n`)
  }
  let cancelled = false
  /** When non-null, the goodbye banner uses this reason in the closer copy. */
  let quitReason: "confirmed" | "escape-hatch" | null = null
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
   * Paint the queued-message decoration block between the live-area
   * status row and the editor prompt. Only rendered while a turn is in
   * flight (steady-state idle would visually flash since the main loop
   * drains items immediately).
   *
   * The byte-exact layout (numbering, `┊` / `╰` glyph choice, preview
   * truncation) lives in the pure builder `buildQueueDecorationLines`
   * — see src/queue-decoration.ts and its unit tests for the regression
   * guards.
   */
  const renderDecoration = (): void => {
    if (typeof editor.setDecorationLines !== "function") return
    if (!running) {
      editor.setDecorationLines([])
      return
    }
    editor.setDecorationLines(buildQueueDecorationLines(queue.map((q) => q.text)))
  }

  const onSubmit = (text: string, commitLines: string[] = []): void => {
    if (!text.trim()) return
    queue.push({ text, commitLines })
    renderDecoration()
    wakeWaiter()
    // Fan out to the plugin bus so subscribers (notably the `history`
    // plugin) see every submit. Fire-and-forget — the bus is microtask-
    // deferred, never blocks this onSubmit path. We emit AFTER the
    // queue push so subscribers observe the same queue ordering the
    // agent will process.
    if (loader) {
      loader.bus().emit("prompt.submitted", {
        text,
        cwd: process.cwd(),
        sid: opts.sessionId ?? null,
        exit: "submitted",
        queuePos: queue.length - 1,
      })
    }
  }
  const onCancel = (reason?: string): void => {
    cancelled = true
    if (reason === "confirmed" || reason === "escape-hatch") {
      quitReason = reason
    }
    wakeWaiter()
  }

  editor.on("submit", onSubmit)
  editor.on("cancel", onCancel)

  // Footer band: two producers share the editor's `setFooterLines` —
  // (1) plugin-contributed slots driven by `LiveAreaScheduler` (the
  // quota row), and (2) the `TuiDiagnosticSurface` (the last-warn /
  // last-err summary). They merge through `FooterAggregator` so the
  // editor receives a single combined `[diagnostic..., plugin...]`
  // array on every change. Diagnostic lines come FIRST so a stale
  // warning never gets shoved off-screen by a freshly-painted quota
  // line.
  //
  // The plugin scheduler is gated on (a) at least one slot existing
  // AND (b) the editor supporting `setFooterLines`. The diagnostic
  // surface is unconditional — even a no-plugin run can encounter
  // auth refresh storms or other diag-emitting code paths.
  //
  // Setup runs AFTER `editor.on("submit"/"cancel", ...)` registration
  // so the dynamic imports here cannot orphan a fast-arriving submit
  // event (see the comment above the `slotRows` declaration).
  if (typeof editor.setFooterLines === "function") {
    const { FooterAggregator } = await import("./log-aggregator.ts")
    const { TuiDiagnosticSurface } = await import("./log-tui.ts")
    const { getDiagnosticBus } = await import("./diagnostic-bus.ts")

    const aggregator = new FooterAggregator(
      (lines) => editor.setFooterLines?.(lines),
      // setDecoration is unused by the diagnostic surface (header
      // band stays owned by the queue display); the plugin sink's
      // setDecorationLines passthrough still works for any slot
      // that requests `position: "header"` (the scheduler falls
      // back to footer with a one-time notice; future cuts can
      // route real header slots here).
      (lines) => editor.setDecorationLines?.(lines),
    )

    tuiDiagnosticSurface = new TuiDiagnosticSurface()
    tuiDiagnosticSurface.bindSink(aggregator.diagnosticSink())
    tuiDiagnosticSurface.attach(getDiagnosticBus())

    if (slotRows.length > 0) {
      const { LiveAreaScheduler } = await import("./live-area-providers.ts")
      liveAreaScheduler = new LiveAreaScheduler(
        slotRows as ResolvedLiveAreaSlot[],
        aggregator.pluginSink(),
        {
          // Loader's event bus drives `refreshOn` slot events
          // (e.g. `quota.headersReceived` from `client.ts`).
          bus: loader?.bus(),
          // Singleton diagnostic bus picks up the scheduler's own
          // timeout / failure / recovery events. Tests inject an
          // isolated bus; production defaults to the singleton.
          // (Left implicit so the default kicks in.)
        },
      )
      liveAreaScheduler.start()
    }
  }

  try {
    while (!cancelled) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve
        })
        continue
      }
      const item = queue.shift()
      if (item === undefined) continue
      const text = item.text
      // Flush the deferred scrollback commit NOW (the editor stopped
      // writing at submit time : Bug 393). For queued items this is
      // when they first appear in scrollback; for direct submits it's
      // microseconds after Enter, indistinguishable from the old behavior.
      // Decoration must be re-rendered AFTER the shift so the queue widget
      // shrinks by one row in lockstep with the scrollback commit.
      flushQueueItemToScrollback(item)
      renderDecoration()

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
        // First write of the turn: insert a blank row of breathing room
        // above the response text. Mirrors the legacy `runRepl` baseSink
        // (`!wroteOutput` clause). Without this the response butts directly
        // under the just-committed `❯ <prompt>` row in scrollback. The
        // separator is unnecessary when the first content is a transcript
        // line (the agent prepends `\n` to tool headers); only text needs
        // the explicit kick.
        if (!wroteOutput) compositor.writeStream("\n")
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
        // See `writeDirectSink` for the rationale on the !wroteOutput kick.
        if (!wroteOutput) compositor.writeStream("\n")
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
        //
        // Block-close glyph `╰` is followed by an extra `\n` so the live
        // area below (status row, next tool block, or text) gets one
        // blank row of breathing room above it. capBlankLines in the
        // compositor caps the run at 2 ` \n`s = 1 visible blank, so
        // adjacent `╰`-then-`╭` doesn't pile up to two blank rows. This
        // closes the "missing blank between `╰ shown 10/20 L` and
        // `● Thinking`" visual bug (May 2026).
        const isBlockClose = isOuterFrameClose(line)
        compositor.writeStream(isBlockClose ? `${line}\n\n` : `${line}\n`)
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
        const drained = queue.splice(0)
        // Flush each drained item's pre-rendered scrollback lines IN ORDER
        // before injecting their combined text into the agent. The user
        // sees their queued prompts materialize in scrollback at the moment
        // they're handed to the agent (mid-turn drain at a tool boundary) :
        // mirrors what a sequence of solo turns would look like.
        for (const item of drained) flushQueueItemToScrollback(item)
        renderDecoration()
        return drained.map((i) => i.text).join("\n\n")
      }
      // onQueueInject: NO-OP. Scrollback writes for drained items happen
      // inside drainQueuedUserText (above). The hook is retained as a
      // notification point in case future code wants to react to the
      // injection, but it must not write to scrollback : that would
      // double-commit the prompts (Bug 393, second-order regression).
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
      //
      // Also tell the abort-quit FSM the turn has started — this transitions
      // it from idle/armed → working, and dismisses any armed footer that
      // may still be visible from a prior idle-confirm window.
      editor.notifyTurnStart?.()
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
        // Discard the OLD formatter's trailing tail. The next text block
        // (if any) starts with a freshly-spawned formatter; any pending
        // `\n\n` from the OLD render belongs to the boundary between this
        // text block and whatever follows (tool, end-of-turn). We handle
        // those boundaries explicitly: `onTranscriptLine` adds its own
        // `\n` when crossing text→transcript, the `!wroteOutput` kick
        // in `baseSink` adds the leading `\n` for transcript→text, and
        // `EditorController.submit` provides the `\n\n\n` lead for
        // turn-end → next-prompt. Holding the OLD pending here just
        // double-counts the boundary and overshoots blanks.
        pendingTrailingNewlines = ""
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
        // Tell the abort-quit FSM the turn settled. In the natural case
        // this transitions working → idle. If a Ctrl+C abort already
        // pushed us into armed:post-abort, the FSM stays armed (its
        // turn-end transition while armed is a no-op).
        editor.notifyTurnEnd?.()
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
        // When the throw already routed through `diag.error(...)` the
        // ScrollbackDiagnosticSink has already painted a rich
        // gutter-bracketed block ABOVE this point in scrollback. A
        // second bare `error <msg>` line here would just duplicate
        // the same string in plain red. Skip it; the rich block is
        // the user's signal that this turn failed.
        if (!isErrorDiagEmitted(turnError)) {
          compositor.writeStream(`\n  ${c.boldRed("error")} ${msg}\n`)
        }
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
    tuiDiagnosticSurface?.detach()
    statusRenderer?.stop()
    editor.stop()
    compositor.unmount()
    // Goodbye banner — print AFTER teardown so the terminal is in normal
    // mode and the framed block lands in scrollback. Only printed when a
    // user-confirmed quit fired (Ctrl+C×2 / escape-hatch); a clean
    // program-end (no quit) leaves no banner so the user can see whatever
    // last output the agent produced.
    if (quitReason !== null) {
      printGoodbye({
        sessionId: opts.sessionId ?? null,
        reason: quitReason,
      })
    }
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

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

// Reflection-checkpoint utilities and the rolling-cache breakpoint helper
// live in `src/agent/` submodules to keep this file under the `max-lines`
// lint budget. UI style helpers live under `src/ui` and are re-exported
// below so external consumers can still
// `import { c, runReflectionCooldown, ... } from "./agent.ts"`.
import { withRollingCacheBreakpoint } from "./agent/cache.ts"
import {
  repairOrphanedToolUse as repairOrphanedToolUseImpl,
  rollbackPendingTurn as rollbackPendingTurnImpl,
} from "./agent/history-repair.ts"
import { type AskUserFn, runPreflightPipeline } from "./agent/preflight-pipeline.ts"
import {
  buildReflectionCheckpointBlock,
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
  parseReflectionAck,
  runReflectionCooldown,
} from "./agent/reflection.ts"
import { executeToolRound } from "./agent/tool-round.ts"
import type { AuthResult } from "./auth.ts"
import { type BlobStore, loadBlobStoreConfig } from "./blob-store.ts"
import {
  type ContentBlock,
  type Message,
  normalizeModelForAPI,
  type SendOptions,
  type StreamedResponse,
  sendMessage,
  type ToolResultBlock,
  type ToolUseBlock,
} from "./client.ts"
import type { SystemBlock } from "./headers.ts"
import { inputCaptureStack } from "./input-capture-stack.ts"
import {
  clampMaxOutputTokens,
  type EstimableTool,
  estimateRequestInputTokens,
} from "./llm/context-budget.ts"
import { findModel, findModelForProvider, getDefaultModelId } from "./llm/model-registry.ts"
import { resolveSystemPromptForModel } from "./llm/system-prompt.ts"
import { selectedTransport } from "./llm/transport/select-transport.ts"
import { resolveUserTurnContent } from "./media/ingest.ts"
import { ModeManager } from "./modes.ts"
import type { NetworkClient } from "./network/index.ts"
import { PluginLoader } from "./plugins/loader.ts"
import type { ManifestMode } from "./plugins/types.ts"
import { createReflectionAckStripper } from "./reflection-ack-stripper.ts"
import { appendUserTurn } from "./session-restore.ts"
import type { SessionStore } from "./session-store.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"
import type { ToolTimeTracker } from "./tool-time.ts"
import { ToolFeedbackTracker } from "./tools/feedback-tracker.ts"
import { TOOL_DEFINITIONS, type ToolDefinition } from "./tools.ts"
import { c, faintThinkingChunk, formatAbortedEcho } from "./ui/style/ansi.ts"

export {
  c,
  faintThinkingChunk,
  formatAbortedEcho,
  parseReflectionAck,
  runReflectionCooldown,
  withRollingCacheBreakpoint,
}

type MaybePromise<T> = T | Promise<T>

// ---------------------------------------------------------------------------
// Agent class
// ---------------------------------------------------------------------------

/**
 * Maximum number of CONSECUTIVE `max_tokens` auto-continuations within a
 * single `run()`. When a response hits the output-token ceiling, the loop
 * transparently asks the model to continue (see the max_tokens branch in
 * the agentic loop) instead of dumping a half-finished turn back on the
 * user. This cap stops a pathological turn (one that hits the ceiling every
 * single time) from auto-continuing forever and burning quota: after this
 * many back-to-back truncations the loop stops and hands control back with
 * a visible note. A salvaged tool_use that executes resets the streak (real
 * progress was made), so this only trips on genuinely stuck "thinking until
 * the wall, every time" turns. Five is generous: a legitimate long
 * deliverable rarely needs more than one or two continuations.
 */
const MAX_TOKENS_CONTINUATION_CAP = 5

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
 * const agent = new Agent({ auth, model: "test-model-1" });
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
  /**
   * Provider selected at boot (e.g. `--provider wafer`). When set,
   * dispatch resolves model entries scoped to this provider, so two
   * providers that register the same bare model ID are disambiguated.
   * `undefined` for legacy code paths (Anthropic-only transport).
   */
  private providerId?: string
  /** Effort level for output_config.effort. Pass-through string; server validates. */
  private effort: string | undefined
  /**
   * Speed-mode dispatch tier. `"fast"` adds `speed:"fast"` to the
   * request body (Anthropic fast-mode-2026-02-01). `"normal"` omits
   * the field entirely. Capability-gating happens at the registry
   * level — this is just the per-Agent default.
   */
  private speed: "normal" | "fast"
  /**
   * Optional `thinking.display` override, threaded onto every API call.
   * `"summarized"` opts opus-4.7 / mythos into plaintext thinking_delta
   * streaming; `"omitted"` forces redaction on models that would otherwise
   * stream summaries. Unset → server default per model.
   */
  private thinkingDisplay: "summarized" | "omitted" | undefined
  /** Optional Plugin loader. When set, plugin tools merge with core tools. */
  private loader: PluginLoader | null
  /** Optional mode manager (mode-aware system prompt + tool filter). */
  private modeManager: ModeManager | null
  /**
   * Optional save-echo collector. When set, every `<ma::agent::memory-saved …>`
   * event the inline-tag handler (or the `MemoryTool` add action)
   * emits on the global bus is buffered here, and drained as
   * ContentBlock(s) prepended to the next user message. The model
   * thereby learns the id of every memory it just saved on its very
   * next turn, with no extra tool round-trip.
   *
   * Off by default; the agent is fully functional without it.
   * See `plugins/memory/lib/save-echo.ts`.
   */
  private saveEcho: { consumeAll(): ContentBlock[] } | null
  /**
   * Optional short-term snapshot producer. When set, the per-session
   * `<ma::agent::short-term-memory>…</ma::agent::short-term-memory>` attachment is prepended
   * to the FIRST user message of each `run()` call.
   *
   * Only emitted at the initial seam (not at the loop seam after
   * tool_use rounds), to avoid re-emitting stale snapshots within the
   * same turn : see `plugins/memory/lib/short-term-snapshot.ts`.
   */
  private shortTermSnapshot: { toAttachment(): ContentBlock | null } | null
  /**
   * Optional tasks-list attachment producer. When set, the per-session
   * `<ma::agent::tasks …>…</ma::agent::tasks>` attachment is prepended to
   * the FIRST user message of each `run()` call. Mirrors
   * {@link Agent.shortTermSnapshot} exactly : same structural-type
   * pattern, same initial-seam-only emission rule, same null-on-empty
   * behavior (zero token cost when the session has no tasks).
   *
   * See `plugins/tasks/lib/attachment.ts`.
   */
  private tasksAttachment: { toAttachment(): ContentBlock | null } | null
  /**
   * Generic per-turn attachment producers, prepended to the FIRST user
   * message of each `run()` call AFTER {@link Agent.tasksAttachment}, in
   * array order. Same structural-type contract as the two named producers
   * above; this is the open extension point so a plugin (e.g. `sub-agents`
   * with its `<ma::agent::subagents>` fleet digest) can surface live per-turn
   * state without the agent core knowing the producer's identity. Each is
   * null-on-empty (zero token cost when there is nothing to show).
   */
  private turnAttachments: Array<{ toAttachment(): ContentBlock | null }>
  /**
   * Injectable transport. Defaults to the real {@link sendMessage} function.
   * Primary purpose is a testing seam so suites can drive tool_use flows
   * without making live API calls.
   */
  private sendFn: typeof sendMessage
  /** Optional network client forwarded into every `sendFn` call. */
  private networkClient: NetworkClient | undefined
  /**
   * Optional append-only session store. When set, the agent persists every
   * turn boundary (user submit, assistant turn complete, each tool result)
   * so the conversation can be resumed via `--resume <sid>`.
   * See `src/session-store.ts` for the FORMAT v1 record shape.
   */
  private store: SessionStore | null
  /**
   * Optional per-session blob store for raw tool outputs. When set, large
   * or truncated tool bodies are persisted verbatim at
   * `~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw` and a
   * single-line `<ma::agent::raw-output …/>` footer pointing at the file is appended
   * to the model-visible `content`. Best-effort like `store`: a null
   * blobStore means tool results still flow, just without the pointer.
   * See `src/blob-store.ts`.
   */
  private blobStore: BlobStore | null
  /** Tools whose output is excluded from blob persistence (small/structured replies). */
  private blobSkipTools: ReadonlySet<string>
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
   * tools disabled and a `<ma::agent::emergency-cap-triggered round="N" />`
   * attachment so the model can write a clean wrap-up summary.
   *
   * The actual safety device against runaway loops is the reflection
   * checkpoint mechanism : see {@link reflectionInterval} below.
   */
  private maxToolRounds: number = Number.POSITIVE_INFINITY
  /**
   * Reflection checkpoint cadence (in tool rounds). Every Nth round a
   * `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="..." />`
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
   * `<ma::agent::reflection-ack silence-for="K" reason="..." />` in its
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
   * When true, the next `run()` call will prepend a model-visible
   * `<ma::agent::turn-aborted />` text block to the user message so the
   * model knows its prior plan was interrupted (not failed).
   *
   * Set by {@link notePreviousTurnAborted}. Consumed (and cleared) exactly
   * once at the start of the next `run()`.
   */
  private previousTurnAborted = false

  /**
   * Create an agent with auth, model, plugin, mode, and transport settings.
   *
   * Key `opts` fields:
   *   - `auth` - Authenticated credentials from {@link getAuth}
   *   - `model` - Model ID (default: the model registry's declared default;
   *     see `getDefaultModelId` in src/llm/model-registry.ts)
   *   - `loader` - Optional Plugin loader. When provided, its tools
   *   merge with the core tools and its PROMPT.md fragments are appended to
   *   the system prompt's session-context block.
   *   - `sendFn` - Injectable Messages API function (defaults to the
   *   real client). Testing seam.
   */
  constructor(opts: {
    auth: AuthResult
    model?: string
    /**
     * The provider selected at boot time (e.g. `--provider opencode`).
     * Stored alongside the model so dispatch can disambiguate when two
     * providers register the same bare model ID. Optional for backwards
     * compatibility with code paths that only use the legacy Anthropic
     * transport (no provider registry concept).
     */
    providerId?: string
    effort?: string
    /**
     * Speed mode for the response dispatch tier. `"fast"` opts the
     * model into the `fast-mode-2026-02-01` beta and emits
     * `speed: "fast"` on the wire — ~2.5x output tok/s at premium
     * pricing (Opus 4.8: $10/$50 per MTok instead of $5/$25).
     *
     * Capability-gated: ignored on models whose registry entry doesn't
     * declare `speedFast: true`. Default: `"normal"` (omits the field
     * entirely; server treats as normal).
     */
    speed?: "normal" | "fast"
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
    /**
     * Generic per-turn attachment producers (see {@link Agent.turnAttachments}).
     * Open extension point for plugins beyond the two named producers.
     */
    turnAttachments?: Array<{ toAttachment(): ContentBlock | null }>
    sendFn?: typeof sendMessage
    /**
     * Network client forwarded to the transport (`sendFn`). Lets the host
     * inject a configured/mocked client; defaults inside each transport to
     * the package's `defaultNetworkClient`. Threaded so the canonical
     * transport is offline-testable through the agent.
     */
    networkClient?: NetworkClient
    store?: SessionStore | null
    /**
     * Optional per-session blob store. When supplied, raw pre-clamp
     * tool outputs are persisted to `<sessionsDir>/<sid>.blobs/` and
     * the model receives a `<ma::agent::raw-output …/>` pointer footer. When
     * omitted (or null), the agent runs the legacy path: clamped
     * content goes to API + JSONL with no separate raw copy.
     * See `src/blob-store.ts`.
     */
    blobStore?: BlobStore | null
    /**
     * Pre-existing conversation to seed the agent with (used by
     * `--resume <sid>` to rehydrate from a saved log). Pushed onto
     * `this.messages` verbatim. The store, if any, is NOT re-written
     * here — resume forks the parent on disk via `SessionStore.fork()`
     * before constructing the Agent, so the store already contains the
     * copied history. New turns append to the fork file, not the parent.
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
    // No explicit model ⇒ ask the registry for its default. A provider plugin
    // (or config) declares that default at registration time; core names no
    // SKU here. See `getDefaultModelId` (src/llm/model-registry.ts).
    this.model = opts.model ?? getDefaultModelId()
    this.providerId = opts.providerId
    this.effort = opts.effort
    this.speed = opts.speed ?? "normal"
    this.thinkingDisplay = opts.thinkingDisplay
    this.loader = opts.loader ?? null
    this.modeManager = opts.modeManager ?? null
    this.saveEcho = opts.saveEcho ?? null
    this.shortTermSnapshot = opts.shortTermSnapshot ?? null
    this.tasksAttachment = opts.tasksAttachment ?? null
    this.turnAttachments = opts.turnAttachments ?? []
    // Default transport dispatches per-model: Anthropic → legacy sendMessage,
    // others → canonical run() (so --model gpt-* actually reaches its vendor).
    // Callers/tests can still inject any sendFn. See select-transport.ts.
    this.sendFn = opts.sendFn ?? selectedTransport
    this.networkClient = opts.networkClient
    this.store = opts.store ?? null
    this.blobStore = opts.blobStore ?? null
    // Resolve the skipTools list once at construction. Reads
    // `~/.minimal-agent/config.jsonc :: plugins["blob-store"].skipTools`
    // when set, otherwise falls back to the built-in default list (Task,
    // MemoryTool, ShowDiff, LockStatus). Cheap to compute, the loader
    // itself caches.
    this.blobSkipTools = loadBlobStoreConfig().skipTools
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
   * Resolve the output-token ceiling to request for the current model.
   *
   * The transports default `max_tokens` to 64000 (a conservative floor from
   * when 64k WAS the ceiling). But modern models go higher: opus-4-8 supports
   * 128000. Capping every request at 64k means a long turn hits the wall at
   * HALF the model's real budget, and a turn whose hidden adaptive reasoning
   * is large can exhaust 64k before finishing a single tool call (the
   * 2026-05-31 incident). We resolve the model's registered `maxOutputTokens`
   * and request that, so the model gets its full budget. Falls back to
   * `undefined` (let the transport apply its own default) for an unregistered
   * model id, so a bad/aliased id never throws here.
   *
   * Some providers validate that input plus requested output fits one
   * shared context window and reject over-budget requests with
   * `context_length_exceeded`, so on a near-full transcript we must
   * reserve less output than the model's raw ceiling. Others treat the
   * output budget as separate from the input window, so their behavior is
   * unchanged. The distinction is provider data, exposed as
   * `outputTokensShareContextWindow`, not a core provider-name branch.
   * When `system`/`tools` are omitted (legacy callers) the input estimate
   * covers messages only.
   *
   * `ctx` can include optional system blocks + tool schemas to fold into
   * the input-size estimate. Omit for a messages-only estimate.
   */
  private resolveMaxOutputTokens(ctx?: {
    system?: SystemBlock[]
    tools?: EstimableTool[]
  }): number | undefined {
    const apiModel = normalizeModelForAPI(this.model)
    const entry = this.providerId
      ? (findModelForProvider(apiModel, this.providerId) ?? findModel(apiModel))
      : findModel(apiModel)
    if (!entry) return undefined
    const modelMax = entry.capabilities.maxOutputTokens

    const contextWindow = entry.capabilities.contextWindow
    if (!entry.capabilities.outputTokensShareContextWindow) return modelMax

    const inputTokens = estimateRequestInputTokens({
      modelId: apiModel,
      estimateTokens: entry.estimateTokens,
      messages: this.messages,
      ...(ctx?.system ? { system: ctx.system } : {}),
      ...(ctx?.tools ? { tools: ctx.tools } : {}),
    })
    return clampMaxOutputTokens({ modelMax, contextWindow, inputTokens })
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
  /**
   * Append a `role:"system"` mid-conversation operator message to the
   * conversation history.
   *
   * This is the `mid-conversation-system-2026-04-07` beta channel —
   * the prompt-injection-safe way to nudge the model mid-turn without
   * editing the top-level `system` prefix (which would invalidate the
   * prompt cache).
   *
   * claude-code uses three concrete patterns:
   *
   * ```text
   * 1. User interrupt:    "The user sent a new message while you were
   *    working:\n<text>\n\nIMPORTANT: After completing your current
   *    task, you MUST address the user's message above."
   * 2. Tool availability: "The following deferred tools are now
   *    available via ToolSearch. ..."
   * 3. Task-list nudge:   "The task tools haven't been used recently. ..."
   * ```
   *
   * The system message lands as `{role:"system", content:"<text>"}`
   * inside `messages[]`. Capability-gated by the model registry — if
   * the resolved model declares `midConversationSystem: false`, the
   * server would 400. (Today's haiku-4.5 and sonnet-4.5 don't support
   * it; opus-4.6/4.7/4.8 and sonnet-4.6 do.)
   *
   * @param text - Body of the system message.
   */
  pushSystemMessage(text: string): void {
    this.messages.push({ role: "system", content: text })
  }

  rollbackPendingTurn(): boolean {
    return rollbackPendingTurnImpl(this.messages)
  }

  /**
   * Host calls this after a USER-initiated abort (Esc/Ctrl+C), NOT after a
   * programmatic mode-interrupt. The next run() emits a model-visible marker
   * so the model knows its prior plan was interrupted (not failed).
   */
  notePreviousTurnAborted(): void {
    this.previousTurnAborted = true
  }

  /**
   * Scan the trailing assistant message for `tool_use` blocks that lack
   * matching `tool_result` blocks in the immediately-following user
   * message. For each orphan, build an `is_error: true` `tool_result`
   * block whose content says the tool was aborted before completion.
   *
   * Returns the synthetic blocks. The caller (currently {@link run}'s
   * initial-user-content build) is responsible for prepending them to
   * the next user message so the `tool_use → tool_result` pairing is
   * restored. Synthesized blocks are also persisted via
   * `appendToolResult` so the session JSONL stays consistent (resumes
   * cleanly without depending on `session-restore.ts`'s repair pass).
   *
   * Why this exists: when the user aborts a turn (Esc, Ctrl+C, Alt+M)
   * between the moment the assistant streams its `tool_use` block and
   * the moment the for-loop builds the matching tool_result user
   * message, the orphan `tool_use` sits in `this.messages`. The
   * Anthropic API then 400s on the next send with "tool_use ids were
   * found without tool_result blocks immediately after". Repro:
   * session `403c71fe-7cc4-…` (2026-05-27, fixed by this method
   * alongside the ASAP-mode-change rework in the same commit).
   *
   * Pure side-effect-free in shape: does NOT push to `this.messages`
   * (the caller controls placement so blocks land FIRST in the new
   * user message). Only side effect: per-orphan
   * `store?.appendToolResult` calls so the JSONL records the pairing
   * the same instant the in-memory repair happens.
   *
   * Returns `[]` when:
   *   - history is empty,
   *   - trailing message is not assistant,
   *   - trailing assistant has no `tool_use` blocks,
   *   - all `tool_use` blocks already have matching tool_results in
   *     the next user message (clean state).
   */
  repairOrphanedToolUse(): ToolResultBlock[] {
    return repairOrphanedToolUseImpl(this.messages, this.store)
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
      /**
       * Optional. Host-provided callback the agent invokes when the
       * provider's preflight surfaces an issue that needs user
       * resolution. The callback opens a modal in the live area,
       * gathers the choice, and resolves with the chosen option id
       * (`null` to cancel).
       *
       * When omitted, preflight is skipped entirely : the request is
       * sent as-is and any provider-side validation error surfaces as
       * a normal API failure. Hosts wired into the TUI (`runRepl` +
       * `runReplLiveArea`) supply this; scripts that want
       * "fail-loud-on-mismatch" leave it undefined.
       */
      askUser?: AskUserFn
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
      askUser,
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
    //   1. <mode-change from="…" to="…" at="…" />     : pending mode toggle.
    //   2. <ma::agent::short-term-memory>…</ma::agent::short-term-memory>    : session scratchpad.
    //   3. <ma::agent::tasks …>…</ma::agent::tasks>        : active task list.
    //   4. <ma::agent::memory-saved scope="…" id="…">…</…>+      : id echo for any
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
    // Orphan tool_use repair. If the previous turn aborted mid-tool
    // (Esc / Ctrl+C / Alt+M after the assistant streamed `tool_use`
    // but before the for-loop built the matching `tool_result` user
    // message), the trailing assistant in `this.messages` carries
    // orphan tool_use blocks. Anthropic's API rejects that shape with
    // "tool_use ids were found without tool_result blocks immediately
    // after" on the next send. Prepend synthetic `is_error: true`
    // tool_result blocks so the pairing is restored. MUST come FIRST
    // in this user message : the API enforces "tool_result IMMEDIATELY
    // after tool_use" ordering. See {@link repairOrphanedToolUse}.
    const orphanRepair = this.repairOrphanedToolUse()
    for (const b of orphanRepair) initialUserContent.push(b)
    // Abort marker: must come AFTER orphan-repair tool_results (the API
    // requires tool_result blocks to appear immediately after their tool_use).
    if (this.previousTurnAborted) {
      this.previousTurnAborted = false
      initialUserContent.push({
        type: "text",
        text: "<ma::agent::turn-aborted />\nThe previous turn was interrupted by the user before it finished. Everything already completed above is preserved (this is not an error). Treat the earlier plan as paused: address the new instruction below, and do not silently resume the prior plan unless the user asks you to continue it.",
      })
    }
    const initialModeAttach = this.modeManager?.consumePendingAttachment() ?? null
    if (initialModeAttach) initialUserContent.push(initialModeAttach)
    const stmAttach = this.shortTermSnapshot?.toAttachment() ?? null
    if (stmAttach) initialUserContent.push(stmAttach)
    const tasksAttach = this.tasksAttachment?.toAttachment() ?? null
    if (tasksAttach) initialUserContent.push(tasksAttach)
    // Generic per-turn producers (e.g. the sub-agents fleet digest). Same
    // initial-seam-only rule + null-on-empty contract as the two named ones.
    for (const producer of this.turnAttachments) {
      const block = producer.toAttachment()
      if (block) initialUserContent.push(block)
    }
    for (const e of this.saveEcho?.consumeAll() ?? []) initialUserContent.push(e)
    // Empty userText is meaningful : it's how the Alt+M
    // interrupt-and-apply-mode path (and other "send just the
    // attachments" callers) signal "this turn carries no prose, just
    // the runtime attachments above". Skip the text block in that
    // case so the API doesn't see an empty `{type:"text", text:""}`
    // (some providers accept it, but it reads as noise to the model).
    // At least ONE content block is always pushed by the attachment
    // emitters above when this is reached, so we never end up with
    // an empty `content` array.
    if (userText.length > 0) {
      // Resolve referenced media (dropped/clipboard tokens or typed image
      // paths) into image blocks; plain text returns one text block, so
      // non-media turns are byte-identical to before.
      initialUserContent.push(...(await resolveUserTurnContent(userText, { modelId: this.model })))
    }
    // Append the user turn. `appendUserTurn` merges into a trailing `user`
    // message instead of creating a `[user, user]` pair the API rejects :
    // this happens on resume when a force-quit stranded tool_results without
    // their assistant continuation and the un-replied prompt was pulled into
    // the editor as a pending draft (see `extractPendingDraft`), leaving
    // `user([tool_results])` as the tail. Normal turns (last message is an
    // assistant) just append a fresh message.
    appendUserTurn(this.messages, initialUserContent)
    // Persist to JSONL. Orphan-repair tool_result blocks were ALREADY
    // written via per-block `appendToolResult` inside
    // `repairOrphanedToolUse` (matching the in-loop convention where
    // tool_results are persisted as dedicated `tool_result` records,
    // not embedded inside a `user` record). Filter them out of the
    // `appendUser` payload to avoid double-persistence : without this,
    // `foldRecords` on resume would replay each synthetic
    // tool_result twice (once from the dedicated record, once from
    // the user-record blocks) and produce a corrupted message
    // history.
    const userRecordContent =
      orphanRepair.length > 0
        ? initialUserContent.filter((b) => b.type !== "tool_result")
        : initialUserContent
    if (userRecordContent.length > 0) {
      this.store?.appendUser(userRecordContent)
    }

    let rounds = 0
    // Consecutive `max_tokens` truncations in this run, capped by
    // MAX_TOKENS_CONTINUATION_CAP. Incremented when a response hits the
    // output ceiling and we auto-continue; reset to 0 whenever a turn makes
    // real progress (executed a tool / finished cleanly), so it only counts
    // BACK-TO-BACK truncations. Guards against a turn that hits the wall
    // every time auto-continuing forever.
    let maxTokensStreak = 0
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
    // Provider-resolved system prompt: the agent builds the neutral skeleton
    // (instructions + session context) and the request's provider injects its
    // preamble (Anthropic plan-auth → billing + Claude-Code identity; everyone
    // else → neutral "You are Minimal Agent …" identity). Routed through the
    // model registry seam, so the agent names no provider. `index.ts` computes
    // the resume-drift systemHash through the SAME resolver with the same args,
    // keeping the cached prefix byte-consistent.
    const system = resolveSystemPromptForModel(normalizeModelForAPI(this.model), {
      sessionContext: pluginBlock ?? undefined,
      reflectionInterval: this.reflectionInterval,
      reflectionCooldownMs: this.reflectionCooldownMs,
      maxToolRounds: this.maxToolRounds,
      // When the agent was constructed with a non-null `blobStore`, the
      // tool-output-conventions paragraph appears in the instructions block;
      // null disables it (matches the pre-blob-store prompt shape exactly).
      blobStoreEnabled: this.blobStore !== null,
      authKind: this.auth.type,
    })
    const allTools: ToolDefinition[] = this.loader
      ? [...TOOL_DEFINITIONS, ...(this.loader.getExtraTools() as ToolDefinition[])]
      : [...TOOL_DEFINITIONS]
    // Build a presentation map (icon + color) keyed by tool name for transcript
    // rendering, then strip those cosmetic fields before sending to the API.
    const toolPresentation = new Map<
      string,
      { icon?: string; color?: string; headerKey?: string }
    >()
    for (const t of allTools) {
      if (t.icon || t.color || t.headerKey)
        toolPresentation.set(t.name, { icon: t.icon, color: t.color, headerKey: t.headerKey })
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

      // Preflight. The provider may surface issues that need user
      // resolution before we hit the network (e.g. Anthropic's
      // model-signed thinking blocks from a different model). The
      // pipeline is a no-op when no `askUser` callback is supplied or
      // when the provider has no `preflight()` method. On the resolved
      // path, this.messages and/or this.model may be updated in place.
      //
      // Why every iteration (not just the first): once the user picks
      // a resolution, subsequent iterations see clean messages and the
      // preflight returns []. The detection cost is microseconds per
      // turn, so the cache the user mentioned isn't needed here :
      // correctness IS the cache. If detection ever gets expensive we
      // can add a fingerprint short-circuit.
      if (askUser) {
        const preflightResult = await runPreflightPipeline({
          messages: this.messages,
          modelId: this.model,
          askUser,
        })
        if (preflightResult.cancelled) {
          throw Object.assign(new Error("aborted"), { name: "AbortError" })
        }
        if (preflightResult.adoptModelId) {
          this.model = preflightResult.adoptModelId
        }
        if (preflightResult.messages !== this.messages) {
          // The pipeline returned new messages. Splice in-place so any
          // other holders of `this.messages` (tests, debugger) see the
          // same array identity but updated contents.
          this.messages.length = 0
          for (const m of preflightResult.messages) this.messages.push(m)
        }
      }

      // Send messages to API. Mark the last block of the last message with a
      // rolling cache_control breakpoint so the growing transcript stays cached
      // across turns (see withRollingCacheBreakpoint). The output budget is
      // clamped to the room left in the context window using the SAME system
      // prompt + tool schemas we are about to send, so the estimate matches
      // the real payload (see resolveMaxOutputTokens / context-budget.ts).
      const maxOutputTokens = this.resolveMaxOutputTokens({ system, tools: mergedTools })
      const gen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        selectedProviderId: this.providerId,
        ...(this.networkClient ? { networkClient: this.networkClient } : {}),
        tools: mergedTools,
        system,
        // Request the model's FULL output budget (e.g. 128k for opus-4-8)
        // rather than the transport's conservative 64k default. Placed before
        // `...sendOpts` so an explicit caller override still wins.
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
        ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
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
      // Strip `<ma::agent::reflection-ack ... />` from the streamed text channel
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
          // Persist the turn's billed usage (input/output/cache) so the
          // session log carries an exact token footprint. The transport
          // (legacy client + canonical bridge) merges message_start +
          // message_delta into StreamedResponse.usage. See src/session-usage.ts.
          lastResponse.usage,
        )
      }

      // Reflection ack scan. The model can opt out of the next K
      // reflection checkpoints by emitting a `<ma::agent::reflection-ack
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

      // Reflection-ack tool_use fallback. Flash / small models sometimes
      // confuse the inline XML tag for a tool call. The text scan above
      // covers the canonical path; this branch catches the tool_use
      // mistake and applies the silence from the tool input. The tool
      // executor returns a corrective hint in the tool_result content;
      // the silence counter set here is the same one the cooldown gate
      // reads a few lines down, so the model gets the silence it asked
      // for even though it used the wrong channel.
      if (this.reflectionSilenceRemaining === 0 && this.reflectionInterval > 0) {
        const ackTool = toolBlocks.find((b) => b.name === "reflection-ack")
        if (ackTool) {
          const silenceForRaw = ackTool.input["silence-for"]
          const reason = typeof ackTool.input.reason === "string" ? ackTool.input.reason : ""
          const silenceFor =
            typeof silenceForRaw === "string"
              ? Number.parseInt(silenceForRaw, 10)
              : typeof silenceForRaw === "number"
                ? Math.floor(silenceForRaw)
                : 1 // default to 1 when absent, matching text-scan parseReflectionAck
          if (Number.isFinite(silenceFor) && silenceFor > 0) {
            this.reflectionSilenceRemaining = silenceFor
            const reasonSuffix = reason.length > 0 ? ` — ${reason}` : ""
            writeTranscript(
              `  ${c.dim("›")} ${c.dim(`reflection ack: silencing next ${silenceFor} checkpoint${silenceFor === 1 ? "" : "s"}${reasonSuffix} (from tool_use fallback)`)}`,
            )
          }
        }
      }

      // max_tokens handling (Fix B + D). The response hit the output-token
      // ceiling. Two shapes:
      //
      //   1. A tool_use was salvaged (its args finished streaming before the
      //      wall : see the stream-end salvage in client.ts / adapter-legacy
      //      .ts). The normal tool-execution path below runs it and the loop
      //      continues with the tool_result, so the turn recovers on its own.
      //      We just surface a visible note and reset the streak : executing
      //      a tool is real progress, not a stuck loop.
      //
      //   2. Nothing actionable was produced (truncated mid text / thinking).
      //      Before this branch the loop fell through to the
      //      `toolBlocks.length === 0` exit and treated a budget-capped turn
      //      as a clean finish : the turn died silently and the user had to
      //      re-prompt ("go"). Now we transparently ask the model to continue
      //      from where it stopped, bounded by MAX_TOKENS_CONTINUATION_CAP so
      //      a turn that hits the wall every time can't auto-continue forever.
      if (lastResponse.stopReason === "max_tokens") {
        if (toolBlocks.length > 0) {
          maxTokensStreak = 0
          writeTranscript(
            `\n  ${c.boldYellow("!")} ${c.yellow("Response hit the max_tokens ceiling mid tool-call — salvaged the in-flight call and continuing")}`,
          )
        } else {
          maxTokensStreak++
          if (maxTokensStreak <= MAX_TOKENS_CONTINUATION_CAP) {
            writeTranscript(
              `\n  ${c.boldYellow("!")} ${c.yellow(`Response hit the max_tokens ceiling — auto-continuing (${maxTokensStreak}/${MAX_TOKENS_CONTINUATION_CAP})`)}`,
            )
            // Keep the assistant→user alternation valid even in the degenerate
            // case where the whole budget went to (now-dropped) unsigned
            // thinking and no block was appended at all.
            if (lastResponse.blocks.length === 0) {
              const placeholder: ContentBlock[] = [
                {
                  type: "text",
                  text: "[response truncated at the output-token limit before any content was produced]",
                },
              ]
              this.messages.push({ role: "assistant", content: placeholder })
              this.store?.appendAssistant(placeholder, lastResponse.stopReason, lastResponse.usage)
            }
            const cont: ContentBlock[] = [
              {
                type: "text",
                text:
                  "<ma::agent::output-truncated />\n" +
                  "Your previous response was cut off at the max_tokens output ceiling. Continue exactly from where you stopped. Do not repeat what you already wrote. If you were about to call a tool, issue that tool call now.",
              },
            ]
            this.messages.push({ role: "user", content: cont })
            this.store?.appendUser(cont)
            continue
          }
          // Streak cap hit: stop auto-continuing and hand back cleanly rather
          // than loop on a turn that truncates every time. Surfaced loudly so
          // the user knows why we stopped and can raise the budget / re-scope.
          writeTranscript(
            `\n  ${c.boldYellow("!")} ${c.yellow(`Response hit the max_tokens ceiling ${MAX_TOKENS_CONTINUATION_CAP} times in a row — stopping. Consider narrowing the request or raising max_tokens.`)}`,
          )
          exitedByCap = false
          break
        }
      } else {
        // Any non-truncated turn means the streak of back-to-back
        // truncations is broken.
        maxTokensStreak = 0
      }

      if (toolBlocks.length === 0) {
        // No tool calls : model would be done. Before exiting, check
        // for a pending mode-change attachment. If the user toggled
        // modes during this turn and the assistant finished with text
        // only, the attachment has no tool_result boundary to ride :
        // we synthesize a user turn carrying ONLY the attachment and
        // `continue` so the next loop iteration sends one more
        // request. Two reasons to do this inside the loop instead of
        // a post-loop one-shot:
        //
        //   1. The model may respond to the mode change with
        //      `tool_use` (e.g. ASK→default + prior prompt was
        //      "save this file" → Bash). The loop's existing
        //      tool-execution machinery handles those tools
        //      naturally. A post-loop one-shot leaves an orphaned
        //      `tool_use` with no `tool_result`, and the NEXT user
        //      submit 400s with "tool_use ids were found without
        //      tool_result blocks immediately after".
        //   2. The cache prefix stays warm: the synthetic user turn
        //      is one block at the rolling-tail breakpoint, byte-
        //      identical to what the next-submit path would build.
        //
        // Skipped when:
        //   - the signal aborted (user pressed Esc; honor that),
        //   - no ModeManager wired (no plugins/modes loaded).
        //
        // `consumePendingAttachment` is idempotent and net-zero-toggle
        // safe: returns null when active === lastAdvertised, so a
        // toggle-then-toggle-back during the same turn writes nothing.
        const pendingMode = this.modeManager?.consumePendingAttachment() ?? null
        if (pendingMode != null && !signal?.aborted) {
          const userContent: ContentBlock[] = [pendingMode]
          this.messages.push({ role: "user", content: userContent })
          this.store?.appendUser(userContent)
          continue
        }
        // No tool calls AND no pending mode change : model is done.
        // Mark this as a natural exit so the post-loop wrap-up turn
        // does NOT fire : the model already wrote its final text,
        // we'd just be duplicating output (and wasting an API call)
        // if we sent another request.
        exitedByCap = false
        break
      }

      // Execute tools and collect results. Each round (mode gate, plugin or
      // built-in execution, transcript rendering, didInvoke chain, blob
      // capture, annotations, persistence) lives in
      // `src/agent/tool-round.ts` :: executeToolRound. The agent threads
      // its collaborators through an explicit context bag so the module
      // stays decoupled from the Agent class.
      const toolResults: ToolResultBlock[] = []
      for (const tool of toolBlocks) {
        toolResults.push(
          await executeToolRound(tool, {
            presentation: toolPresentation,
            writeTranscript,
            loader: this.loader,
            modeManager: this.modeManager,
            blobStore: this.blobStore,
            blobSkipTools: this.blobSkipTools,
            feedbackTracker: this.feedbackTracker,
            toolTimeTracker: this.toolTimeTracker,
            model: this.model,
            store: this.store,
            signal,
          }),
        )
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
      // then inject the model-facing `<ma::agent::reflection-checkpoint>` marker.
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
            // Route Esc through the shared InputCaptureStack so it
            // SKIPS the cooldown without aborting the turn. This is
            // the same singleton EditorController consults in front
            // of its `editor.key` hook chain — see the
            // `input-capture-stack.ts` module docstring for the
            // dispatch pipeline.
            inputCaptureStack,
            ...(signal ? { signal } : {}),
          })
          // Three ways we reach this point: (1) the wall-clock timer
          // elapsed, (2) the user pressed Esc and the cooldown skipped
          // without aborting (no signal flip), (3) the signal aborted
          // (the top-of-loop check on the next iteration throws
          // AbortError). In all three cases the messages history stays
          // well-formed (tool_result-first ordering is preserved), so
          // injecting the checkpoint marker is unconditionally safe.
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
    // `<ma::agent::emergency-cap-triggered>` marker to the last user message
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
            `<ma::agent::emergency-cap-triggered round="${this.maxToolRounds}" />\n` +
            `You have reached the configured emergency tool-round cap for this user turn. Tools are disabled for this final response. Summarize what you accomplished, surface anything the user should know, and stop.`,
        })
        lastMsg.content = content
      }

      const wrapGen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages),
        model: this.model,
        ...(this.networkClient ? { networkClient: this.networkClient } : {}),
        // tools intentionally omitted : the model cannot call tools on
        // this final turn, so it MUST write text and finish.
        system,
        ...((): { maxTokens?: number } => {
          const mt = this.resolveMaxOutputTokens({ system })
          return mt !== undefined ? { maxTokens: mt } : {}
        })(),
        ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
        ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
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
          this.store?.appendAssistant(
            wrapResponse.blocks,
            wrapResponse.stopReason,
            wrapResponse.usage,
          )
        }
      }
    }

    // ASAP mode-change delivery is handled inside the main while loop
    // above (see the `toolBlocks.length === 0` branch). When the
    // assistant ends a turn with text only AND a mode toggle is
    // pending, that branch synthesizes a user turn carrying the
    // `<ma::agent::mode-change>` attachment and `continue`s. This keeps the
    // tool-execution machinery in one place: if the model responds
    // to the new mode by calling a tool (e.g. ASK→default + "save
    // this file" → Bash), the next loop iteration handles tools
    // naturally instead of leaving an orphaned `tool_use`. Bug fix
    // 2026-05-27: the original post-loop one-shot synthesizer DID
    // leave orphans and the next user submit 400'd.

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
    const sendMaxTokens = this.resolveMaxOutputTokens()
    const gen = this.sendFn({
      auth: this.auth,
      messages: withRollingCacheBreakpoint(this.messages),
      model: this.model,
      ...(this.networkClient ? { networkClient: this.networkClient } : {}),
      ...(sendMaxTokens !== undefined ? { maxTokens: sendMaxTokens } : {}),
      ...(this.effort ? { outputConfig: { effort: this.effort } } : {}),
      ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
      ...(this.thinkingDisplay
        ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
        : {}),
      ...opts,
    })

    let response: StreamedResponse | undefined
    // Strip `<ma::agent::reflection-ack ... />` from the streamed text channel.
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
// Tool transcript render helpers (implementation lives under ./ui)
// ---------------------------------------------------------------------------

// Re-exported here so external consumers can keep
// `import { formatToolInput, ... } from "./agent.ts"`.
import {
  clampTranscriptRow,
  formatToolHeaderRows,
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
  isOuterFrameClose,
  toolContinuationIndentCells,
} from "./ui/tool-transcript/format.ts"

export type { ToolPresentation } from "./ui/tool-transcript/format.ts"
export {
  clampTranscriptRow,
  formatToolHeaderRows,
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
  isOuterFrameClose,
  toolContinuationIndentCells,
}

// ---------------------------------------------------------------------------
// REPL (extracted to ./agent/repl.ts + ./agent/repl-live-area.ts + ./agent/model-error.ts)
// ---------------------------------------------------------------------------

export {
  parseModelNotFoundError,
  parseModelUnavailableError,
} from "./agent/model-error.ts"
// The REPL types, the `runRepl` orchestration shell, and the live-area
// renderer live under `src/agent/` so this file stays under the
// `max-lines` lint budget. The public surface
// (`ReplAgentLike`, `StatusController`, `runRepl`,
// `parseModelNotFoundError`, `parseModelUnavailableError`) is
// re-exported below for back-compat with existing consumers.
export type {
  ReplAgentLike,
  ReplCompositor,
  ReplEditor,
  StatusController,
} from "./agent/repl.ts"
export { runRepl } from "./agent/repl.ts"

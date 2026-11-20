/**
 * SDK port interfaces for the minimal-agent core.
 *
 * Every port is a structural interface. The core agent loop depends on these
 * abstractions, never on concrete CLI/TUI/plugin implementations. Host adapters
 * (CLI, SDK, test harness) implement the ports and inject them at construction.
 *
 * Design principles (from software-best-design-patterns):
 *   - Dependency Inversion (DIP): high-level agent depends on ports, not concretions.
 *   - Interface Segregation (ISP): each port is narrow; hosts implement only what they need.
 *   - Functional core, imperative shell: ports are the shell boundary.
 *
 * @module sdk/ports
 */

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { TurnContentProviderDecl } from "../../plugin-api/src/types/turn-content.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { NetworkClient } from "../network/index.ts"
import type { SystemPromptBaseHolder } from "../plugins/system-prompt-base.ts"

import type { EventSink } from "./events.ts"
import type { HostPorts } from "./host-ports.ts"
import type { LifecyclePort } from "./lifecycle.ts"
import type { SwitchTargetCredentialNames } from "./target-credential-names.ts"

export type {
  CompactDidRunPayload,
  CompactWillRunPayload,
  CwdDidChangePayload,
  InstructionsDidLoadPayload,
  LifecyclePort,
  PolicyDecision,
  SendSnapshot,
  SessionLifecyclePayload,
  SessionWillStartPayload,
  SubagentWillSpawnPayload,
  ToolBatchItem,
  ToolDidBatchPayload,
  ToolDidInvokeResult,
  ToolWillInvokePayload,
  TurnEndPayload,
  TurnWillStartPayload,
  TurnWillStopPayload,
} from "./lifecycle.ts"
export {
  allowDecision,
  chainResultToDecision,
  collectAdditionalContext,
  denyDecision,
  isDenied,
  NOOP_LIFECYCLE,
} from "./lifecycle.ts"

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/** One tool definition: name, description, JSON Schema input, and execution. */
export interface ToolDefinition {
  name: string
  /** Optional on the wire (M8): a built-in tool with no provider text omits it. */
  description?: string
  input_schema: Record<string, unknown>
}

/** Result of executing one tool call. */
export interface ToolExecResult {
  content: string | ContentBlock[]
  isError: boolean
  /** Absolute path to raw pre-clamp output blob, if persisted. */
  rawPath?: string
  /** Size in bytes of the persisted blob. */
  rawBytes?: number
  /** sha256 hex digest of the persisted blob (truncated to 16 chars). */
  rawSha256?: string
  /**
   * Sideband mark of the result block (spec v6.1 D1 item 5, D7). Metadata
   * only: the encoders do not send it. Absent when the block has no mark.
   */
  sideband?: { kind: string }
  // No `outcome` field until M3 (SPEC v6.1 D10 item 2): a host executor
  // cannot set the persisted outcome. Core's own executor gives it through
  // an internal channel (`src/sdk/tool-outcome-record.ts`).
}

/**
 * Per-call facts from the core for a tool call. `sid` is the session id
 * from {@link AgentCoreConfig.sessionFacts}, absent when not known.
 */
export interface ToolExecContext {
  sid?: string
  /**
   * The core's one synthetic text resolver (G3), for the result texts of
   * the tool run. Absent: the tool text is "" (bare core).
   */
  text?: SyntheticTextResolverLike
  /**
   * The scheduler gates of this tool call. The core sets them only when the
   * calls of a batch can overlap (a wave). Omitted: the executor runs the
   * call as one piece. See {@link ToolCallGates}.
   */
  gates?: ToolCallGates
  /**
   * True when the scheduler runs this call in a wave of 2 or more calls,
   * so its run can overlap other runs. The per-input check comes later:
   * `gates.admitted` tells if the call stays in the wave. Absent: the call
   * runs alone, as before.
   */
  concurrent?: boolean
}

/**
 * The points where the tool-call scheduler controls one call of a batch
 * with a wave. Admission runs one call at a time in call order. Only the
 * run overlaps. The steps after the run (result chain, `tool.didInvoke`,
 * blob write, the host outcome event) run one call at a time in END order
 * (the first call to end its run goes first). The save and the result
 * events run in call order.
 *
 * An executor that sets {@link ToolExecutor.concurrency} must call the
 * gates to get an overlap. If it does not call them, the scheduler holds
 * the whole call as its admission, so the calls do not overlap.
 */
export interface ToolCallGates {
  /**
   * Optional. Call one time, right before the admission steps that can ask
   * a human (`tool.willInvoke`), and only on the path where the call can
   * run after them. The promise resolves when the call holds a run slot,
   * so a call that passes admission can start at once. A rejection means:
   * do not run the admission and do not run the call, throw the error. An
   * executor that does not call it gets its run slot after admission.
   */
  beforeAdmission?(): Promise<void>
  /**
   * Call after admission, one time. `input` is the final input (a hook may
   * have rewritten it), or `null` when admission refused the call (no run).
   * The promise can wait (for a run slot when `beforeAdmission` was not
   * called, or a serial call waits for the earlier calls). It resolves to true when the call runs in the wave
   * (it passed the per-input check), else false. A rejection means: do not
   * run the call, throw the error.
   */
  admitted(input: Record<string, unknown> | null): Promise<boolean>
  /**
   * Call one time when the run ends (or after `admitted(null)`). The
   * promise resolves when this call holds the post-run section: one call
   * at a time, in end order. A rejection means: the loop failed or the run
   * was aborted while the call waited. Throw the error (the call holds
   * nothing).
   */
  ran(): Promise<void>
  /**
   * Call one time after `ran()`, before the save. It leaves the post-run
   * section and waits until all earlier calls of the batch are delivered
   * and saved. An executor that does not call it leaves the section when
   * it returns. A rejection means: the loop failed, throw the error.
   */
  inCallOrder(): Promise<void>
}

/**
 * The public shape of the core's synthetic text resolver (G3). It is the
 * same shape as the internal `SyntheticTextResolver`
 * (src/agent/synthetic-text.ts), which is not a public module. Public SDK
 * types use this name.
 */
export interface SyntheticTextResolverLike {
  /** Return the provider text for `kind`, or "" when no provider answers. */
  resolve(kind: SyntheticKind, facts: SyntheticFacts): string
}

/**
 * Executes a single tool call and returns the result.
 * A wrapper that copies the result object loses the internal outcome (see withInternalOutcome).
 */
export interface ToolExecutor {
  /**
   * True when this executor writes the raw-output blob of a tool result (an
   * enabled blob store). The core then sends the tool-output-conventions
   * slot of the system prompt. Omitted: false.
   */
  readonly blobStoreEnabled?: boolean
  /**
   * Tells which tool calls are concurrency-safe (see
   * {@link ToolConcurrencyPolicy}). Omitted: every call is a serial call.
   */
  readonly concurrency?: ToolConcurrencyPolicy
  execute(
    toolUse: ToolUseBlock,
    signal?: AbortSignal,
    context?: ToolExecContext,
  ): Promise<ToolExecResult>
}

/**
 * The two-step concurrency-safe decision for the tool calls of a batch. A
 * tool must opt in; the default is a serial call. A tool with
 * `interactive: true` is always a serial call.
 */
export interface ToolConcurrencyPolicy {
  /** Before admission: the flag of the tool. */
  toolFlag(toolName: string): { flag: boolean }
  /**
   * After admission, with the input that a hook may have rewritten: the flag
   * AND the per-input check of the tool (a throw gives false). False means a
   * serial call.
   */
  isCallConcurrencySafe(toolName: string, input: Record<string, unknown>): boolean
}

/** Provides the set of available tool definitions. */
export interface ToolRegistry {
  /** All tools available to the agent, in registration order. */
  list(): ToolDefinition[]
}

/**
 * Advertisement-time tool filter: shapes the tools array sent to the model.
 *
 * Distinct from dispatch-time gating (mode permissions / teaching refusals),
 * which refuses a call *after* the model names a tool. Wire via
 * {@link AgentCoreConfig.toolFilter}. Hosts typically build one with
 * `toolFilterFromNamePolicy` from `./tool-filter.ts` (CLI `--tools` /
 * `--no-tools`, SDK allow-lists, tests).
 */
export interface ToolAdvertisementFilter {
  /** Return the subset of `tools` that should be advertised to the model. */
  filter(tools: readonly ToolDefinition[]): ToolDefinition[]
}

// ---------------------------------------------------------------------------
// Structured event sink (for --json / SDK streaming)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Structured event sink (for --json / SDK streaming)
// ---------------------------------------------------------------------------

// The canonical AgentEvent union + EventSink port live in ./events.ts (the
// single source of truth, per the PM ruling). Re-exported here so consumers
// that pull the event surface from the ports barrel keep working.
export type {
  AgentEvent,
  AgentEventType,
  EventSink,
  EventUsage,
} from "./events.ts"
export type { ToolEnvPort, ToolEnvValues } from "./tool-env.ts"
// The `toolEnv` port (spec S24) lives in ./tool-env.ts.
export { NOOP_TOOL_ENV } from "./tool-env.ts"

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

/** Persists session records at turn boundaries. */
export interface SessionPersistence {
  /** Append a user prompt record. Returns the generated message id. */
  appendUser(content: string | ContentBlock[]): string
  /** Append a completed assistant turn. */
  appendAssistant(
    content: ContentBlock[],
    stopReason: string | null,
    usage?: { input_tokens?: number; output_tokens?: number },
    /** Provider response id (e.g. Anthropic `msg_…`) for a completed turn. */
    meta?: { providerMessageId?: string },
  ): void
  /** Append a tool result record. */
  appendToolResult(
    result: ToolResultBlock,
    rawBlob?: { path: string; bytes: number; sha256: string },
  ): void
  /**
   * Append a tool result that core made itself, with no tool run (optional).
   * Examples: the note for a tool call that a kill cut off (decision 31),
   * and the result of a tool call an abort skipped. No executor writes these
   * results. A host whose executor owns tool-result writes (so its
   * {@link SessionPersistence.appendToolResult} does nothing) must write them
   * here, or a later load loses them. Without this method, core calls
   * `appendToolResult`.
   */
  appendSyntheticToolResult?(result: ToolResultBlock): void
  /** Append a free-form note. */
  appendNote(text: string): void
  /** Append a rewind marker. */
  appendRewind(toMsgId: string, droppedCount: number): void
  /**
   * Append a durable compact checkpoint (optional on older adapters).
   * When present, core writes `kind:"compact"` so model folds honor it
   * on resume without deleting history.
   */
  appendCompact?(rec: {
    reason: "manual" | "auto" | "exceeded"
    compactKind: "remote" | "local"
    messagesBefore: number
    messagesAfter: number
    replacementMessages: Array<{
      role: "user" | "assistant" | "system"
      content: string | import("../llm/messages.ts").ContentBlock[]
    }>
    encryptedContent?: string
    id?: string
    /** Structured compaction record. The writer sets `at` to the row `ts`. */
    meta?: Omit<import("../../plugin-api/src/types/compaction.ts").CompactMeta, "at">
  }): void
  /**
   * Append a round checkpoint (S50; optional on older adapters). The host
   * reads the latest one back on resume (a crash, a restart) and passes it
   * as {@link AgentCoreConfig.initialCheckpoint}, then calls `run` with its
   * `resume` option set, so the turn continues at the next round instead
   * of replaying it.
   */
  appendRoundCheckpoint?(checkpoint: {
    round: number
    streaks: import("./stop-policy.ts").Streaks
  }): void
  /**
   * Append a target-switch record (optional on older adapters): the live
   * credential/provider/model/effort after a change. With
   * `discardedThinking`, the model fold drops the thinking of each earlier
   * assistant record, so a resume gets the history the live session had.
   * The newest record is also the target of a resume.
   */
  appendTargetSwitch?(target: import("./target-change.ts").TargetSwitchEntry): void
}

// ---------------------------------------------------------------------------
// Prompt / context contributors
// ---------------------------------------------------------------------------

/** Contributes blocks to the system prompt or user turn context. */
export interface PromptContributor {
  /**
   * Session-context system blocks (typically plugin `<ma::sys::…>` sections).
   * AgentCore joins these into `resolveSystemPromptForModel({ sessionContext })`.
   */
  systemPromptBlocks?(): ContentBlock[]
  /**
   * Plain-markdown blocks inserted after the instructions block and before
   * session context. No plugin XML wrap. Optional; omit for legacy contributors.
   */
  afterInstructionsBlocks?(): ContentBlock[]
  /** Blocks prepended to each user turn (e.g. mode-change, tasks, short-term memory). */
  turnAttachments?(): ContentBlock[]
  /** Save-echo blocks collected after a turn completes. */
  saveEchoes?(): ContentBlock[]
  /**
   * The holder of the base prompt providers of THIS host, read per request.
   * Returns undefined when the host has none.
   */
  systemPromptBase?(): SystemPromptBaseHolder | undefined
}

// ---------------------------------------------------------------------------
// Mode provider
// ---------------------------------------------------------------------------

/** Provides mode information for the agent loop. */
export interface ModeProvider {
  /** The currently active mode id, or null for default. */
  activeModeId(): string | null
  /**
   * @deprecated Mode gating is dispatch-time only (cache-stable tool schemas).
   * Prefer {@link AgentCoreConfig.toolFilter} / {@link ToolAdvertisementFilter}
   * for advertisement-time filtering (CLI `--tools`, SDK allow-lists).
   */
  filterTools?(tools: ToolDefinition[]): ToolDefinition[]
  /** Consume a pending mode-change attachment, if any. */
  consumePendingAttachment?(): ContentBlock | null
}

// ---------------------------------------------------------------------------
// Media resolver
// ---------------------------------------------------------------------------

/** Per-call context the core gives a {@link MediaResolver}. */
export interface MediaResolveContext {
  /** The core's diagnostics handle (its session scope under a runtime, S20). */
  readonly diagnostics?: import("../diagnostics/hub.ts").Diagnostics
  /**
   * The core's one synthetic text resolver, for the media rejection texts
   * (`user_media.rejected`, `user_media.unavailable`). Omitted: the old text.
   */
  readonly syntheticText?: SyntheticTextResolverLike
  /**
   * The live model of the core at this call. A resolver that was built for
   * one model uses this one, so the accepted formats follow a target switch.
   */
  readonly modelId?: string
}

/** Resolves inline media references in user text. */
export interface MediaResolver {
  /** Resolve media references and return content blocks. Report warnings on `ctx.diagnostics`. */
  resolveUserContent(userText: string, ctx?: MediaResolveContext): Promise<ContentBlock[]>
}

// ---------------------------------------------------------------------------
// Abort / cancellation
// ---------------------------------------------------------------------------

/** Provides cancellation signals for the agent loop. */
export interface AbortSignalProvider {
  /** Signal that aborts the current turn. */
  signal(): AbortSignal
  /** Whether the current turn was aborted. */
  aborted(): boolean
}

// ---------------------------------------------------------------------------
// AgentCore construction bag
// ---------------------------------------------------------------------------

/** Host facts for the loop hook payloads ({@link AgentCoreConfig.sessionFacts}). */
export interface SessionFacts {
  sid?: string
  /** Set when this process runs as a delegated worker. */
  agentId?: string
  /** Lead session id when `agentId` is set. */
  leadSid?: string
  /** The host working directory. */
  cwd?: string
}

/** Everything AgentCore needs from the host. */
export interface AgentCoreConfig {
  /** Transport function that sends messages to the model. Defaults to the
   *  registry-selected transport when omitted. */
  sendFn?: TransportFn
  /** Optional network client forwarded to the transport. */
  networkClient?: NetworkClient
  /** Tool registry (core + plugin tools). */
  toolRegistry: ToolRegistry
  /**
   * Optional advertisement-time tool filter. Applied to
   * `toolRegistry.list()` when assembling the request body so the model only
   * sees allowed tools. Distinct from mode dispatch gates. See
   * {@link ToolAdvertisementFilter} and `toolFilterFromNamePolicy`.
   */
  toolFilter?: ToolAdvertisementFilter
  /** Tool executor. */
  toolExecutor: ToolExecutor
  /** Session persistence (optional; core works without it). */
  sessionPersistence?: SessionPersistence
  /** Prompt contributors (optional). */
  promptContributors?: PromptContributor[]
  /**
   * Synthetic text providers (G3). At most one per kind; the first wins.
   * With none, core uses today's text at the call site (warn mode, leaves in S3.3).
   */
  syntheticTextProviders?: readonly SyntheticTextProvider[]
  /**
   * A ready synthetic text resolver (G3), e.g. the plugin loader's
   * `syntheticText()`. Set: the core uses it and builds none, so the owner
   * check and its diagnostics run once. Absent: the core builds one from
   * {@link syntheticTextProviders}.
   */
  syntheticTextResolver?: SyntheticTextResolverLike
  /**
   * Built-in tool text providers (contract `text.tools`). Carried on the
   * config for the tool text step. AgentCore does not read it yet.
   */
  toolTextProviders?: readonly ToolTextProvider[]
  /**
   * Turn content providers (G2). They run in ascending `order` at the initial
   * and round seams. Their blocks follow the core slots. With none, user
   * content is unchanged.
   */
  turnContentProviders?: readonly TurnContentProviderDecl[]
  /** Mode provider (optional). */
  modeProvider?: ModeProvider
  /** Media resolver (optional). */
  mediaResolver?: MediaResolver
  /** Abort signal provider (optional). */
  abortSignalProvider?: AbortSignalProvider
  /** Model id for capability resolution. */
  model: string
  /** System prompt text. */
  systemPrompt: string
  /** Maximum tokens for the model's context window. */
  maxTokens: number
  /** Reasoning effort level. */
  effort?: "low" | "medium" | "high" | "max"
  /**
   * JSON Schema for constrained final answers (`--output-schema`). Merged into
   * `outputConfig.format` on each send when set.
   */
  outputSchema?: object
  /** Thinking display mode. */
  thinkingDisplay?: "summarized" | "omitted"
  /**
   * TTL bucket for the prompt-cache breakpoints (`"5m"` | `"1h"`). Default
   * `"5m"` (see `src/cache-ttl.ts :: DEFAULT_CACHE_TTL`). Resolved upstream
   * from `--cache-ttl` / `MINIMAL_AGENT_CACHE_TTL` / config.
   */
  cacheTtl?: import("../cache/cache-ttl.ts").CacheTtl
  /**
   * F1. Add the anchor `cache_control` marker on the message before the
   * latest assistant message (see `agent/cache.ts`). Default ON: undefined
   * is ON, only `false` turns it off. Resolved upstream from
   * `--cache-anchor` / `--no-cache-anchor` / `MINIMAL_AGENT_CACHE_ANCHOR` /
   * config.
   */
  cacheAnchor?: boolean
  /**
   * F2. `"strip"` (default) drops the thinking of older assistant turns;
   * `"keep"` sends the history append-only, only for keep-all models on the
   * Anthropic Messages wire. Resolved upstream from `--thinking-history` /
   * `MINIMAL_AGENT_THINKING_HISTORY` / config.
   */
  thinkingHistory?: import("../cache/cache-flags.ts").ThinkingHistoryMode
  /** Pre-existing conversation to seed the agent (resume). */
  initialMessages?: Message[]
  /**
   * Round checkpoint (S50) to resume from: the last round the session
   * persisted before a crash, a restart, or a permanent-error pause. Pass
   * the host's last {@link SessionPersistence.appendRoundCheckpoint} record
   * for this turn, then call `run(input, {resume: true})`.
   */
  initialCheckpoint?: import("./round-checkpoint.ts").RoundCheckpoint
  /**
   * Retry tunables: the clock (tests inject one so they never really wait),
   * the backoff ceiling (default 60 s), and the jitter source. There is no
   * attempt limit and no round limit: the loop is unbounded by design.
   */
  retry?: import("../llm/transport/retry-policy.ts").RetryPolicyOptions
  /** Reflection checkpoint interval in tool rounds. */
  reflectionCheckpointRounds?: number
  /** Service tier string forwarded to the provider. */
  serviceTier?: string
  /** Auth credentials for API calls. */
  auth: import("../auth/auth.ts").AuthResult
  /** Provider id for model disambiguation. */
  providerId?: string
  /**
   * Host-injected credential-name lookup for `AgentCore.switchTarget`.
   * The host (CLI, web, tests) returns the stored credential names for a
   * provider; core never reads the auth store itself. Omit when the host
   * has no store view (tests, bare cores): `switchTarget` then accepts any
   * explicit credential name without a check.
   */
  credentialNames?: SwitchTargetCredentialNames
  /**
   * Credential name selecting which stored credential to use for the provider
   * when it has multiple (e.g. "Work" / "Personal"). Carried onto every send so
   * mid-session requests resolve the same credential startup did. Omit for the
   * provider's default displayName entry.
   */
  credentialName?: string
  /** Resolved system-prompt overrides from CLI/env/config. */
  systemPromptOverrides?: import("../llm/system-prompt-overrides.ts").SystemPromptOverrides
  /** Speed mode. */
  speed?: "normal" | "fast"
  /** Reflection checkpoint cadence in tool rounds. */
  reflectionInterval?: number
  /** Wall-clock cooldown (ms) at each reflection checkpoint. */
  reflectionCooldownMs?: number
  /**
   * Optional structured event sink (for `--json` mode / SDK streaming). When
   * set, {@link AgentCoreConfig} consumers receive an {@link AgentEvent} stream
   * at the run-loop seams. Emission is best-effort and non-throwing: a sink
   * that throws never aborts the run. The canonical event surface lives in
   * `./events.ts`.
   */
  eventSink?: EventSink
  /**
   * Diagnostics handle (S20). A runtime passes the session scope
   * (`DiagnosticsHub.session(id)`, `src/diagnostics/hub.ts`), so every
   * diagnostic of this core, its transport, its compaction, and its network
   * requests carries the session id. Omit it and they go to the process bus
   * with no session id.
   */
  diagnostics?: import("../diagnostics/hub.ts").Diagnostics
  /**
   * Optional lifecycle / policy port (beforeSend, beforeTool, afterToolBatch,
   * compact, session). Hosts wire a HookBus adapter; omit or pass
   * {@link NOOP_LIFECYCLE} when no plugins are loaded. AgentCore never imports
   * HookBus directly (DIP).
   */
  lifecycle?: LifecyclePort
  /**
   * How many consecutive `turn.willStop` halts one turn honors. The next
   * halt ends the turn with a `stop_hook_capped` notice. Default 8.
   */
  maxStopHookHalts?: number
  /**
   * Concurrency cap: the largest number of tool calls that run at the same
   * time in a wave. An integer of 1 or more. A host resolves it with
   * `resolveMaxConcurrentToolCalls` (env `MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS`
   * over config `maxConcurrentToolCalls`). Omitted or invalid: 1 (each call
   * runs alone, the serial loop).
   */
  maxConcurrentToolCalls?: number
  /**
   * Host facts for the loop hook payloads (`turn.willStop`,
   * `session.willStart` on compact, `compact.willRun`): session id,
   * sub-agent identity, and the working directory. The core never reads the
   * session module or the process for them. Omit it and each field is
   * absent (`cwd` is `""`). A throw counts as no facts.
   */
  sessionFacts?: () => SessionFacts
  /**
   * The optional host ports (S17): `askUser`, `inputQueue`, `reflectionGate`,
   * `compactSource`. Each is independently optional; with none, the loop
   * runs headless. A per-run `askUser` option on {@link AgentCore.run}
   * takes priority over the `askUser` port set here for that one run.
   */
  ports?: HostPorts
  /**
   * Default live status port (spec S23), used for every send and retry
   * wait that does not pass its own on {@link AgentCore.run}'s `opts`. The
   * engine never reads a global status bus.
   */
  statusPort?: StatusPort
  /**
   * Default live-output telemetry port (spec S28), used for every send
   * that does not pass its own on {@link AgentCore.run}'s `opts`. The
   * engine never reads a global plugin-bus pointer.
   */
  pluginEvents?: PluginEventsPort
}

export type {
  AskUserPort,
  AskUserRequest,
  CompactSourcePort,
  HostPorts,
  InputQueuePort,
  PendingCompact,
  ReflectionGatePort,
} from "./host-ports.ts"
export { isUnfinished, type RoundCheckpoint, TURN_START } from "./round-checkpoint.ts"

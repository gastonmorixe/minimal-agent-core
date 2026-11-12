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

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
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

export type {
  CompactDidRunPayload,
  CompactWillRunPayload,
  CwdDidChangePayload,
  InstructionsDidLoadPayload,
  LifecyclePort,
  PolicyDecision,
  SendSnapshot,
  SessionLifecyclePayload,
  SubagentWillSpawnPayload,
  ToolBatchItem,
  ToolDidBatchPayload,
  ToolWillInvokePayload,
  TurnEndPayload,
  TurnWillStartPayload,
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
  description: string
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
}

/** Executes a single tool call and returns the result. */
export interface ToolExecutor {
  execute(toolUse: ToolUseBlock, signal?: AbortSignal): Promise<ToolExecResult>
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

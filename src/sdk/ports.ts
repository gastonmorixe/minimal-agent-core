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

import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { NetworkClient } from "../network/index.ts"

import type { EventSink } from "./events.ts"

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

/** One tool definition: name, description, JSON Schema input, and execution. */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
  /** Optional cosmetic fields stripped before sending to the API. */
  icon?: string
  color?: string
  headerKey?: string
}

/** Result of executing one tool call. */
export interface ToolExecResult {
  content: string | ContentBlock[]
  isError: boolean
  /** Optional pre-rendered ANSI body for transcript display. */
  display?: string
  /** Optional pre-rendered header content slot. */
  displayHeader?: string
  /** Optional pre-rendered footer row. */
  displayFooter?: string
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
  /** Optional per-tool cosmetic presentation (icon, color, headerKey). */
  presentation?(): ReadonlyMap<string, { icon?: string; color?: string; headerKey?: string }>
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
// Transcript / event sink
// ---------------------------------------------------------------------------

/** One line of transcript output. */
export type TranscriptLine = string

/** Receives transcript output from the agent loop. */
export interface TranscriptSink {
  /** Write one line of transcript. */
  write(line: TranscriptLine): void
  /** Flush any buffered output. Optional. */
  flush?(): void
}

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

// ---------------------------------------------------------------------------
// Transcript formatter (decouples tool-round.ts from ui/tool-transcript/format.ts)
// ---------------------------------------------------------------------------

/** Pre-rendered tool transcript parts. */
export interface ToolTranscriptParts {
  headerRows: string[]
  body: string
  footer?: string
  preview?: string
}

/** Formats tool output for transcript display. Host provides the implementation. */
export interface TranscriptFormatter {
  formatToolResult(
    toolUse: ToolUseBlock,
    result: ToolResultBlock,
    opts?: {
      terminalWidth?: number
      maxBodyLines?: number
    },
  ): ToolTranscriptParts
}

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
    presentation?: {
      display?: string
      displayHeader?: string
      displayFooter?: string
    },
  ): void
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
    replacementMessages: Array<{ role: "user" | "assistant" | "system"; content: string }>
    encryptedContent?: string
    id?: string
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
}

// ---------------------------------------------------------------------------
// Mode provider
// ---------------------------------------------------------------------------

/** Provides mode information for the agent loop. */
export interface ModeProvider {
  /** The currently active mode id, or null for default. */
  activeModeId(): string | null
  /** Resolve the prompt prefix for a given mode id. */
  promptPrefix?(baseArrow: string): string
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

/** Resolves inline media references in user text. */
export interface MediaResolver {
  /** Resolve media references and return content blocks. */
  resolveUserContent(userText: string): Promise<ContentBlock[]>
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
// Terminal metrics (host-provided)
// ---------------------------------------------------------------------------

/** Terminal dimensions for width-aware rendering. */
export interface TerminalMetrics {
  /** Terminal width in columns, or undefined if unknown. */
  columns(): number | undefined
  /** Terminal height in rows, or undefined if unknown. */
  rows(): number | undefined
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
  /** Transcript sink. */
  transcriptSink: TranscriptSink
  /** Session persistence (optional; core works without it). */
  sessionPersistence?: SessionPersistence
  /** Prompt contributors (optional). */
  promptContributors?: PromptContributor[]
  /** Mode provider (optional). */
  modeProvider?: ModeProvider
  /** Media resolver (optional). */
  mediaResolver?: MediaResolver
  /** Abort signal provider (optional). */
  abortSignalProvider?: AbortSignalProvider
  /** Terminal metrics (optional; for width-aware rendering). */
  terminalMetrics?: TerminalMetrics
  /** Model id for capability resolution. */
  model: string
  /** System prompt text. */
  systemPrompt: string
  /** Maximum tokens for the model's context window. */
  maxTokens: number
  /** Reasoning effort level. */
  effort?: "low" | "medium" | "high" | "max"
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
  /** Maximum tool rounds per turn (safety limit). */
  maxToolRounds?: number
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
}

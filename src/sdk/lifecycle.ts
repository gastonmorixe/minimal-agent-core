/**
 * Lifecycle policy contracts — typed decisions for veto/rewrite seams.
 *
 * AgentCore depends on {@link LifecyclePort} (DIP); it never imports HookBus
 * or PluginLoader. The host wires a HookBus-backed adapter (or a no-op).
 *
 * Decision vocabulary (rich lifecycle decisions, plugin-TS only):
 * - `allow` — continue; payload may be rewritten (updatedInput / redacted messages)
 * - `deny` — halt; reason is model/user-facing
 * - `ask` — reserved for a future host ask-user path; treat as deny until wired
 *
 * HookBus mapping: `{payload}` → allow with update; `{halt:true, reason?}` → deny;
 * `{payload, halt:true}` → deny but keep the last rewritten payload for audit.
 *
 * @module sdk/lifecycle
 */

import type { ContentBlock, Message } from "../llm/messages.ts"

import type { ToolDidInvokePayload } from "./tool-lifecycle.ts"

// ---------------------------------------------------------------------------
// PolicyDecision
// ---------------------------------------------------------------------------

/**
 * Outcome of a policy chain. Discriminated on {@link PolicyDecision.action}.
 *
 * @typeParam T - Threaded payload type (tool call, send snapshot, turn text, …).
 */
export type PolicyDecision<T> =
  | { action: "allow"; payload: T; additionalContext?: string[] }
  | { action: "deny"; reason: string; payload?: T; additionalContext?: string[] }
  | { action: "ask"; reason: string; payload: T; additionalContext?: string[] }

/** True when the decision blocks the protected action. */
export function isDenied<T>(d: PolicyDecision<T>): boolean {
  return d.action === "deny" || d.action === "ask"
}

/** Allow a payload unchanged. */
export function allowDecision<T>(payload: T, additionalContext?: string[]): PolicyDecision<T> {
  return additionalContext && additionalContext.length > 0
    ? { action: "allow", payload, additionalContext }
    : { action: "allow", payload }
}

/** Deny with a reason (optional last-seen payload for audit). */
export function denyDecision<T>(
  reason: string,
  payload?: T,
  additionalContext?: string[],
): PolicyDecision<T> {
  return {
    action: "deny",
    reason,
    ...(payload !== undefined ? { payload } : {}),
    ...(additionalContext && additionalContext.length > 0 ? { additionalContext } : {}),
  }
}

/**
 * Map a HookBus {@link ChainEmitResult}-shaped outcome onto {@link PolicyDecision}.
 *
 * - halted → deny (reason defaults to a generic veto message)
 * - otherwise → allow with the (possibly rewritten) payload
 *
 * `additionalContext` passes through onto the decision in both cases.
 */
export function chainResultToDecision<T>(
  result: { payload: T; halted: boolean; reason?: string; additionalContext?: string[] },
  defaultDenyReason = "Blocked by lifecycle policy hook.",
): PolicyDecision<T> {
  const ctx = result.additionalContext
  if (result.halted) {
    return denyDecision(result.reason?.trim() || defaultDenyReason, result.payload, ctx)
  }
  return allowDecision(result.payload, ctx)
}

// ---------------------------------------------------------------------------
// Payload shapes
// ---------------------------------------------------------------------------

/** User-turn text before it is handed to the model. */
export interface TurnWillStartPayload {
  text: string
  /** Session id, when known. */
  sid?: string
  /** Active agent mode id, when a mode is active. */
  agentMode?: string
}

/** Chain payload for `turn.willStop`: the loop is about to end the turn. */
export interface TurnWillStopPayload {
  /** Text of the last assistant message. */
  lastAssistantText: string
  /** True when a prior `turn.willStop` halt already continued this turn. */
  stopHookActive: boolean
  sid?: string
  /** When set, this turn runs inside a delegated worker. */
  agentId?: string
  /** Lead session id when `agentId` is set. */
  leadSid?: string
}

/** Chain payload for `session.willStart`: fires once per session start. */
export interface SessionWillStartPayload {
  source: "startup" | "resume" | "clear" | "compact"
  sid: string
  cwd: string
  model: string
}

/**
 * Outgoing request snapshot for {@link LifecyclePort.beforeSend}.
 * Listeners may rewrite `messages` / `system` for redaction.
 */
export interface SendSnapshot {
  messages: Message[]
  system: string | ContentBlock[]
  model: string
  providerId?: string
  /**
   * Read-only view of the other request options (tools, limits, thinking).
   * Listeners can inspect it (e.g. a dry-run dump). Changes to it are
   * ignored: only `messages` and `system` are rewritable.
   */
  request?: SendRequestView
  /** True when the send is a compaction request, not a conversation turn. */
  compact?: boolean
}

/** Read-only request options shown on {@link SendSnapshot.request}. */
export interface SendRequestView {
  requestType?: "quota" | "title" | "conversation"
  tools?: ReadonlyArray<{ name: string; description?: string; input_schema: unknown }>
  maxTokens?: number
  thinking?: { type: "adaptive"; display?: "summarized" | "omitted" } | false
  outputConfig?: { effort?: string; format?: { type: string; schema?: unknown } }
  temperature?: number
}

/** Pre-tool payload threaded on `tool.willInvoke` / {@link LifecyclePort.beforeTool}. */
export interface ToolWillInvokePayload {
  /** Tool name as the model requested, e.g. `"Edit"`, `"Bash"`. */
  tool: string
  /** `tool_use` id (join key for the matching `tool_result`). */
  toolUseId: string
  /** Parsed tool input; listeners may rewrite fields (updatedInput). */
  input: Record<string, unknown>
  /** Working directory at invocation time. */
  cwd: string
  /** When set, this call runs inside a delegated worker. */
  agentId?: string
  /** Lead session id when `agentId` is set. */
  leadSid?: string
  /** Session id, when known. */
  sid?: string
  /** Active agent mode id, when a mode is active. */
  agentMode?: string
}

/**
 * What {@link LifecyclePort.afterTool} returns: the (possibly augmented)
 * post-tool payload, plus the context strings the `tool.didInvoke`
 * listeners returned. The tool round appends that context to the result.
 */
export type ToolDidInvokeResult = ToolDidInvokePayload & { additionalContext?: string[] }

/** One finished tool call in a parallel batch (for `tool.didBatch`). */
export interface ToolBatchItem {
  tool: string
  toolUseId: string
  ok: boolean
}

export interface ToolDidBatchPayload {
  results: ToolBatchItem[]
}

export interface CompactWillRunPayload {
  reason: "manual" | "auto" | "exceeded"
  preferRemote?: boolean
  messagesBefore: number
  /** Session id, when known. */
  sid?: string
  /** Active agent mode id, when a mode is active (not the compact engine `mode`). */
  agentMode?: string
}

export interface CompactDidRunPayload {
  reason: "manual" | "auto" | "exceeded"
  messagesBefore: number
  messagesAfter: number
  compactKind: "remote" | "local"
}

export interface SessionLifecyclePayload {
  sid?: string
  cwd?: string
  model?: string
}

export interface TurnEndPayload {
  ok: boolean
  aborted?: boolean
  error?: string
}

export interface CwdDidChangePayload {
  from: string
  to: string
}

export interface InstructionsDidLoadPayload {
  source: string
  path?: string
}

export interface SubagentWillSpawnPayload {
  task: string
  model?: string
  isolation?: string
  depth: number
  leadSid: string
  type?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// LifecyclePort
// ---------------------------------------------------------------------------

/**
 * Host-injected policy / observation seams for the conversation engine.
 *
 * All methods are optional on the no-op default; AgentCore calls only the
 * methods it needs. Implementations must be non-throwing at the port boundary
 * (adapters absorb HookBus listener errors).
 */
export interface LifecyclePort {
  /** Before a queued user prompt is handed to the model (Tier 2 often owns this). */
  beforeTurn?(payload: TurnWillStartPayload): Promise<PolicyDecision<TurnWillStartPayload>>

  /**
   * The loop is about to end a turn with no pending tool calls
   * (`turn.willStop`). A deny continues the turn: the reason and the
   * decision's `additionalContext` become a continuation note.
   */
  beforeTurnStop?(payload: TurnWillStopPayload): Promise<PolicyDecision<TurnWillStopPayload>>

  /**
   * A session starts (`session.willStart`). It cannot block (a halt is
   * ignored). The returned lines go into the next user message as session
   * context.
   */
  sessionWillStart?(payload: SessionWillStartPayload): Promise<{ additionalContext: string[] }>

  /**
   * Before the transport sends; rewrite messages/system or deny (no network).
   * Also runs for compaction requests (local summary and remote compact).
   *
   * Listeners must return NEW objects for anything they change and must
   * never mutate the snapshot in place. `payload.messages` is only a shallow
   * copy: its message and block objects are the live history, so an in-place
   * edit changes the session history (and any compact checkpoint) too.
   */
  beforeSend?(payload: SendSnapshot): Promise<PolicyDecision<SendSnapshot>>

  /** After the transport accepts a stream (observation). */
  afterSend?(payload: SendSnapshot): void | Promise<void>

  /** After mode/CLI gate, before tool IO — deny or rewrite input. */
  beforeTool?(payload: ToolWillInvokePayload): Promise<PolicyDecision<ToolWillInvokePayload>>

  /**
   * True when an approval gate (a `failClosed` hook) is on the beforeTool
   * chain. The tool round then denies when the chain path throws, and
   * never runs the tool with the original input.
   */
  hasFailClosedToolHook?(): boolean

  /**
   * After a tool returns — augment findings/notes. Same shape as the
   * `tool.didInvoke` chain payload, plus the optional listener
   * `additionalContext` that the tool round appends to the tool result.
   */
  afterTool?(payload: ToolDidInvokePayload): Promise<ToolDidInvokeResult>

  /** After a parallel tool batch, before the next model call. Halt stops the loop. */
  afterToolBatch?(payload: ToolDidBatchPayload): Promise<PolicyDecision<ToolDidBatchPayload>>

  beforeCompact?(payload: CompactWillRunPayload): Promise<PolicyDecision<CompactWillRunPayload>>
  afterCompact?(payload: CompactDidRunPayload): void | Promise<void>

  sessionStart?(payload: SessionLifecyclePayload): void | Promise<void>
  sessionEnd?(payload: SessionLifecyclePayload): void | Promise<void>

  turnEnd?(payload: TurnEndPayload): void | Promise<void>
  turnFailed?(payload: TurnEndPayload): void | Promise<void>

  cwdDidChange?(payload: CwdDidChangePayload): void | Promise<void>
  instructionsDidLoad?(payload: InstructionsDidLoadPayload): void | Promise<void>

  beforeSubagentSpawn?(
    payload: SubagentWillSpawnPayload,
  ): Promise<PolicyDecision<SubagentWillSpawnPayload>>
}

/** Always-allow / no-op lifecycle. Safe default when no plugins are loaded. */
export const NOOP_LIFECYCLE: LifecyclePort = {
  async beforeTurn(payload) {
    return allowDecision(payload)
  },
  async beforeTurnStop(payload) {
    return allowDecision(payload)
  },
  async sessionWillStart() {
    return { additionalContext: [] }
  },
  async beforeSend(payload) {
    return allowDecision(payload)
  },
  async beforeTool(payload) {
    return allowDecision(payload)
  },
  async afterTool(payload) {
    return payload
  },
  async afterToolBatch(payload) {
    return allowDecision(payload)
  },
  async beforeCompact(payload) {
    return allowDecision(payload)
  },
  async beforeSubagentSpawn(payload) {
    return allowDecision(payload)
  },
}

/** Merge additionalContext strings from a decision into a notes array. */
export function collectAdditionalContext<T>(d: PolicyDecision<T>): string[] {
  return d.additionalContext?.filter((s) => typeof s === "string" && s.trim().length > 0) ?? []
}

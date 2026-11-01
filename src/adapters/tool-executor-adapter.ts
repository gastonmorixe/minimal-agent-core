/**
 * Host adapter: bind the legacy per-tool execution round to the SDK
 * {@link ToolExecutor} port.
 *
 * This is the highest-risk adapter in the Tier-1 set. It gives every
 * {@link AgentCore} run the one tool pipeline, without forking any of it,
 * by calling {@link executeToolRound} VERBATIM.
 *
 * `executeToolRound` (`src/agent/tool-round.ts`) owns the entire journey from
 * "the model asked for tool X" to "the tool_result block is ready": the mode
 * dispatch gate, the built-in `Mode` tool, plugin dispatch with universal
 * output clamping, built-in execution, the `tool.didInvoke` plugin chain,
 * raw-output blob capture + footer, the `<ma::agent::output-preview>` and
 * active-mode annotations, and JSONL persistence of the result. Reusing it
 * unchanged is what makes the golden-parity gate (G1) pass: the model-facing
 * `content` this adapter returns is assembled by the exact same code the
 * legacy loop runs.
 *
 * ### The sacred invariant
 *
 * `tool_result.id === item_started.id` (the call↔result join key). This adapter
 * is the single point it could silently break, because it is where a
 * `ToolResultBlock` becomes a {@link ToolExecResult}. It never touches the id:
 * `executeToolRound` returns a block whose `tool_use_id` is the input tool's
 * `id`, and {@link AgentCore} rebuilds the wire `tool_result` from that same
 * `tool.id`. The adapter maps only `content` + `is_error`. The id flows through
 * untouched by construction.
 *
 * ### Persistence ownership
 *
 * `executeToolRound` persists the tool_result itself (via `ctx.store`), WITH
 * the raw-blob pointer that a barebones
 * `SessionPersistence.appendToolResult(block)` call cannot supply. So this
 * adapter is the SOLE persister of tool_result records; the
 * `SessionPersistenceAdapter` deliberately no-ops its `appendToolResult` to
 * avoid a double write. See `build-agent-core.ts`.
 *
 * @module adapters/tool-executor-adapter
 */

import { executeToolRound, type ToolRoundContext } from "../agent/tool-round.ts"
import type { ToolViewPort } from "../agent/tool-view-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { LifecyclePort } from "../sdk/lifecycle.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { ToolExecResult, ToolExecutor } from "../sdk/ports.ts"
import type { ToolEnvPort } from "../sdk/tool-env.ts"
import type { BlobStore } from "../session/blob-store.ts"
import type { FileTrackingStore } from "../session/file-tracking-store.ts"
import type { SessionStore } from "../session/session-store.ts"
import type { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

// The tool view port types (spec S24), for hosts that show tool calls.
export type {
  PluginToolView,
  ToolViewEvent,
  ToolViewOutcome,
  ToolViewPort,
} from "../agent/tool-view-port.ts"

/**
 * Collaborators the adapter threads into every {@link ToolRoundContext} it
 * builds. All are fixed for the lifetime of one run (one `buildAgentCore`
 * call); only the per-call `AbortSignal` varies.
 */
export interface ToolExecutorAdapterDeps {
  /** Plugin loader for plugin-tool dispatch + the `tool.didInvoke` chain. */
  loader: PluginLoader | null
  /** Mode manager for the dispatch gate, the `Mode` tool, and mode stamps. */
  modeManager: ModeManager | null
  /** Per-session raw-output blob store (null disables blob capture). */
  blobStore: BlobStore | null
  /** Tools whose output is excluded from clamping + blob persistence. */
  blobSkipTools: ReadonlySet<string>
  /** Streak tracker behind the consecutive-truncation `[note: …]` hint. */
  feedbackTracker: ToolFeedbackTracker
  /** Active model id, used to resolve media (vision) capabilities. */
  model: string
  /**
   * Append-only session store for tool_result persistence. When set, this
   * adapter (via `executeToolRound`) is the SOLE persister of tool_result
   * records, with the raw-blob pointer. Defaults to `null`.
   */
  store?: SessionStore | null
  /** Durable per-session file observation store. */
  fileTrackingStore?: FileTrackingStore | null
  /**
   * Host view of each tool call (spec S24): plain events, no rows. These
   * events never change the model-facing text, so omitting it (the
   * default) is parity-safe for headless runs. A host that shows a
   * transcript builds its rows from the events.
   */
  toolView?: ToolViewPort | null
  /** Lifecycle / policy port. Defaults to {@link NOOP_LIFECYCLE}. */
  lifecycle?: LifecyclePort
  /**
   * Env values for a spawned tool (spec S24). Omitted: no added values.
   * Core never reads the terminal size. A terminal host passes its own.
   */
  toolEnv?: ToolEnvPort
  /**
   * Live status port (spec S23) for the `running_tool` row of each call.
   * Omitted: no tool status row.
   */
  statusPort?: StatusPort
}

/**
 * A {@link ToolExecutor} that runs {@link executeToolRound} for each tool call.
 *
 * Construct once per run with the fixed collaborators; call {@link execute}
 * per `tool_use` block. The returned {@link ToolExecResult} carries the exact
 * `content` + `is_error` that `executeToolRound` produced, unchanged.
 */
export class ToolExecutorAdapter implements ToolExecutor {
  constructor(private readonly deps: ToolExecutorAdapterDeps) {}

  /**
   * Execute one tool call verbatim through {@link executeToolRound} and map
   * the resulting `ToolResultBlock` onto the port's {@link ToolExecResult}.
   *
   * The mapping is intentionally minimal — `content` and `isError` only. The
   * tool_use id is NOT part of the result shape: {@link AgentCore} rejoins the
   * result to its `item_started` using the input tool's `id`, so the join key
   * is preserved without this adapter ever touching it.
   */
  async execute(toolUse: ToolUseBlock, signal?: AbortSignal): Promise<ToolExecResult> {
    // Sub-agent workers stamp MINIMAL_AGENT_SUBAGENT_ID / _LEAD (spawn-plan).
    const agentId = process.env.MINIMAL_AGENT_SUBAGENT_ID?.trim() || undefined
    const leadSid = process.env.MINIMAL_AGENT_SUBAGENT_LEAD?.trim() || undefined
    const ctx: ToolRoundContext = {
      toolView: this.deps.toolView ?? null,
      loader: this.deps.loader,
      modeManager: this.deps.modeManager,
      blobStore: this.deps.blobStore,
      blobSkipTools: this.deps.blobSkipTools,
      feedbackTracker: this.deps.feedbackTracker,
      model: this.deps.model,
      store: this.deps.store ?? null,
      fileTrackingStore: this.deps.fileTrackingStore ?? undefined,
      lifecycle: this.deps.lifecycle ?? NOOP_LIFECYCLE,
      ...(this.deps.toolEnv ? { toolEnv: this.deps.toolEnv } : {}),
      ...(this.deps.statusPort ? { statusPort: this.deps.statusPort } : {}),
      ...(signal ? { signal } : {}),
      ...(agentId ? { agentId } : {}),
      ...(leadSid ? { leadSid } : {}),
    }

    const block = await executeToolRound(toolUse, ctx)

    // Map ToolResultBlock -> ToolExecResult. `content` passes through as-is
    // (string, or a text+image block array for media-aware tools). `is_error`
    // is `boolean | undefined` on the block; the port wants a definite
    // boolean. The tool_use id is carried by the block's `tool_use_id`
    // (=== toolUse.id) and reconstructed by AgentCore — never remapped here.
    return {
      content: block.content,
      isError: !!block.is_error,
    }
  }
}

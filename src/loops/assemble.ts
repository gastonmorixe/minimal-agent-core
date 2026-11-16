/**
 * The Tier-1 assembly seam: build a fully-wired {@link AgentCore} from the host's
 * real collaborators (plugin loader, mode manager, session + blob stores, save
 * echo, turn-attachment producers), binding each to its SDK port through the
 * adapters in `src/adapters/` and the tool executor adapter in this file.
 *
 * This is the ONE function that stands between the two parallel work streams of
 * the agent-loop refactor: everything to the left of it (loading plugins,
 * parsing flags, booting stores) is the host's job; everything to the right (the
 * agentic loop, the event stream) is {@link AgentCore}'s. A non-interactive
 * `--output-format json` / `stream-json` run constructs its core here.
 *
 * ### Why async
 *
 * The frozen contract sketched `buildAgentCore(deps): AgentCore`. It is
 * implemented as `Promise<AgentCore>` because the plugin prompt block
 * (`loader.getPromptBlockAsync()`, incl. env-info-style fragments) is async and
 * memoized, yet {@link AgentCore} reads `PromptContributor.systemPromptBlocks()`
 * SYNCHRONOUSLY inside `run()`. So that the first request carries the block
 * (gate G1), it must be fully resolved BEFORE the run reads it, so it is
 * awaited here at construction (mirroring the legacy loop's
 * `await loader.getPromptBlockAsync()` seam). The DEPS shape is unchanged, so
 * the parallel work stream that builds those deps is unaffected; callers add
 * one `await`.
 *
 * ### Persistence ownership (no double write)
 *
 * `executeToolRound` (reused verbatim by {@link ToolExecutorAdapter}) persists
 * each tool_result itself, with the raw-blob pointer a
 * bare `SessionPersistence.appendToolResult` cannot carry. So the tool executor
 * adapter is the SOLE persister of tool_result records; the
 * {@link SessionPersistenceAdapter} no-ops that one method. Both are wired here.
 *
 * ### The tool executor adapter
 *
 * {@link ToolExecutorAdapter} binds {@link executeToolRound}
 * (`src/loops/tool-round.ts`) to the SDK {@link ToolExecutor} port. It calls
 * the round VERBATIM, so every run uses the one tool pipeline. The round owns
 * the mode gate, the `Mode` tool, plugin dispatch with output clamping,
 * built-in execution, the `tool.didInvoke` chain, raw-output blob capture,
 * the `<ma::agent::output-preview>` and active-mode annotations, and JSONL
 * persistence of the result.
 *
 * The adapter keeps the call-to-result join key:
 * `tool_result.id === item_started.id`. It maps only `content` and
 * `is_error`. It never touches
 * the tool_use id. {@link AgentCore} rebuilds the wire `tool_result` from the
 * input tool's `id`.
 *
 * The adapter and the build step take no UI types (spec S24). The host view
 * of a tool call is the plain {@link ToolViewPort}.
 *
 * @module loops/assemble
 */

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { TurnContentProviderDecl } from "../../plugin-api/src/types/turn-content.ts"
import { createLifecyclePort } from "../adapters/lifecycle-port-adapter.ts"
import { MediaResolverAdapter } from "../adapters/media-resolver-adapter.ts"
import { ModeProviderAdapter } from "../adapters/mode-provider-adapter.ts"
import {
  PromptContributorAdapter,
  type SaveEchoCollector,
  type TurnAttachmentProducer,
} from "../adapters/prompt-contributor-adapter.ts"
import { SessionPersistenceAdapter } from "../adapters/session-persistence-adapter.ts"
import { ToolRegistryAdapter } from "../adapters/tool-registry-adapter.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { ToolViewPort } from "../agent/tool-view-port.ts"
import {
  combineTurnDrains,
  instantiateTurnAttachments,
  type TurnAttachmentContext,
} from "../agent/turn-attachments.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import { type CacheTtl, DEFAULT_CACHE_TTL } from "../cache/cache-ttl.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { Message, ToolUseBlock } from "../llm/messages.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "../llm/model-info.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { NetworkClient } from "../network/index.ts"
import { takePendingCompact } from "../plugins/host/providers/context-compact.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { hostSessionFacts, subagentIdentity } from "../runtime/host-session-facts.ts"
import { createRuntime } from "../runtime/runtime.ts"
import type { Session } from "../runtime/session.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { EventSink } from "../sdk/events.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type {
  AgentCoreConfig,
  CompactSourcePort,
  HostPorts,
  PromptContributor,
  ToolExecContext,
  ToolExecResult,
  ToolExecutor,
} from "../sdk/ports.ts"
import type { OutputStrictConfig } from "../sdk/run-output-strict.ts"
import type { ToolEnvPort } from "../sdk/tool-env.ts"
import { type ToolNamePolicy, toolFilterFromNamePolicy } from "../sdk/tool-filter.ts"
import { type BlobStore, loadBlobStoreConfig } from "../session/blob-store.ts"
import type { FileTrackingStore } from "../session/file-tracking-store.ts"
import { type SessionStore, shortHash } from "../session/session-store.ts"
import { computeStartupHashes, type StartupHashes } from "../session/startup-hashes.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

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

  /** True when this executor writes raw-output blobs (an enabled blob store). */
  get blobStoreEnabled(): boolean {
    return this.deps.blobStore?.config.enabled === true
  }

  /**
   * Execute one tool call verbatim through {@link executeToolRound} and map
   * the resulting `ToolResultBlock` onto the port's {@link ToolExecResult}.
   *
   * The mapping is intentionally minimal — `content` and `isError` only. The
   * tool_use id is NOT part of the result shape: {@link AgentCore} rejoins the
   * result to its `item_started` using the input tool's `id`, so the join key
   * is preserved without this adapter ever touching it.
   */
  async execute(
    toolUse: ToolUseBlock,
    signal?: AbortSignal,
    context?: ToolExecContext,
  ): Promise<ToolExecResult> {
    const { agentId, leadSid } = subagentIdentity()
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
      ...(context?.sid ? { sid: context.sid } : {}),
      ...(context?.text ? { text: context.text } : {}),
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

/**
 * Everything {@link buildAgentCore} needs from the host to construct a wired
 * {@link AgentCore}. The DEPS shape is the frozen coordination boundary between
 * the two parallel work streams: the host builds this bag, the core consumes
 * the adapters it produces.
 */
export interface BuildAgentCoreDeps {
  /** Auth credentials for API calls. */
  auth: AuthResult
  /** Model id for the run. */
  model: string
  /** Provider id for model disambiguation. */
  providerId?: string
  /** Stored-credential selector when a provider has multiple. */
  credentialName?: string
  /** Host credential-name lookup for `switchTarget` (`AgentCoreConfig.credentialNames`). */
  credentialNames?: (providerId: string) => readonly string[]
  /** Reasoning effort (opaque string; cast to the config union). */
  effort?: string
  /** JSON Schema for `--output-schema` constrained decoding. */
  outputSchema?: object
  /**
   * Ask for strict structured output on every run (R2, default false). No
   * effect without an `outputSchema`. The provider plugin decides by model
   * capability what goes on the wire.
   */
  outputStrict?: boolean
  /** Speed mode (`fast` when the host opted in). */
  speed?: "normal" | "fast"
  /** Provider-neutral service-tier override. */
  serviceTier?: string
  /** Optional `thinking.display` override. */
  thinkingDisplay?: "summarized" | "omitted"
  /** Prompt-cache TTL bucket. */
  cacheTtl?: CacheTtl
  /** Pre-existing conversation to seed the core (resume). */
  initialMessages?: Message[]
  /**
   * Round checkpoint to resume an unfinished turn from (S50). Read it back
   * from the session's last `appendRoundCheckpoint` record and pass it with
   * a `run(input, {resume: true})` call.
   */
  initialCheckpoint?: AgentCoreConfig["initialCheckpoint"]
  /** Plugin loader (tools + prompt fragments + modes). Null when no plugins. */
  loader: PluginLoader | null
  /** Mode manager. Null when modes are disabled. */
  modeManager: ModeManager | null
  /**
   * Advertisement-time tool name policy (`--tools` / `--no-tools` / SDK
   * allow-list). Wired onto AgentCore as `toolFilter` via
   * {@link toolFilterFromNamePolicy}. Null/undefined → advertise full registry.
   */
  toolNamePolicy?: ToolNamePolicy
  /** Append-only session store. Null when persistence is off. */
  store: SessionStore | null
  /** Durable per-session file observation store. */
  fileTrackingStore?: FileTrackingStore | null
  /** Per-session raw-output blob store. Null when blob capture is off. */
  blobStore: BlobStore | null
  /** Save-echo collector (memory-saved blocks). Null when memory is absent. */
  saveEcho: SaveEchoCollector | null
  /** Per-turn attachment producers (memory / tasks / fleet), in registry order. */
  turnAttachments: TurnAttachmentProducer[]
  /**
   * Raw context to instantiate the registered turn-attachment factories
   * internally (S34 PORT fold: `agent/turn-attachments.ts`). When set,
   * {@link buildAgentCore} / {@link openAgentCoreSession} call
   * `instantiateTurnAttachments` + `combineTurnDrains` themselves and merge
   * the result into `saveEcho` / `turnAttachments` above, instead of
   * requiring the caller to do that first. Additive: a caller that already
   * pre-instantiates (the original contract — passing `saveEcho` /
   * `turnAttachments` directly) is unaffected by omitting this.
   */
  turnAttachmentContext?: TurnAttachmentContext
  /** Logger forwarded to `instantiateTurnAttachments` when {@link turnAttachmentContext} is set. */
  turnAttachmentLogger?: (msg: string) => void
  /** Injectable transport (test seam). Defaults to the registry-selected one. */
  sendFn?: TransportFn
  /** Optional network client forwarded to the transport. */
  networkClient?: NetworkClient
  /** Structured event sink (the JsonlEventSink for `--json`/`stream-json`). */
  eventSink?: EventSink
  /**
   * Diagnostics handle (S20). The runtime (S47) passes the session's scope
   * (`DiagnosticsHub.session(id)`) so every diagnostic of this core, its
   * transport, and its compaction carries the session id. Omit for the
   * process-bus fallback.
   */
  diagnostics?: Diagnostics
  /**
   * Synthetic text providers (G3), forwarded to AgentCore. Default: the
   * loader's `syntheticTextProviders()`. An explicit value wins.
   */
  syntheticTextProviders?: readonly SyntheticTextProvider[]
  /**
   * Built-in tool text providers, forwarded to AgentCore. Default: the
   * loader's `toolTextProviders()`. An explicit value wins.
   */
  toolTextProviders?: readonly ToolTextProvider[]
  /** Turn content providers (G2), forwarded to AgentCore. */
  turnContentProviders?: readonly TurnContentProviderDecl[]
  /** Resolved system-prompt overrides from CLI/env/config. */
  systemPromptOverrides?: SystemPromptOverrides
  /**
   * Extra system-prompt text from the host (for example an ACP client's
   * `systemPrompt.append`). Emitted by a second {@link PromptContributor}
   * through `afterInstructionsBlocks()`, so it lands after the instructions
   * block (and after plugin after-instructions text) and before the session
   * context. Missing, empty, or whitespace-only: no contributor is added and
   * the prompt is unchanged. A `full` override still replaces everything.
   */
  appendSystemPrompt?: string
  /**
   * Host view of each tool call (spec S24): plain events, no rows. A host
   * that shows a transcript builds its rows from them. Headless `--json`
   * omits this. Turn notices are `notice` events, not tool events.
   */
  toolView?: ToolViewPort | null
  /**
   * Env values for a spawned tool (spec S24). Omitted: no added values.
   * Core never reads the terminal size.
   */
  toolEnv?: ToolEnvPort
  /**
   * Default live status port (spec S23) for every send and retry wait.
   * Omitted (no live status) unless the host wires one — e.g. a TUI host
   * mirroring phases onto its own status bus with its own labels.
   */
  statusPort?: StatusPort
  /**
   * Default live-output telemetry port (spec S28). Omitted (no telemetry)
   * unless the host wires one — e.g. a TUI host forwarding to its plugin
   * bus for a tokens-per-second readout.
   */
  pluginEvents?: PluginEventsPort
  /** Rounds between reflection checkpoints (AgentCoreConfig default when unset). */
  reflectionInterval?: number
  /** Reflection pause length in ms (AgentCoreConfig default when unset). */
  reflectionCooldownMs?: number
  /** Retry tunables (clock, backoff ceiling). No attempt or round limit exists. */
  retry?: AgentCoreConfig["retry"]
  /** Consecutive `turn.willStop` halts one turn honors (AgentCoreConfig default when unset). */
  maxStopHookHalts?: number
  /**
   * Session id for {@link openAgentCoreSession}. The CLI passes its own
   * session id so the Session and its event log use the same id as the
   * store. When unset, the runtime makes a fresh random UUID.
   * {@link buildAgentCore} does not read it.
   */
  sessionId?: string
  /**
   * Compact-source override (S34 PORT fold: `plugins/host/providers/context-compact.ts`).
   * Both {@link buildAgentCore} and
   * {@link openAgentCoreSession} already wire the SDK's `compactSource`
   * port to the plugin host's pending-compact queue
   * (`takePendingCompact()`) by default; pass this to override that
   * default — e.g. the REPL's keyboard-driven compact trigger feeds its own
   * queue into the exact same port.
   */
  compactSource?: CompactSourcePort
  /**
   * Opt in to wiring the loader's ModelInfo-tool data source internally
   * (S34 PORT fold: `llm/model-info.ts`), tied to the constructed core's
   * own live model (`AgentCore.getModel()`), instead of the caller
   * threading `modelInfoProvider` / `recommendSubagentModels` closures into
   * `PluginLoader.load()` by hand. Off by default: an existing caller that
   * already wires its own (e.g. a closure over its own live-model getter)
   * keeps exactly its current behavior.
   */
  wireModelInfoSource?: boolean
}

/**
 * The full contributor list for one core/session: the plugin contributor,
 * then (only when {@link BuildAgentCoreDeps.appendSystemPrompt} has text) a
 * second contributor that serves that text as an after-instructions block.
 * AgentCore joins every contributor's `afterInstructionsBlocks()` in list
 * order, so the appended text follows plugin after-instructions text.
 */
function buildPromptContributors(
  base: PromptContributor,
  appendSystemPrompt: string | undefined,
): PromptContributor[] {
  const text = appendSystemPrompt?.trim()
  if (!text) return [base]
  const appended: PromptContributor = {
    afterInstructionsBlocks: () => [{ type: "text", text }],
  }
  return [base, appended]
}

/**
 * Fold the host append text into `systemHash`, so a resume with a different
 * append is flagged as drift. The same trim rule as
 * {@link buildPromptContributors}: missing or blank returns the hashes
 * unchanged (old sessions keep their exact hash).
 */
export function foldAppendIntoHashes(
  hashes: StartupHashes,
  appendSystemPrompt: string | undefined,
): StartupHashes {
  const text = appendSystemPrompt?.trim()
  if (!text) return hashes
  return { ...hashes, systemHash: shortHash(`${hashes.systemHash}\u0000append\u0000${text}`) }
}

/**
 * Resolve the final `turnAttachments` / `saveEcho` pair for
 * {@link buildAgentCore} / {@link openAgentCoreSession} (S34 PORT fold).
 * With no `turnAttachmentContext`, returns `deps.turnAttachments` /
 * `deps.saveEcho` unchanged — the original, pre-instantiated contract. With
 * one, instantiates every registered turn-attachment factory against it and
 * merges the result in, so a caller can pass the raw context instead of
 * calling `instantiateTurnAttachments` / `combineTurnDrains` itself first.
 */
async function resolveTurnAttachments(
  deps: BuildAgentCoreDeps,
): Promise<{ turnAttachments: TurnAttachmentProducer[]; saveEcho: SaveEchoCollector | null }> {
  if (!deps.turnAttachmentContext) {
    return { turnAttachments: deps.turnAttachments, saveEcho: deps.saveEcho }
  }
  const { producers, drains } = await instantiateTurnAttachments(
    deps.turnAttachmentContext,
    deps.turnAttachmentLogger,
  )
  return {
    turnAttachments: [...deps.turnAttachments, ...producers],
    saveEcho: combineTurnDrains(deps.saveEcho ? [deps.saveEcho, ...drains] : drains),
  }
}

/** The config-union effort values AgentCore accepts. */
const EFFORT_VALUES = new Set(["low", "medium", "high", "max"])

/**
 * Narrow the host's opaque effort string to the {@link AgentCoreConfig} union,
 * dropping anything unrecognized (undefined → server default). Mirrors the
 * legacy path's string→union threading. Exported so `InteractiveSession`'s
 * `openSession`-based assembly (`interactive-session.ts`) applies the exact
 * same narrowing when it builds a `Session` instead of a bare `AgentCore`.
 */
export function toEffort(
  effort: string | undefined,
): "low" | "medium" | "high" | "max" | undefined {
  return effort !== undefined && EFFORT_VALUES.has(effort)
    ? (effort as "low" | "medium" | "high" | "max")
    : undefined
}

/**
 * Construct a fully-wired {@link AgentCore} for the non-interactive
 * `--output-format json` / `stream-json` path.
 *
 * Builds one adapter per port from the host's real collaborators and injects
 * them into a single {@link AgentCoreConfig}. The plugin prompt block is
 * awaited here so the core's synchronous `systemPromptBlocks()` read sees the
 * fully-resolved block (parity with the legacy loop). The returned core is
 * ready to `run()`.
 */
export async function buildAgentCore(deps: BuildAgentCoreDeps): Promise<AgentCore> {
  // Tool registry: core built-ins + plugin tools, with aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader, deps.toolTextProviders)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with the raw-blob pointer), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)

  const toolExecutor = new ToolExecutorAdapter({
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    ...(deps.toolView ? { toolView: deps.toolView } : {}),
    lifecycle,
    ...(deps.toolEnv ? { toolEnv: deps.toolEnv } : {}),
    ...(deps.statusPort ? { statusPort: deps.statusPort } : {}),
  })

  // Turn attachments: pre-instantiated (the original contract) unless the
  // caller passed a raw `turnAttachmentContext` (S34 PORT fold), in which
  // case this instantiates the registered factories internally.
  const { turnAttachments, saveEcho } = await resolveTurnAttachments(deps)

  // Prompt contributor: awaits the plugin prompt block once (parity seam),
  // plus save-echoes and per-turn attachment producers.
  const promptContributor = await PromptContributorAdapter.create({
    loader: deps.loader,
    saveEcho,
    turnAttachments,
  })

  // Session persistence: user/assistant/note/rewind only (tool_result owned by
  // the executor adapter). Omitted entirely when no store is wired.
  const sessionPersistence = deps.store ? new SessionPersistenceAdapter(deps.store) : undefined

  // Mode provider: the mode-change signal + read-only queries. Tool gating +
  // active-mode stamps live in executeToolRound via the raw manager above.
  // Advertisement-time filtering is the separate `toolFilter` port below —
  // not ModeProvider.filterTools.
  const modeProvider = deps.modeManager ? new ModeProviderAdapter(deps.modeManager) : undefined

  // Advertisement filter: CLI/SDK name policy → structural ToolAdvertisementFilter.
  // Wire whenever a non-null policy is present (allow-list or deny-all) so
  // AgentCore never falls back to the deprecated ModeProvider.filterTools path.
  const toolFilter =
    deps.toolNamePolicy != null ? toolFilterFromNamePolicy(deps.toolNamePolicy) : undefined

  // Media resolver: ingest inline @file / image refs using the run's model.
  const mediaResolver = new MediaResolverAdapter(deps.model)

  // S17/S27: the `compactSource` port reads the plugin host's
  // `context:compact` queue by default (S34 PORT fold: a caller may
  // override it instead, e.g. the REPL's keyboard-driven compact trigger).
  // AgentCore no longer imports `plugins/host` itself; this is the one
  // place that bridges the two.
  const ports: HostPorts = {
    compactSource: deps.compactSource ?? { take: () => takePendingCompact() },
  }

  const config: AgentCoreConfig & OutputStrictConfig = {
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(deps.credentialNames !== undefined ? { credentialNames: deps.credentialNames } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.outputStrict !== undefined ? { outputStrict: deps.outputStrict } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
    ports,
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    ...(deps.eventSink !== undefined ? { eventSink: deps.eventSink } : {}),
    ...(deps.diagnostics !== undefined ? { diagnostics: deps.diagnostics } : {}),
    toolRegistry,
    ...(toolFilter ? { toolFilter } : {}),
    toolExecutor,
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: buildPromptContributors(promptContributor, deps.appendSystemPrompt),
    ...textProviders(deps),
    ...(deps.turnContentProviders ? { turnContentProviders: deps.turnContentProviders } : {}),
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    lifecycle,
    // `systemPrompt` + `maxTokens` are vestigial in AgentCoreConfig: run()
    // derives both itself (resolveSystemPromptForModel + resolveMaxOutputTokens).
    // Required by the type, unread at runtime.
    systemPrompt: "",
    maxTokens: 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.reflectionInterval !== undefined
      ? { reflectionInterval: deps.reflectionInterval }
      : {}),
    ...(deps.reflectionCooldownMs !== undefined
      ? { reflectionCooldownMs: deps.reflectionCooldownMs }
      : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    ...(deps.maxStopHookHalts !== undefined ? { maxStopHookHalts: deps.maxStopHookHalts } : {}),
    sessionFacts: hostSessionFacts,
    ...(deps.statusPort !== undefined ? { statusPort: deps.statusPort } : {}),
    ...(deps.pluginEvents !== undefined ? { pluginEvents: deps.pluginEvents } : {}),
  }

  const core = new AgentCore(config)
  // The mode texts use the core's one resolver (unless the host passed one).
  deps.modeManager?.bindSyntheticText(core.syntheticText)
  wireModelInfoSourceIfOpted(deps, () => core.getModel())
  return core
}

/**
 * The synthetic and tool text providers for the core config. An explicit
 * deps value wins. Else the loader's providers (B1 wiring), so every boot
 * path that passes a loader reaches the plugin text. With neither, the
 * field is absent and the core keeps its fallback text.
 */
function textProviders(deps: BuildAgentCoreDeps): {
  syntheticTextProviders?: readonly SyntheticTextProvider[]
  syntheticTextResolver?: SyntheticTextResolver
  toolTextProviders?: readonly ToolTextProvider[]
} {
  const loader = deps.loader
  const synthetic =
    deps.syntheticTextProviders ??
    (loader && typeof loader.syntheticTextProviders === "function"
      ? loader.syntheticTextProviders()
      : undefined)
  // The loader's providers come with the loader's one resolver (MINOR-4),
  // so the core builds no second one and synthetic.duplicate_owner fires
  // once. Explicit providers: the core builds its own resolver from them.
  const resolver =
    deps.syntheticTextProviders === undefined &&
    loader &&
    typeof loader.syntheticText === "function"
      ? loader.syntheticText()
      : undefined
  const tool =
    deps.toolTextProviders ??
    (loader && typeof loader.toolTextProviders === "function"
      ? loader.toolTextProviders()
      : undefined)
  return {
    ...(synthetic ? { syntheticTextProviders: synthetic } : {}),
    ...(resolver ? { syntheticTextResolver: resolver } : {}),
    ...(tool ? { toolTextProviders: tool } : {}),
  }
}

/**
 * S34 PORT fold (`llm/model-info.ts`): when {@link BuildAgentCoreDeps.wireModelInfoSource}
 * is set and a loader is present, replace its ModelInfo-tool data source
 * with one tied to `getLiveModelId` — the constructed core's/session's own
 * live model — instead of the caller threading those closures into
 * `PluginLoader.load()` by hand. A no-op when the opt-in is unset (every
 * existing caller's behavior is unchanged) or there is no loader.
 */
function wireModelInfoSourceIfOpted(deps: BuildAgentCoreDeps, getLiveModelId: () => string): void {
  if (!deps.wireModelInfoSource || !deps.loader) return
  deps.loader.setModelInfoSource(
    () => buildModelInfoSnapshot(getLiveModelId(), deps.providerId),
    () => buildSubagentModelRecommendations(getLiveModelId()),
  )
}

/**
 * Construct a `Session` (via `createRuntime().openSession`) wired with the
 * exact same host collaborators {@link buildAgentCore} wires — the same
 * adapter classes, built from the same {@link BuildAgentCoreDeps} shape —
 * for a host that wants the runtime/session-driving contract
 * (`session.run()`, `session.subscribe()`) instead of a bare {@link AgentCore}.
 *
 * Used by the CLI's structured `--output-format json` / `stream-json`
 * event-stream route (`run-non-interactive.ts`): `Session`'s own event log
 * always captures every `AgentEvent` kind — that is its whole point, a
 * complete trace (agent E's S48 design) — so this does NOT take an
 * `eventSink` (`SessionOptions` has none). A caller that wants only
 * `LEGACY_EVENT_KINDS` on the wire filters `session.run()`'s own
 * `SessionEntry` stream at its own subscription boundary instead of asking
 * `Session` to log anything less than the complete trace.
 *
 * `askUserFallback: "none"`: a one-shot run can never answer an ask, so
 * (with no per-run `askUser` override) a preflight issue is denied with an
 * `ask_denied` notice and the request sent unchanged — `AgentCore`'s own
 * headless fallback, the same behavior a bare `buildAgentCore`-built core
 * (no `ports.askUser`) has today.
 *
 * The returned value also carries `startupHashes` (S34 PORT fold:
 * `host/startup/startup-hashes.ts`) — the `systemHash`/`toolsHash` pair a
 * `--resume` drift check compares against the session-store meta record,
 * computed from the SAME `deps` this function already assembled instead of
 * a caller re-deriving them externally via a separate module call.
 */
export async function openAgentCoreSession(
  deps: BuildAgentCoreDeps,
): Promise<Session & { readonly startupHashes: StartupHashes }> {
  // Tool registry: core built-ins + plugin tools, with aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader, deps.toolTextProviders)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with the raw-blob pointer), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)

  const toolExecutor = new ToolExecutorAdapter({
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    ...(deps.toolView ? { toolView: deps.toolView } : {}),
    lifecycle,
    ...(deps.toolEnv ? { toolEnv: deps.toolEnv } : {}),
    ...(deps.statusPort ? { statusPort: deps.statusPort } : {}),
  })

  // Turn attachments: pre-instantiated (the original contract) unless the
  // caller passed a raw `turnAttachmentContext` (S34 PORT fold), in which
  // case this instantiates the registered factories internally.
  const { turnAttachments, saveEcho } = await resolveTurnAttachments(deps)

  // Prompt contributor: awaits the plugin prompt block once (parity seam),
  // plus save-echoes and per-turn attachment producers.
  const promptContributor = await PromptContributorAdapter.create({
    loader: deps.loader,
    saveEcho,
    turnAttachments,
  })

  // Session persistence: user/assistant/note/rewind only (tool_result owned by
  // the executor adapter). Omitted entirely when no store is wired.
  const sessionPersistence = deps.store ? new SessionPersistenceAdapter(deps.store) : undefined

  // Mode provider: the mode-change signal + read-only queries. Tool gating +
  // active-mode stamps live in executeToolRound via the raw manager above.
  // Advertisement-time filtering is the separate `toolFilter` port below —
  // not ModeProvider.filterTools.
  const modeProvider = deps.modeManager ? new ModeProviderAdapter(deps.modeManager) : undefined

  // Advertisement filter: CLI/SDK name policy → structural ToolAdvertisementFilter.
  const toolFilter =
    deps.toolNamePolicy != null ? toolFilterFromNamePolicy(deps.toolNamePolicy) : undefined

  // Media resolver: ingest inline @file / image refs using the run's model.
  const mediaResolver = new MediaResolverAdapter(deps.model)

  const runtime = createRuntime()
  const session = await runtime.openSession({
    // Use the caller's session id when given. Else the runtime makes a UUID.
    ...(deps.sessionId !== undefined ? { id: deps.sessionId } : {}),
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(deps.credentialNames !== undefined ? { credentialNames: deps.credentialNames } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    toolRegistry,
    ...(toolFilter ? { toolFilter } : {}),
    toolExecutor,
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: buildPromptContributors(promptContributor, deps.appendSystemPrompt),
    ...textProviders(deps),
    ...(deps.turnContentProviders ? { turnContentProviders: deps.turnContentProviders } : {}),
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    lifecycle,
    // No `sessionFacts`: the Session default gives the host facts with the
    // session id (deps.sessionId when given) as `sid`.
    // `systemPrompt` + `maxTokens` are vestigial, like `buildAgentCore`'s own
    // config: `run()` derives both itself.
    systemPrompt: "",
    maxTokens: 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.reflectionInterval !== undefined
      ? { reflectionInterval: deps.reflectionInterval }
      : {}),
    ...(deps.reflectionCooldownMs !== undefined
      ? { reflectionCooldownMs: deps.reflectionCooldownMs }
      : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    ...(deps.statusPort !== undefined ? { statusPort: deps.statusPort } : {}),
    ...(deps.pluginEvents !== undefined ? { pluginEvents: deps.pluginEvents } : {}),
    // S17/S27: the `compactSource` port reads the plugin host's
    // `context:compact` queue by default, exactly like `buildAgentCore`
    // (S34 PORT fold: a caller may override it instead).
    ports: { compactSource: deps.compactSource ?? { take: () => takePendingCompact() } },
    askUserFallback: "none",
  })

  // R2: `openSession` options do not carry strict, so set it on the core.
  if (deps.outputStrict !== undefined) session.agentCore().setOutputStrict(deps.outputStrict)
  deps.modeManager?.bindSyntheticText(session.agentCore().syntheticText)
  wireModelInfoSourceIfOpted(deps, () => session.agentCore().getModel())

  // Loader diagnostics from now on (event bus, hooks, slash commands,
  // plugin ctx.log) carry this session's id and reach its event log (S20).
  if (deps.loader && typeof deps.loader.attachSessionDiagnostics === "function") {
    session.onClose(deps.loader.attachSessionDiagnostics(session.diagnostics))
  }

  const baseHashes = await computeStartupHashes({
    loader: deps.loader,
    modeManager: deps.modeManager,
    ...(deps.toolNamePolicy !== undefined ? { toolNamePolicy: deps.toolNamePolicy } : {}),
    selectedModelBase: deps.model,
    ...(deps.providerId !== undefined ? { selectedProviderId: deps.providerId } : {}),
    auth: deps.auth,
    cacheTtl: deps.cacheTtl ?? DEFAULT_CACHE_TTL,
    ...(deps.systemPromptOverrides !== undefined
      ? { systemPromptOverrides: deps.systemPromptOverrides }
      : {}),
    ...(deps.toolTextProviders !== undefined ? { toolTextProviders: deps.toolTextProviders } : {}),
    // Same value the core reads from its executor (ToolExecutorAdapter).
    blobStoreEnabled: toolExecutor.blobStoreEnabled,
  })
  const startupHashes = foldAppendIntoHashes(baseHashes, deps.appendSystemPrompt)

  return Object.assign(session, { startupHashes })
}

// Re-export the adapter surface so a host can import the whole Tier-1 binding
// from one module.
export {
  createLifecyclePort,
  LifecyclePortAdapter,
} from "../adapters/lifecycle-port-adapter.ts"
// This is the hash recipe that `openAgentCoreSession` uses for
// `startupHashes`. Some hosts open the session stores before a session
// exists. The CLI is one example: `bootSessionStores` writes the meta
// record, and the session then takes those stores. Such a host calls this
// function itself (S34 Phase 3).
export type { ComputeStartupHashesInput, StartupHashes } from "../session/startup-hashes.ts"
export { computeStartupHashes } from "../session/startup-hashes.ts"

export {
  MediaResolverAdapter,
  ModeProviderAdapter,
  PromptContributorAdapter,
  SessionPersistenceAdapter,
  ToolRegistryAdapter,
}

/**
 * The Tier-1 assembly seam: build a fully-wired {@link AgentCore} from the host's
 * real collaborators (plugin loader, mode manager, session + blob stores, save
 * echo, turn-attachment producers), binding each to its SDK port through the
 * adapters in this directory.
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
 * each tool_result itself, with the raw-blob pointer + presentation overrides a
 * bare `SessionPersistence.appendToolResult` cannot carry. So the tool executor
 * adapter is the SOLE persister of tool_result records; the
 * {@link SessionPersistenceAdapter} no-ops that one method. Both are wired here.
 *
 * @module host/sdk-adapters/build-agent-core
 */

import {
  combineTurnDrains,
  instantiateTurnAttachments,
  type TurnAttachmentContext,
} from "../../agent/turn-attachments.ts"
import type { AuthResult } from "../../auth/auth.ts"
import type { PluginEventsPort } from "../../bus/plugin-events-port.ts"
import type { StatusPort } from "../../bus/status-port.ts"
import { type CacheTtl, DEFAULT_CACHE_TTL } from "../../cache/cache-ttl.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import type { Message } from "../../llm/messages.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "../../llm/model-info.ts"
import type { SystemPromptOverrides } from "../../llm/system-prompt-overrides.ts"
import type { TransportFn } from "../../llm/transport/types.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { NetworkClient } from "../../network/index.ts"
import { takePendingCompact } from "../../plugins/host/providers/context-compact.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { createRuntime } from "../../runtime/runtime.ts"
import type { Session } from "../../runtime/session.ts"
import { AgentCore } from "../../sdk/agent-core.ts"
import type { EventSink } from "../../sdk/events.ts"
import type { AgentCoreConfig, CompactSourcePort, HostPorts } from "../../sdk/ports.ts"
import type { ToolEnvPort } from "../../sdk/tool-env.ts"
import { type ToolNamePolicy, toolFilterFromNamePolicy } from "../../sdk/tool-filter.ts"
import { type BlobStore, loadBlobStoreConfig } from "../../session/blob-store.ts"
import type { FileTrackingStore } from "../../session/file-tracking-store.ts"
import type { SessionStore } from "../../session/session-store.ts"
import { ToolFeedbackTracker } from "../../tools/feedback-tracker.ts"
import { computeStartupHashes, type StartupHashes } from "../startup/startup-hashes.ts"
import type { CodeHighlighter } from "../ui/formatter/mdstream-code-highlighter.ts"

import { createLifecyclePort } from "./lifecycle-port-adapter.ts"
import { MediaResolverAdapter } from "./media-resolver-adapter.ts"
import { ModeProviderAdapter } from "./mode-provider-adapter.ts"
import {
  PromptContributorAdapter,
  type SaveEchoCollector,
  type TurnAttachmentProducer,
} from "./prompt-contributor-adapter.ts"
import { SessionPersistenceAdapter } from "./session-persistence-adapter.ts"
import { ToolExecutorAdapter } from "./tool-executor-adapter.ts"
import { ToolRegistryAdapter } from "./tool-registry-adapter.ts"

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
  /** Reasoning effort (opaque string; cast to the config union). */
  effort?: string
  /** JSON Schema for `--output-schema` constrained decoding. */
  outputSchema?: object
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
  /** Resolved system-prompt overrides from CLI/env/config. */
  systemPromptOverrides?: SystemPromptOverrides
  /**
   * Interactive transcript sink (tool chrome). When set, ToolExecutorAdapter
   * and AgentCore.transcriptSink both write here. Headless `--json` omits
   * this (no-op). A mutable wrapper lets InteractiveSession rebind per turn.
   */
  writeTranscript?: (line: string) => void
  /**
   * Width and other env values for a spawned tool (spec S24). Defaults to
   * the adapter's own `process.stdout` view when omitted.
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
  /** Optional `· HH:MM:SS` tool-header time hints (interactive only). */
  toolTimeTracker?: import("../../tools/tool-time.ts").ToolTimeTracker | null
  /** Warm, fail-closed syntax highlighter for transcript tool output. */
  codeHighlighter?: CodeHighlighter | null
  /** Rounds between reflection checkpoints (AgentCoreConfig default when unset). */
  reflectionInterval?: number
  /** Reflection pause length in ms (AgentCoreConfig default when unset). */
  reflectionCooldownMs?: number
  /** Retry tunables (clock, backoff ceiling). No attempt or round limit exists. */
  retry?: AgentCoreConfig["retry"]
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
  // Tool registry: core built-ins + plugin tools, with presentation + aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with blob + presentation fidelity), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)

  const writeTranscript = deps.writeTranscript ?? NOOP_WRITE
  const toolExecutor = new ToolExecutorAdapter({
    presentation: toolRegistry.presentation(),
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    // Headless `--json`: no transcript header time-hint (cosmetic only).
    toolTimeTracker: deps.toolTimeTracker ?? null,
    codeHighlighter: deps.codeHighlighter ?? null,
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    writeTranscript,
    lifecycle,
    ...(deps.toolEnv ? { toolEnv: deps.toolEnv } : {}),
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

  const config: AgentCoreConfig = {
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
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
    // Interactive hosts pass writeTranscript; headless `--json` uses no-op.
    transcriptSink: { write: writeTranscript },
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: [promptContributor],
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
    ...(deps.statusPort !== undefined ? { statusPort: deps.statusPort } : {}),
    ...(deps.pluginEvents !== undefined ? { pluginEvents: deps.pluginEvents } : {}),
  }

  const core = new AgentCore(config)
  wireModelInfoSourceIfOpted(deps, () => core.getModel())
  return core
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
  // Tool registry: core built-ins + plugin tools, with presentation + aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with blob + presentation fidelity), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)

  const writeTranscript = deps.writeTranscript ?? NOOP_WRITE
  const toolExecutor = new ToolExecutorAdapter({
    presentation: toolRegistry.presentation(),
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    // Headless `--json`: no transcript header time-hint (cosmetic only).
    toolTimeTracker: deps.toolTimeTracker ?? null,
    codeHighlighter: deps.codeHighlighter ?? null,
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    writeTranscript,
    lifecycle,
    ...(deps.toolEnv ? { toolEnv: deps.toolEnv } : {}),
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
    // Interactive hosts pass writeTranscript; headless `--json` uses no-op.
    transcriptSink: { write: writeTranscript },
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: [promptContributor],
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    lifecycle,
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

  wireModelInfoSourceIfOpted(deps, () => session.agentCore().getModel())

  const startupHashes = await computeStartupHashes({
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
  })

  return Object.assign(session, { startupHashes })
}

/** No-op transcript writer for the headless path. */
function NOOP_WRITE(_line: string): void {}

// Re-export the adapter surface so a host can import the whole Tier-1 binding
// from one module.
export {
  createLifecyclePort,
  LifecyclePortAdapter,
} from "./lifecycle-port-adapter.ts"
export {
  MediaResolverAdapter,
  ModeProviderAdapter,
  PromptContributorAdapter,
  SessionPersistenceAdapter,
  ToolExecutorAdapter,
  ToolRegistryAdapter,
}

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
 * SYNCHRONOUSLY inside `run()`. For byte-parity with the legacy `Agent` (gate
 * G1) the block must be fully resolved BEFORE the run reads it, so it is
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

import type { AuthResult } from "../../auth/auth.ts"
import type { CacheTtl } from "../../cache/cache-ttl.ts"
import type { Message } from "../../llm/messages.ts"
import type { TransportFn } from "../../llm/transport/types.ts"
import type { ModeManager } from "../../modes/modes.ts"
import type { NetworkClient } from "../../network/index.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { AgentCore } from "../../sdk/agent-core.ts"
import type { EventSink } from "../../sdk/events.ts"
import type { AgentCoreConfig } from "../../sdk/ports.ts"
import { type BlobStore, loadBlobStoreConfig } from "../../session/blob-store.ts"
import type { SessionStore } from "../../session/session-store.ts"
import { ToolFeedbackTracker } from "../../tools/feedback-tracker.ts"

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
  /** Provider-neutral service-tier override. */
  serviceTier?: string
  /** Optional `thinking.display` override. */
  thinkingDisplay?: "summarized" | "omitted"
  /** Prompt-cache TTL bucket. */
  cacheTtl?: CacheTtl
  /** Pre-existing conversation to seed the core (resume). */
  initialMessages?: Message[]
  /** Plugin loader (tools + prompt fragments + modes). Null when no plugins. */
  loader: PluginLoader | null
  /** Mode manager. Null when modes are disabled. */
  modeManager: ModeManager | null
  /** Append-only session store. Null when persistence is off. */
  store: SessionStore | null
  /** Per-session raw-output blob store. Null when blob capture is off. */
  blobStore: BlobStore | null
  /** Save-echo collector (memory-saved blocks). Null when memory is absent. */
  saveEcho: SaveEchoCollector | null
  /** Per-turn attachment producers (memory / tasks / fleet), in registry order. */
  turnAttachments: TurnAttachmentProducer[]
  /** Injectable transport (test seam). Defaults to the registry-selected one. */
  sendFn?: TransportFn
  /** Optional network client forwarded to the transport. */
  networkClient?: NetworkClient
  /** Structured event sink (the JsonlEventSink for `--json`/`stream-json`). */
  eventSink?: EventSink
}

/** The config-union effort values AgentCore accepts. */
const EFFORT_VALUES = new Set(["low", "medium", "high", "max"])

/**
 * Narrow the host's opaque effort string to the {@link AgentCoreConfig} union,
 * dropping anything unrecognized (undefined → server default). Mirrors the
 * legacy path's string→union threading.
 */
function toEffort(effort: string | undefined): "low" | "medium" | "high" | "max" | undefined {
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
  const toolExecutor = new ToolExecutorAdapter({
    presentation: toolRegistry.presentation(),
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    // Headless `--json`: no transcript header time-hint (cosmetic only).
    toolTimeTracker: null,
    model: deps.model,
    store: deps.store,
  })

  // Prompt contributor: awaits the plugin prompt block once (parity seam),
  // plus save-echoes and per-turn attachment producers.
  const promptContributor = await PromptContributorAdapter.create({
    loader: deps.loader,
    saveEcho: deps.saveEcho,
    turnAttachments: deps.turnAttachments,
  })

  // Session persistence: user/assistant/note/rewind only (tool_result owned by
  // the executor adapter). Omitted entirely when no store is wired.
  const sessionPersistence = deps.store ? new SessionPersistenceAdapter(deps.store) : undefined

  // Mode provider: the mode-change signal + read-only queries. Tool gating +
  // active-mode stamps live in executeToolRound via the raw manager above.
  const modeProvider = deps.modeManager ? new ModeProviderAdapter(deps.modeManager) : undefined

  // Media resolver: ingest inline @file / image refs using the run's model.
  const mediaResolver = new MediaResolverAdapter(deps.model)

  const config: AgentCoreConfig = {
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    ...(deps.eventSink !== undefined ? { eventSink: deps.eventSink } : {}),
    toolRegistry,
    toolExecutor,
    // The core writes no transcript on the headless path; a no-op sink keeps
    // the required port satisfied without rendering anything.
    transcriptSink: { write: NOOP_WRITE },
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: [promptContributor],
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    // `systemPrompt` + `maxTokens` are vestigial in AgentCoreConfig: run()
    // derives both itself (resolveSystemPromptForModel + resolveMaxOutputTokens).
    // Required by the type, unread at runtime.
    systemPrompt: "",
    maxTokens: 0,
  }

  return new AgentCore(config)
}

/** No-op transcript writer for the headless path. */
function NOOP_WRITE(_line: string): void {}

// Re-export the adapter surface so a host can import the whole Tier-1 binding
// from one module.
export {
  MediaResolverAdapter,
  ModeProviderAdapter,
  PromptContributorAdapter,
  SessionPersistenceAdapter,
  ToolExecutorAdapter,
  ToolRegistryAdapter,
}

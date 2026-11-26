/**
 * Build a fully-wired `AgentCore` with no CLI/host/UI collaborators (spec v2
 * section 2.3, S47).
 *
 * This is `createRuntime`'s equivalent of the CLI's `buildAgentCore`
 * (`src/loops/assemble.ts`): one function that turns a
 * bag of optional collaborators into an `AgentCoreConfig`. It differs from
 * the CLI's factory in what it does NOT do: no plugin loader, no mode
 * manager, no blob store, no memory/tasks attachments, no interactive
 * transcript. Each of those is a host concern; a runtime session that wants
 * one passes its own port (`toolRegistry`, `toolExecutor`,
 * `promptContributors`, `modeProvider`, `mediaResolver`).
 * With none, the core still runs a plain, tool-free turn.
 *
 * @module runtime/build-core
 */

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import { NOOP_PLUGIN_EVENTS, type PluginEventsPort } from "../bus/plugin-events-port.ts"
import { NOOP_STATUS_PORT, type StatusPort } from "../bus/status-port.ts"
import type { ThinkingHistoryMode } from "../cache/cache-flags.ts"
import type { CacheTtl } from "../cache/cache-ttl.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { Message } from "../llm/messages.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import type { RetryPolicyOptions } from "../llm/transport/retry-policy.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { NetworkClient } from "../network/index.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { EventSink } from "../sdk/events.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type {
  AgentCoreConfig,
  HostPorts,
  MediaResolver,
  ModeProvider,
  PromptContributor,
  SessionPersistence,
  ToolAdvertisementFilter,
  ToolExecutor,
  ToolRegistry,
} from "../sdk/ports.ts"
import type { RoundCheckpoint } from "../sdk/round-checkpoint.ts"
import type { SwitchTargetCredentialNames } from "../sdk/target-credential-names.ts"

import { hostSessionFacts } from "./host-session-facts.ts"
import { EMPTY_TOOL_REGISTRY, NO_TOOLS_EXECUTOR } from "./noop-tools.ts"

/** Everything {@link buildRuntimeCore} needs to construct one session's `AgentCore`. */
export interface RuntimeCoreDeps {
  auth: AuthResult
  model: string
  providerId?: string
  credentialName?: string
  /** Host credential-name lookup for `switchTarget` (`AgentCoreConfig.credentialNames`). */
  credentialNames?: SwitchTargetCredentialNames
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  outputSchema?: object
  speed?: "normal" | "fast"
  serviceTier?: string
  thinkingDisplay?: "summarized" | "omitted"
  cacheTtl?: CacheTtl
  /** F1 anchor marker flag (`AgentCoreConfig.cacheAnchor`). Default ON, only `false` turns it off. */
  cacheAnchor?: boolean
  /** F2 thinking-history mode (`AgentCoreConfig.thinkingHistory`). */
  thinkingHistory?: ThinkingHistoryMode
  initialMessages?: Message[]
  /** Round checkpoint to resume an unfinished turn from (S50). */
  initialCheckpoint?: RoundCheckpoint
  systemPrompt?: string
  maxTokens?: number
  systemPromptOverrides?: SystemPromptOverrides
  retry?: RetryPolicyOptions
  /** Concurrency cap of a wave (`AgentCoreConfig.maxConcurrentToolCalls`). Default 10. */
  maxConcurrentToolCalls?: number
  sendFn?: TransportFn
  networkClient?: NetworkClient
  toolRegistry?: ToolRegistry
  toolFilter?: ToolAdvertisementFilter
  toolExecutor?: ToolExecutor
  sessionPersistence?: SessionPersistence
  promptContributors?: PromptContributor[]
  /** Synthetic text providers (G3), forwarded to AgentCore. The runtime has no loader, so a host passes them. */
  syntheticTextProviders?: readonly SyntheticTextProvider[]
  /** A ready synthetic text resolver (the loader's), forwarded to AgentCore. */
  syntheticTextResolver?: AgentCoreConfig["syntheticTextResolver"]
  /** The one sideband API of the session (e.g. the loader's `sideband()`), forwarded to AgentCore. */
  sideband?: AgentCoreConfig["sideband"]
  /** Built-in tool text providers, forwarded to AgentCore (not read yet). */
  toolTextProviders?: readonly ToolTextProvider[]
  modeProvider?: ModeProvider
  mediaResolver?: MediaResolver
  eventSink?: EventSink
  /**
   * Policy veto/rewrite port (`tool.willInvoke`, `message.willSend`, ...).
   * Default `NOOP_LIFECYCLE`: no policy hooks run. A host with its own
   * plugin/hook bus (e.g. the CLI's `createLifecyclePort(loader.hooks())`)
   * passes its adapter here so engine-internal lifecycle seams reach it —
   * `buildRuntimeCore` has no plugin loader of its own to build one from.
   */
  lifecycle?: LifecyclePort
  /**
   * Host facts for the loop hook payloads (`AgentCoreConfig.sessionFacts`).
   * Default {@link hostSessionFacts}. A `Session` passes its own default:
   * the host facts with the session id as `sid`.
   */
  sessionFacts?: AgentCoreConfig["sessionFacts"]
  /** The session's diagnostics scope (`DiagnosticsHub.session(id)`). */
  diagnostics?: Diagnostics
  /** The four optional host ports (S17), always fully populated by `runtime/session.ts`. */
  ports: HostPorts
  statusPort?: StatusPort
  pluginEvents?: PluginEventsPort
}

/** Build one session's `AgentCore`. Synchronous: nothing here needs an await. */
export function buildRuntimeCore(deps: RuntimeCoreDeps): AgentCore {
  const config: AgentCoreConfig = {
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(deps.credentialNames !== undefined ? { credentialNames: deps.credentialNames } : {}),
    ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.cacheAnchor !== undefined ? { cacheAnchor: deps.cacheAnchor } : {}),
    ...(deps.thinkingHistory !== undefined ? { thinkingHistory: deps.thinkingHistory } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
    ...(deps.maxConcurrentToolCalls !== undefined
      ? { maxConcurrentToolCalls: deps.maxConcurrentToolCalls }
      : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    ...(deps.eventSink !== undefined ? { eventSink: deps.eventSink } : {}),
    ...(deps.diagnostics !== undefined ? { diagnostics: deps.diagnostics } : {}),
    toolRegistry: deps.toolRegistry ?? EMPTY_TOOL_REGISTRY,
    ...(deps.toolFilter ? { toolFilter: deps.toolFilter } : {}),
    toolExecutor: deps.toolExecutor ?? NO_TOOLS_EXECUTOR,
    ...(deps.sessionPersistence ? { sessionPersistence: deps.sessionPersistence } : {}),
    ...(deps.promptContributors ? { promptContributors: deps.promptContributors } : {}),
    ...(deps.syntheticTextProviders ? { syntheticTextProviders: deps.syntheticTextProviders } : {}),
    ...(deps.syntheticTextResolver ? { syntheticTextResolver: deps.syntheticTextResolver } : {}),
    ...(deps.sideband ? { sideband: deps.sideband } : {}),
    ...(deps.toolTextProviders ? { toolTextProviders: deps.toolTextProviders } : {}),
    ...(deps.modeProvider ? { modeProvider: deps.modeProvider } : {}),
    ...(deps.mediaResolver ? { mediaResolver: deps.mediaResolver } : {}),
    lifecycle: deps.lifecycle ?? NOOP_LIFECYCLE,
    // Default: the process session id, sub-agent env, and process.cwd().
    sessionFacts: deps.sessionFacts ?? hostSessionFacts,
    // Vestigial, like the CLI factory's own config: `run()` derives both
    // itself (resolveSystemPromptForModel + resolveMaxOutputTokens).
    systemPrompt: deps.systemPrompt ?? "",
    maxTokens: deps.maxTokens ?? 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    ports: deps.ports,
    statusPort: deps.statusPort ?? NOOP_STATUS_PORT,
    pluginEvents: deps.pluginEvents ?? NOOP_PLUGIN_EVENTS,
  }
  return new AgentCore(config)
}

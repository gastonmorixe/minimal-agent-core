/**
 * Build a fully-wired `AgentCore` with no CLI/host/UI collaborators (spec v2
 * section 2.3, S47).
 *
 * This is `createRuntime`'s equivalent of the CLI's `buildAgentCore`
 * (`src/adapters/build-agent-core.ts`): one function that turns a
 * bag of optional collaborators into an `AgentCoreConfig`. It differs from
 * the CLI's factory in what it does NOT do: no plugin loader, no mode
 * manager, no blob store, no memory/tasks attachments, no interactive
 * transcript. Each of those is a host concern; a runtime session that wants
 * one passes its own port (`toolRegistry`, `toolExecutor`,
 * `promptContributors`, `modeProvider`, `mediaResolver`, `transcriptSink`).
 * With none, the core still runs a plain, tool-free turn.
 *
 * @module runtime/build-core
 */

import type { AuthResult } from "../auth/auth.ts"
import { NOOP_PLUGIN_EVENTS, type PluginEventsPort } from "../bus/plugin-events-port.ts"
import { NOOP_STATUS_PORT, type StatusPort } from "../bus/status-port.ts"
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
  TranscriptSink,
} from "../sdk/ports.ts"
import type { RoundCheckpoint } from "../sdk/round-checkpoint.ts"

import { EMPTY_TOOL_REGISTRY, NO_TOOLS_EXECUTOR } from "./noop-tools.ts"

/** Core never writes to stdout itself (S25); a session with no transcript sink of its own gets this. */
const NOOP_TRANSCRIPT: TranscriptSink = { write: () => {} }

/** Everything {@link buildRuntimeCore} needs to construct one session's `AgentCore`. */
export interface RuntimeCoreDeps {
  auth: AuthResult
  model: string
  providerId?: string
  credentialName?: string
  effort?: "low" | "medium" | "high" | "max"
  outputSchema?: object
  speed?: "normal" | "fast"
  serviceTier?: string
  thinkingDisplay?: "summarized" | "omitted"
  cacheTtl?: CacheTtl
  initialMessages?: Message[]
  /** Round checkpoint to resume an unfinished turn from (S50). */
  initialCheckpoint?: RoundCheckpoint
  systemPrompt?: string
  maxTokens?: number
  systemPromptOverrides?: SystemPromptOverrides
  reflectionInterval?: number
  reflectionCooldownMs?: number
  retry?: RetryPolicyOptions
  sendFn?: TransportFn
  networkClient?: NetworkClient
  toolRegistry?: ToolRegistry
  toolFilter?: ToolAdvertisementFilter
  toolExecutor?: ToolExecutor
  transcriptSink?: TranscriptSink
  sessionPersistence?: SessionPersistence
  promptContributors?: PromptContributor[]
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
    ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    ...(deps.eventSink !== undefined ? { eventSink: deps.eventSink } : {}),
    ...(deps.diagnostics !== undefined ? { diagnostics: deps.diagnostics } : {}),
    toolRegistry: deps.toolRegistry ?? EMPTY_TOOL_REGISTRY,
    ...(deps.toolFilter ? { toolFilter: deps.toolFilter } : {}),
    toolExecutor: deps.toolExecutor ?? NO_TOOLS_EXECUTOR,
    transcriptSink: deps.transcriptSink ?? NOOP_TRANSCRIPT,
    ...(deps.sessionPersistence ? { sessionPersistence: deps.sessionPersistence } : {}),
    ...(deps.promptContributors ? { promptContributors: deps.promptContributors } : {}),
    ...(deps.modeProvider ? { modeProvider: deps.modeProvider } : {}),
    ...(deps.mediaResolver ? { mediaResolver: deps.mediaResolver } : {}),
    lifecycle: deps.lifecycle ?? NOOP_LIFECYCLE,
    // Vestigial, like the CLI factory's own config: `run()` derives both
    // itself (resolveSystemPromptForModel + resolveMaxOutputTokens).
    systemPrompt: deps.systemPrompt ?? "",
    maxTokens: deps.maxTokens ?? 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.reflectionInterval !== undefined
      ? { reflectionInterval: deps.reflectionInterval }
      : {}),
    ...(deps.reflectionCooldownMs !== undefined
      ? { reflectionCooldownMs: deps.reflectionCooldownMs }
      : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    ports: deps.ports,
    statusPort: deps.statusPort ?? NOOP_STATUS_PORT,
    pluginEvents: deps.pluginEvents ?? NOOP_PLUGIN_EVENTS,
  }
  return new AgentCore(config)
}

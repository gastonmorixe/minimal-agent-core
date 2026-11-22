/**
 * Capability-host factory — builds the frozen {@link PluginHost} a
 * plugin receives as `ctx.host`, populated ONLY with the namespaces its
 * manifest declared (`capabilities: ["sessions:read", ...]`).
 *
 * Facade over the provider adapters in `./providers/*`. The grant model is
 * deny-by-default: an undeclared namespace is `undefined` on the host
 * object, so a plugin that forgot to declare `sessions:read` cannot reach
 * the session store even though the code for it is loaded in-process.
 *
 * The returned object is deep-frozen so a misbehaving plugin can't mutate
 * the shared surface and bleed state into a sibling handler (same rule as
 * `createAgentContext` (in `../agent-context.ts`)).
 *
 * @module plugins/host/factory
 */

import {
  resolveAgentHome,
  resolveNetDbgDir,
  resolveSessionsDir,
} from "@minimal-agent/core/plugin-api/utils/agent-paths"
import type { UsagePeriod } from "@minimal-agent/core/plugin-api/utils/usage-report"

import { resolveStartupAuth } from "../../auth/provider-auth.ts"
import type { PluginLogger } from "../../bus/diagnostic-bus.ts"
import { processDiagnostics } from "../../diagnostics/hub.ts"
import { currentSessionScope } from "../../infra/session-scope.ts"
import { resolveUtilityModel } from "../../llm/model-info.ts"
import {
  findModel,
  findModelByTags,
  findModelForProvider,
  getDefaultModelId,
  listRegisteredModels,
  registerModel,
  resolveModel,
  setDefaultModelId,
} from "../../llm/model-registry.ts"
import { resolveProviderSessionInfo } from "../../llm/provider-session.ts"
import { canonicalSendFn } from "../../llm/transport/canonical-send.ts"
import type { NetworkClient } from "../../network/client.ts"
import { defaultNetworkClient } from "../../network/index.ts"
import { createNetworkObserveApi } from "../../network/wire-observer.ts"
import { aggregateAllPeriods, aggregateUsage, scanUsageEvents } from "../../quota/usage-stats.ts"
import { getSessionTokens, runAsAuxUsage } from "../../session/session-tokens.ts"
import type { SidebandReader } from "../../sideband/types.ts"
import type { RunModeFact } from "../types.ts"

import type { CapabilityToken, PluginHost } from "./capabilities.ts"
import { createBlobsReadApi } from "./providers/blobs-read.ts"
import { createContextCompactApi } from "./providers/context-compact.ts"
import { createLlmSideRequest, type LlmSideDeps } from "./providers/llm-side.ts"
import {
  createSessionFilesApi,
  isSafeSessionFileName,
  SESSION_FILE_NAME_RE,
} from "./providers/session-files.ts"
import { createSessionMetaApi } from "./providers/sessions-meta.ts"
import { createSessionsReadApi } from "./providers/sessions-read.ts"
import { createSessionsWriteApi, type HistoryEditCommitNotice } from "./providers/sessions-write.ts"
import { createTransportRegistryApi } from "./transport-registry.ts"

/** Inputs for {@link buildPluginHost}. All injectable for tests. */
export interface BuildHostOptions {
  /** Capability namespaces the plugin's manifest declared. */
  capabilities: readonly string[]
  /** Plugin-scoped logger (granted under the `logger` token). */
  logger?: PluginLogger
  /** Sessions-directory override (tests). */
  sessionsDir?: string
  /** Current process session. Write capabilities are bound to this SID only. */
  activeSessionId?: string
  /** Fallible reload validation that runs before the durable history-edit cut. */
  beforeHistoryEditCommit?: (
    input: import("./providers/sessions-write.ts").PreparedHistoryEditCommit,
  ) => Promise<void>
  /** Host reload coordinator invoked after a durable history-edit cut. */
  onHistoryEditCommitted?: (notice: HistoryEditCommitNotice) => Promise<void>
  /** Synchronous availability guard checked before the durable cut. */
  isHistoryEditCommitReady?: () => boolean
  /** Clock override (tests). */
  now?: () => number
  /**
   * Client the `network:observe` capability attaches to. Default: the process
   * default client, the one every provider adapter gets on `RunContext`.
   */
  networkClient?: Pick<NetworkClient, "addObserver">
  /** Plugin name, for the `network:observe` failure diagnostic. */
  pluginName?: string
  /**
   * The manifest id of the plugin. `sessions:files` needs it: it is the name
   * of the plugin dir under `<sid>.files/`. Without a safe id the capability
   * is not granted (an unsafe id emits one warning).
   */
  pluginId?: string
  /**
   * Environment the `paths` capability resolves against. Defaults to
   * `process.env`, which carries the boot-published `MINIMAL_AGENT_HOME`.
   * Injectable so a test can drive path resolution without mutating the real
   * environment.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Dependencies of `llm.request()` (`llm:complete`): the one-attempt
   * transport, the auth resolver, the session provider and the host shutdown
   * signal. Injectable for tests; the defaults are the real ones.
   */
  llmSide?: LlmSideDeps
  /**
   * `sessions:meta` and `sessions:files`: extra sids that this process owns (for example the live
   * session set of a host with many sessions). The scope sid and the process
   * sid are always owned. Never the cached {@link activeSessionId}.
   */
  isOwnedSession?: (sid: string) => boolean
  /**
   * Host shutdown signal for `llm.request()`: when it aborts, each side call
   * in flight aborts. Overridden by `llmSide.shutdownSignal`.
   */
  shutdownSignal?: AbortSignal
  /**
   * The host run-mode fact, read at each side call. Its `providerId` is the
   * session provider of `llm.request()` when no session scope gives one.
   * Overridden by `llmSide.sessionProviderId`.
   */
  runMode?: () => RunModeFact | undefined
  /**
   * The sideband reader of the session (the loader's `sideband()`). The
   * `sessions:read` capability uses it to find runtime attachment blocks,
   * and `sessions:meta` to remove tag parts from a title (design step 8).
   * Default `NO_SIDEBAND`.
   */
  sideband?: SidebandReader
  /**
   * `true` for a host with no session files on disk (memory-only). Then the
   * capabilities that write into the sessions dir (`sessions:files` and
   * `sessions:meta`) are not granted, and each plugin that declares one
   * gets one warning. Default `false`.
   */
  noSessionFiles?: boolean
}

/** The capability-host options that the plugin loader passes through to {@link buildPluginHost}. */
export type LoaderHostOptions = Pick<
  BuildHostOptions,
  "sessionsDir" | "shutdownSignal" | "runMode" | "isOwnedSession" | "noSessionFiles"
>

/**
 * Build a frozen capability host for one plugin. Unknown capability
 * strings are ignored here (manifest validation rejects them earlier;
 * tolerating them keeps this factory total for ad-hoc callers).
 */
export function buildPluginHost(opts: BuildHostOptions): PluginHost {
  const granted = new Set(opts.capabilities)
  const has = (t: CapabilityToken) => granted.has(t)
  const diskOk = sessionDiskOk(opts, granted)

  const host: PluginHost = Object.freeze({
    capabilities: Object.freeze(
      [...granted].filter((c): c is CapabilityToken => typeof c === "string"),
    ),
    ...(has("sessions:read")
      ? {
          sessions: Object.freeze(
            createSessionsReadApi({
              dir: opts.sessionsDir,
              ...(opts.sideband ? { sideband: opts.sideband } : {}),
            }),
          ),
        }
      : {}),
    ...(has("sessions:write") && opts.activeSessionId
      ? {
          sessionsWrite: Object.freeze(
            createSessionsWriteApi({
              dir: opts.sessionsDir,
              activeSessionId: opts.activeSessionId,
              beforeCommit: opts.beforeHistoryEditCommit,
              onCommitted: opts.onHistoryEditCommitted,
              canCommit: opts.isHistoryEditCommitReady,
            }),
          ),
        }
      : {}),
    ...(has("sessions:meta") && diskOk
      ? {
          sessionMeta: Object.freeze(
            createSessionMetaApi({
              ...(opts.sessionsDir ? { dir: opts.sessionsDir } : {}),
              ...(opts.now ? { now: opts.now } : {}),
              ...(opts.isOwnedSession ? { isOwnedSession: opts.isOwnedSession } : {}),
              ...(opts.sideband ? { sideband: opts.sideband } : {}),
            }),
          ),
        }
      : {}),
    ...(has("sessions:files") && diskOk && sessionFilesIdOk(opts)
      ? {
          sessionFiles: Object.freeze(
            createSessionFilesApi({
              sessionsDir: opts.sessionsDir ?? resolveSessionsDir(opts.env),
              pluginId: opts.pluginId!,
              // Always given, so the full owned-session rule applies: the
              // scope sid and the process sid are owned, plus the host set.
              isOwnedSession: opts.isOwnedSession ?? (() => false),
            }),
          ),
        }
      : {}),
    ...(has("blobs:read")
      ? { blobs: Object.freeze(createBlobsReadApi({ dir: opts.sessionsDir })) }
      : {}),
    ...(has("models:read")
      ? {
          models: Object.freeze({
            find: findModel,
            findForProvider: findModelForProvider,
            resolve: resolveModel,
            list: listRegisteredModels,
            findByTags: findModelByTags,
            defaultModelId: getDefaultModelId,
            // SPEC §4.1-4.2: the cheap model of a provider (default: the live
            // session provider), under the default price ceiling. Never the
            // session model.
            utilityFor: (providerId?: string) => {
              const id = providerId || liveProviderId(opts)
              return id ? resolveUtilityModel(id) : undefined
            },
          }),
        }
      : {}),
    ...(has("models:register")
      ? {
          modelsRegistry: Object.freeze({
            register: registerModel,
            setDefault: setDefaultModelId,
          }),
        }
      : {}),
    ...(has("session-info:read")
      ? {
          sessionInfo: Object.freeze({
            providerInfo: (modelId: string, o?: { signal?: AbortSignal; providerId?: string }) =>
              resolveProviderSessionInfo(modelId, {
                ...(o?.signal ? { signal: o.signal } : {}),
                ...(o?.providerId ? { providerId: o.providerId } : {}),
              }),
            // Project the core SessionTokens onto the neutral view (identical
            // shape minus the doc-only intent; explicit field copy keeps the
            // capability's surface pinned even if core adds internal fields).
            tokens: () => {
              const t = getSessionTokens()
              return {
                input: t.input,
                output: t.output,
                cacheRead: t.cacheRead,
                cacheCreate: t.cacheCreate,
                cacheCreate1h: t.cacheCreate1h,
                thinking: t.thinking,
                webSearchRequests: t.webSearchRequests,
                total: t.total,
                turns: t.turns,
                contextSize: t.contextSize,
                contextSizeEstimated: t.contextSizeEstimated,
              }
            },
          }),
        }
      : {}),
    ...(has("llm:complete")
      ? {
          llm: Object.freeze({
            // One-shot, non-streaming completion. Resolve credentials, build a
            // non-streaming SendOptions, run the transport, and drain the
            // generator to a single string. The plugin never touches auth,
            // canonicalSendFn, or the SendOptions shape.
            // `complete()` usage goes to the aux bucket (SPEC §3b test 4): it
            // never changes `turns` or `contextSize`.
            complete: (req: {
              model?: string
              system: string
              userText: string
              maxTokens?: number
              timeoutMs?: number
            }): Promise<string> =>
              runAsAuxUsage({ purpose: "title", ...(req.model ? { model: req.model } : {}) }, () =>
                completeOnce(req),
              ),
            // One bounded side call with a rich result (SPEC §3a M1, M2, M6).
            request: createLlmSideRequest(llmSideDeps(opts)),
          }),
        }
      : {}),
    ...(has("usage:read")
      ? {
          usage: Object.freeze({
            // One disk scan per call; the host owns scanning + pricing so the
            // plugin never imports usage-stats (which reaches pricing +
            // model-registry + session store). `sessionsDir` override honored
            // for tests via scanUsageEvents(dir).
            report: (period: UsagePeriod) =>
              aggregateUsage(scanUsageEvents(opts.sessionsDir), period),
            reports: () => aggregateAllPeriods(scanUsageEvents(opts.sessionsDir)),
          }),
        }
      : {}),
    ...(has("paths")
      ? {
          paths: Object.freeze({
            home: () => resolveAgentHome(opts.env),
            sessionsDir: () => resolveSessionsDir(opts.env),
            netDbgDir: () => resolveNetDbgDir(opts.env),
          }),
        }
      : {}),
    ...(has("context:compact") ? { compact: Object.freeze(createContextCompactApi()) } : {}),
    ...(has("transport:registry")
      ? { transportRegistry: Object.freeze(createTransportRegistryApi()) }
      : {}),
    ...(has("network:observe")
      ? {
          network: Object.freeze(
            createNetworkObserveApi(opts.networkClient ?? defaultNetworkClient, {
              ...(opts.pluginName ? { owner: opts.pluginName } : {}),
            }),
          ),
        }
      : {}),
    ...(has("clock")
      ? {
          clock: Object.freeze({
            now: opts.now ?? (() => Date.now()),
            iso: () => new Date((opts.now ?? (() => Date.now()))()).toISOString(),
          }),
        }
      : {}),
    ...(has("logger") && opts.logger ? { logger: opts.logger } : {}),
  })
  return host
}

/** Plugin ids that already got the unsafe-id diagnostic of `sessions:files`. */
const warnedSessionFilesIds = new Set<string>()

/** Plugin ids that already got the memory-only diagnostic. */
const warnedNoDiskIds = new Set<string>()

/** The capabilities that write into the sessions dir. */
const SESSION_DISK_CAPS = ["sessions:files", "sessions:meta"] as const

/**
 * False when the host has no session files on disk (`noSessionFiles`). Then
 * `sessions:files` and `sessions:meta` are not granted. Each plugin that
 * declares one of them gets one warning (the same path as the unsafe-id
 * warning of `sessions:files`).
 */
function sessionDiskOk(opts: BuildHostOptions, granted: ReadonlySet<string>): boolean {
  if (!opts.noSessionFiles) return true
  const denied = SESSION_DISK_CAPS.filter((c) => granted.has(c))
  const id = opts.pluginId ?? opts.pluginName
  if (denied.length === 0 || !id || warnedNoDiskIds.has(id)) return false
  warnedNoDiskIds.add(id)
  const message =
    `plugin "${id}" declares ${denied.join(", ")}, but this host keeps no session ` +
    `files on disk (memory-only): capability not granted`
  try {
    if (opts.logger)
      opts.logger.warn("host.sessions-files", message, {
        pluginId: id,
        capabilities: denied.join(","),
      })
    else
      processDiagnostics().warn("plugin.host.sessions-files", message, {
        pluginId: id,
        capabilities: denied.join(","),
      })
  } catch {
    // A diagnostic must never break the host build.
  }
  return false
}

/**
 * True when the plugin id is safe for the `sessions:files` dir name. A
 * declared capability with an unsafe id (for example longer than 64 chars)
 * is not granted, and emits one warning for each plugin id. No id at all (an
 * ad-hoc caller) is a silent no-grant.
 */
function sessionFilesIdOk(opts: BuildHostOptions): boolean {
  const id = opts.pluginId
  if (!id) return false
  if (isSafeSessionFileName(id)) return true
  if (!warnedSessionFilesIds.has(id)) {
    warnedSessionFilesIds.add(id)
    const message =
      `plugin "${id}" declares sessions:files, but its id is not safe for the ` +
      `files dir name (${SESSION_FILE_NAME_RE}, no ".."): capability not granted`
    try {
      if (opts.logger) opts.logger.warn("host.sessions-files", message, { pluginId: id })
      else processDiagnostics().warn("plugin.host.sessions-files", message, { pluginId: id })
    } catch {
      // A diagnostic must never break the host build.
    }
  }
  return false
}

/**
 * Deps of `llm.request()`: the host shutdown signal, and the session provider
 * (the session scope target, then the run-mode fact, then the provider of the
 * default model, which is the C3 default). `opts.llmSide` wins for each field.
 */
function llmSideDeps(opts: BuildHostOptions): LlmSideDeps {
  return {
    sessionProviderId: () => sessionProviderId(opts.runMode),
    ...(opts.shutdownSignal ? { shutdownSignal: opts.shutdownSignal } : {}),
    ...opts.llmSide,
  }
}

/** The live session provider: the `llmSide` override first, then {@link sessionProviderId}. */
function liveProviderId(opts: BuildHostOptions): string | undefined {
  try {
    const override = opts.llmSide?.sessionProviderId?.()
    if (override) return override
  } catch {
    // A throwing override: use the default lookup below.
  }
  return sessionProviderId(opts.runMode)
}

function sessionProviderId(
  runMode: (() => RunModeFact | undefined) | undefined,
): string | undefined {
  try {
    const scoped = currentSessionScope()?.queryTarget().providerId
    if (scoped) return scoped
  } catch {
    // A scope with no live target: use the run-mode fact below.
  }
  try {
    const fromRun = runMode?.()?.providerId
    if (fromRun) return fromRun
  } catch {
    // A throwing getter: use the default model below.
  }
  try {
    return findModel(getDefaultModelId())?.providerId
  } catch {
    return undefined
  }
}

/**
 * One `llm.complete()` call: resolve the credential of the model's own
 * provider (decision 39), send with the retrying transport, drain to text.
 * The behavior is unchanged; the caller runs it in an aux usage frame.
 */
async function completeOnce(req: {
  model?: string
  system: string
  userText: string
  maxTokens?: number
  timeoutMs?: number
}): Promise<string> {
  const entry = resolveModel(req.model ?? getDefaultModelId())
  const auth = await resolveStartupAuth(entry.providerId, entry.id)
  const gen = canonicalSendFn({
    auth,
    ...(req.model ? { model: req.model } : {}),
    system: [{ type: "text", text: req.system }],
    messages: [{ role: "user", content: [{ type: "text", text: req.userText }] }],
    maxTokens: req.maxTokens ?? 8192,
    stream: false,
    requestType: "title",
  })
  let text = ""
  const run = (async () => {
    while (true) {
      const { value, done } = await gen.next()
      if (done) return text
      text += value
    }
  })()
  if (req.timeoutMs === undefined) return run
  return await Promise.race([
    run,
    new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error(`llm.complete timed out after ${req.timeoutMs}ms`)),
        req.timeoutMs,
      ),
    ),
  ])
}

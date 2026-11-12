/**
 * Aggregate host boot (WEB-PLUGINS-001, decision 19).
 *
 * {@link bootHost} composes the public boot pieces in the same order as the
 * CLI entry point (minimal-agent-cli `src/main.ts`), so every host (the CLI,
 * the web server) can share one boot order:
 *
 *   1. Publish the agent home into `MINIMAL_AGENT_HOME` and read the user
 *      config.
 *   2. Clone the first-party plugins into the host's sync dir (first run
 *      only). Only when the caller passes `pluginSync`.
 *   3. Discover and activate provider plugins (`provider.json`). Check each
 *      provider plugin dir for missing `node_modules` (Q-3).
 *   4. Resolve the plugin enable overrides (config, env, options).
 *   5. Load the manifest plugins with {@link PluginLoader.load}, then wait
 *      for the async prompt fragments, because they can add dynamic tools.
 *   6. Build the tool registry and the default-model tool executor. The
 *      interactive collaborators (mode manager, stores, highlighter, time
 *      tracker) are null.
 *   7. Return the aggregate, with `toolExecutorFor(modelId)` and
 *      `resolveAuth(modelId, providerId?, credentialName?)`.
 *
 * The host picks no default credential and no default model for a session.
 * Each session names its model and its credential. `resolveAuth` takes an
 * optional `credentialName` and passes it to `resolveStartupAuth`.
 * `listCredentials` lists the stored credentials by provider.
 *
 * The host computes every plugin root and passes them in (S40). Core knows
 * no default plugin location.
 *
 * The boot has no terminal I/O and no ANSI output. Problems that a host must
 * show go into {@link BootedHost.diagnostics}. The boot does not throw for a
 * bad plugin.
 *
 * Note: the model and provider registries are process-wide. A second boot
 * in the same process adds to the same registries.
 *
 * @module adapters/host-boot
 */

import { AGENT_HOME_ENV, resolveAgentHome } from "@minimal-agent/core/plugin-api/utils/agent-paths"

import type { AuthResult } from "../auth/auth.ts"
import {
  type CredentialedProvider,
  discoverCredentialedProviders,
} from "../auth/auth-strategies.ts"
import { resolveStartupAuth } from "../auth/provider-auth.ts"
import { Severity } from "../bus/diagnostic-bus.ts"
import type { StatusPort } from "../bus/status-port.ts"
import {
  loadPluginEnabledOverrides,
  loadPluginPromptsConfig,
  loadUserConfig,
} from "../config/config.ts"
import { createDiagnostics, type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import { buildModelInfoSnapshot, buildSubagentModelRecommendations } from "../llm/model-info.ts"
import {
  findModel,
  findModelForProvider,
  getDefaultModelId,
  listRegisteredProviders,
} from "../llm/model-registry.ts"
import {
  activateDiscoveredProviders,
  registerDiscoveredProviders,
} from "../llm/provider-discovery.ts"
import { ToolExecutorAdapter } from "../loops/assemble.ts"
import { createAgentContext } from "../plugins/agent-context.ts"
import { bootstrapUserPlugins } from "../plugins/auto-plugins.ts"
import { installHostCoreResolver } from "../plugins/loader/host-core-resolver.ts"
import { type PluginRoots, providerRootsOf } from "../plugins/loader/roots.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { resolvePluginEnabledOverrides } from "../plugins/plugin-enable-resolution.ts"
import { resolveEffectivePlatform } from "../plugins/plugin-platform-resolution.ts"
import {
  type PluginPromptSuppression,
  resolvePluginPromptSuppression,
} from "../plugins/plugin-prompt-resolution.ts"
import type { ToolExecutor, ToolRegistry } from "../sdk/ports.ts"
import { loadBlobStoreConfig } from "../session/blob-store.ts"
import { getSessionId } from "../session/session-id.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import { TOOL_DEFINITIONS } from "../tools/tool-definitions.ts"

import { createLifecyclePort } from "./lifecycle-port-adapter.ts"
import { listBootedModels, type ModelRow } from "./model-view.ts"
import { findMissingPluginDeps, type HostBootDiagnostic } from "./plugin-deps.ts"
import { ToolRegistryAdapter } from "./tool-registry-adapter.ts"

/** One stored credential by provider. Re-exported here so hosts use the existing host-boot path. */
export type { CredentialedProvider } from "../auth/auth-strategies.ts"

/** Inputs for {@link bootHost}. Every field is optional. */
export interface HostBootOptions {
  /**
   * Agent home. Default: `resolveAgentHome()` (`MINIMAL_AGENT_HOME`, else
   * `~/.minimal-agent`). The boot writes it into `MINIMAL_AGENT_HOME`, so the
   * config and auth readers use it too.
   */
  readonly home?: string
  /**
   * Manifest plugin roots by tier, computed by the host (S40). Each
   * directory holds plugin package directories directly. Default: no
   * roots, so no manifest plugin loads.
   */
  readonly pluginRoots?: PluginRoots
  /**
   * Provider plugin roots (`provider.json`), first wins on an id collision.
   * Default: `providerRootsOf(pluginRoots)` (embedded roots, then user
   * roots).
   */
  readonly providerRoots?: readonly string[]
  /**
   * First-run plugin clone. The boot clones `repoUrl` into `targetDir`
   * once, when the dir holds no plugin yet. `MINIMAL_AGENT_PLUGINS_REPO`
   * and config `pluginsRepo` override `repoUrl`.
   * `MINIMAL_AGENT_NO_PLUGIN_SYNC=1` and config `pluginSync: false` turn
   * the clone off. Default: no clone. Pass `targetDir` as a user root in
   * `pluginRoots` too, so the cloned plugins load.
   */
  readonly pluginSync?: { readonly targetDir: string; readonly repoUrl: string }
  /** Plugin ids to disable, on top of config and env. */
  readonly disablePlugins?: readonly string[]
  /** Plugin ids to enable, on top of config and env. */
  readonly enablePlugins?: readonly string[]
  /**
   * Per-plugin prompt-text suppression, on top of
   * `plugins.prompts` in the config file and
   * `MINIMAL_AGENT_PLUGIN_PROMPTS`. Default: the resolved config and env,
   * which default to nothing suppressed.
   */
  readonly pluginPrompts?: PluginPromptSuppression
  /** Model id for the plugin agent context. Default: the registry default. */
  readonly model?: string
  /** Host version for the plugin agent context. Default: `"0.0.0"`. */
  readonly version?: string
  /**
   * Live status port for the `running_tool` row of each tool call. Every
   * executor of this boot uses it, unless {@link BootedHost.toolExecutorFor}
   * gets its own port. Default: none, so no tool status row.
   */
  readonly statusPort?: StatusPort
  /**
   * Contract ids that need exactly one provider plugin (G11, warn mode).
   * A failure records a `boot.contract_missing` or `boot.contract_duplicate`
   * diagnostic and the boot continues. Default: none.
   */
  readonly requiredContracts?: readonly string[]
  /**
   * Accept a boot with zero plugins. With `true`, a boot that loads no
   * plugin skips the {@link requiredContracts} check. Default: `false`.
   */
  readonly allowBareCore?: boolean
}

/** Per-executor options for {@link BootedHost.toolExecutorFor}. */
export interface ToolExecutorForOptions {
  /** Live status port for this executor. Default: the boot `statusPort`. */
  readonly statusPort?: StatusPort
}

/** One loaded manifest plugin. */
export interface PluginSummary {
  /** Manifest id. */
  readonly id: string
}

/** The result of {@link bootHost}. */
export interface BootedHost {
  /** Resolved agent home. */
  readonly home: string
  /** Registered provider ids, in registration order. */
  readonly providers: readonly string[]
  /** Loaded manifest plugins, in load order. */
  readonly plugins: readonly PluginSummary[]
  /** Plugin ids that config, env, or options disabled. Sorted. */
  readonly disabledPluginIds: readonly string[]
  /** Registered models at boot time. */
  readonly models: readonly ModelRow[]
  /** The model id the boot used for the plugin agent context. */
  readonly defaultModelId: string
  /** Core tools first, then plugin tools. */
  readonly toolRegistry: ToolRegistry
  /**
   * Runs core and plugin tools with the model context of `defaultModelId`.
   * Same as `toolExecutorFor(defaultModelId)`, made once at boot. Use it
   * only for a host with one model. A host with more models or sessions
   * calls {@link toolExecutorFor} for each session.
   */
  readonly toolExecutor: ToolExecutor
  /** The plugin loader, for hosts that need more than tools. */
  readonly loader: PluginLoader
  /** Problems the boot found. The boot continued after each one. */
  readonly diagnostics: readonly HostBootDiagnostic[]
  /**
   * Make a new tool executor for one session and its model. The model id
   * sets the media (vision) context of the tools. Each executor has its own
   * feedback tracker. The media context resolves the model by id only, as
   * in the CLI. No interactive collaborators.
   */
  toolExecutorFor(modelId: string, options?: ToolExecutorForOptions): ToolExecutor
  /**
   * Resolve stored credentials for a registered model. With `providerId`,
   * use the entry of that provider. Without it, use the last provider that
   * registered the id. Pass `providerId` when two providers can register
   * the same model id. Pass `credentialName` to select one stored
   * credential of the provider. Rejects with a clear message when the model
   * is unknown (for that provider) or has no credentials.
   */
  resolveAuth(modelId: string, providerId?: string, credentialName?: string): Promise<AuthResult>
  /**
   * List the stored credentials by provider. Each entry names one stored
   * credential, so a provider with two logins gives two entries.
   */
  listCredentials(): CredentialedProvider[]
}

/** Publish the home (step 1). Same rule as the CLI's `publishAgentHomeEnv`. */
function publishHome(home: string | undefined): string {
  if (home !== undefined) process.env[AGENT_HOME_ENV] = home
  const resolved = resolveAgentHome(process.env)
  process.env[AGENT_HOME_ENV] = resolved
  return resolved
}

/** Clone the first-party plugins on first run (step 2). Never throws. */
async function syncPlugins(
  sync: { readonly targetDir: string; readonly repoUrl: string },
  diagnostics: HostBootDiagnostic[],
): Promise<void> {
  const userConfig = loadUserConfig()
  const enabled =
    process.env.MINIMAL_AGENT_NO_PLUGIN_SYNC === "1" ? false : (userConfig.pluginSync ?? true)
  const repoUrl =
    process.env.MINIMAL_AGENT_PLUGINS_REPO?.trim() || userConfig.pluginsRepo || sync.repoUrl
  const result = await bootstrapUserPlugins({
    targetDir: sync.targetDir,
    enabled,
    repoUrl,
  })
  if (result.status === "failed") {
    diagnostics.push({
      kind: "plugin-sync-failed",
      dir: result.dir,
      message: result.detail ?? result.label,
    })
  }
}

/** Discover provider plugins (step 3). Reports a failure and continues. */
async function discoverProviders(
  roots: readonly string[],
  diagnostics: HostBootDiagnostic[],
): Promise<void> {
  diagnostics.push(...findMissingPluginDeps(roots))
  try {
    await registerDiscoveredProviders(roots)
  } catch (err) {
    diagnostics.push({
      kind: "provider-discovery-failed",
      message: `provider discovery failed: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  activateDiscoveredProviders()
}

/**
 * The host-level target of the loader diagnostics (S20). Every event goes
 * to the process bus. A warning or worse also goes into `diagnostics` as a
 * `plugin-warning`. The loader wraps this handle in its diagnostics relay:
 * inside a run, the relay reports to the session of that run instead.
 */
function hostLoaderDiagnostics(diagnostics: HostBootDiagnostic[]): Diagnostics {
  return createDiagnostics({
    emit: (event) => {
      processDiagnostics().emit(event)
      if (event.severity <= Severity.Warning) {
        diagnostics.push({ kind: "plugin-warning", message: event.message })
      }
    },
  })
}

/**
 * Resolve stored auth for `modelId` with the model's own provider id. With
 * `providerId`, look up only the entry of that provider. With
 * `credentialName`, select that stored credential of the provider.
 */
async function resolveModelAuth(
  modelId: string,
  providerId?: string,
  credentialName?: string,
): Promise<AuthResult> {
  if (providerId !== undefined) {
    const scoped = findModelForProvider(modelId, providerId)
    if (!scoped) {
      throw new Error(
        `unknown model "${modelId}" for provider "${providerId}": it did not register it`,
      )
    }
    return resolveStartupAuth(scoped.providerId, scoped.id, credentialName)
  }
  const entry = findModel(modelId)
  if (!entry) throw new Error(`unknown model "${modelId}": no provider registered it`)
  return resolveStartupAuth(entry.providerId, entry.id, credentialName)
}

/**
 * Boot a non-terminal host: providers, plugins, tools, and auth.
 *
 * @param options - see {@link HostBootOptions}.
 * @returns The booted host. See {@link BootedHost}.
 */
export async function bootHost(options: HostBootOptions = {}): Promise<BootedHost> {
  const diagnostics: HostBootDiagnostic[] = []
  installHostCoreResolver()

  // 1. Agent home. The config and auth readers use MINIMAL_AGENT_HOME.
  const home = publishHome(options.home)
  const pluginRoots = options.pluginRoots ?? {}

  // 2. First-run plugin clone.
  if (options.pluginSync) await syncPlugins(options.pluginSync, diagnostics)

  // 3. Provider discovery. First root wins on an id collision.
  const providerRoots = options.providerRoots ?? providerRootsOf(pluginRoots)
  await discoverProviders(providerRoots, diagnostics)
  const defaultModelId = options.model ?? getDefaultModelId()
  const defaultEntry = findModel(defaultModelId)

  // 4. Plugin enable overrides: config, then env, then options.
  const overrides = resolvePluginEnabledOverrides({
    config: loadPluginEnabledOverrides(),
    env: {
      disable: process.env.MINIMAL_AGENT_DISABLE_PLUGINS,
      enable: process.env.MINIMAL_AGENT_ENABLE_PLUGINS,
    },
    cli: {
      disable: [...(options.disablePlugins ?? [])],
      enable: [...(options.enablePlugins ?? [])],
    },
  })

  // 4b. Per-plugin prompt-text suppression: config, then env. A bad env
  // value is ignored and reported as a warning, never fatal. An explicit
  // `options.pluginPrompts` is already resolved, so it wins outright.
  const promptResolution = resolvePluginPromptSuppression({
    config: loadPluginPromptsConfig(),
    env: process.env.MINIMAL_AGENT_PLUGIN_PROMPTS,
  })
  const promptDiagnostics = hostLoaderDiagnostics(diagnostics)
  for (const warning of promptResolution.warnings) {
    promptDiagnostics.warn("plugin-prompts", warning)
  }
  const pluginPrompts = options.pluginPrompts ?? promptResolution.suppression

  // 5. Manifest plugins.
  const agent = createAgentContext({
    sessionId: getSessionId(),
    pid: process.pid,
    model: defaultModelId,
    version: options.version ?? "0.0.0",
  })
  const loader = await PluginLoader.load({
    roots: pluginRoots,
    coreToolNames: new Set(TOOL_DEFINITIONS.map((t) => t.name)),
    agent,
    // No `logger`: the loader default logger (event bus, hooks, load
    // errors) reports through the loader's diagnostics relay, as in the CLI.
    diagnostics: hostLoaderDiagnostics(diagnostics),
    modelInfoProvider: () => buildModelInfoSnapshot(defaultModelId, defaultEntry?.providerId),
    recommendSubagentModels: () => buildSubagentModelRecommendations(defaultModelId),
    disabledPluginIds: overrides.forceDisabled,
    ...(options.requiredContracts ? { requiredContracts: options.requiredContracts } : {}),
    ...(options.allowBareCore !== undefined ? { allowBareCore: options.allowBareCore } : {}),
    enabledPluginIds: overrides.forceEnabled,
    pluginPrompts,
    effectivePlatform: resolveEffectivePlatform({ env: process.env.MINIMAL_AGENT_PLATFORM })
      .platform,
  })
  // Async prompt fragments can register dynamic tools. Wait for them first.
  await loader.getPromptBlocksAsync()

  // 6. Tool registry and executors, with null interactive collaborators.
  const toolRegistry = new ToolRegistryAdapter(loader)
  const blobSkipTools = loadBlobStoreConfig().skipTools
  const lifecycle = createLifecyclePort(loader.hooks())
  const toolExecutorFor = (modelId: string, opts: ToolExecutorForOptions = {}): ToolExecutor => {
    const statusPort = opts.statusPort ?? options.statusPort
    return new ToolExecutorAdapter({
      loader,
      modeManager: null,
      blobStore: null,
      blobSkipTools,
      feedbackTracker: new ToolFeedbackTracker(),
      model: modelId,
      store: null,
      fileTrackingStore: null,
      lifecycle,
      ...(statusPort ? { statusPort } : {}),
    })
  }
  const toolExecutor = toolExecutorFor(defaultModelId)

  // 7. The aggregate.
  return {
    home,
    providers: listRegisteredProviders().map((p) => p.id),
    plugins: loader.loadedPluginIds().map((id) => ({ id })),
    disabledPluginIds: [...overrides.forceDisabled].sort(),
    models: listBootedModels(),
    defaultModelId,
    toolRegistry,
    toolExecutor,
    toolExecutorFor,
    loader,
    diagnostics,
    resolveAuth: resolveModelAuth,
    listCredentials: () => discoverCredentialedProviders(),
  }
}

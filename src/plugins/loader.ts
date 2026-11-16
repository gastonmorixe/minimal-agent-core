/**
 * Plugin loader.
 *
 * Discovers plugin packages under host-computed roots (embedded, user,
 * project), parses
 * their manifests, resolves handler entry points, and exposes three
 * capabilities to the rest of the agent:
 *
 * 1. {@link PluginLoader.getExtraTools} — tool definitions to merge into the
 *    API request `tools` array alongside the core tools.
 * 2. {@link PluginLoader.getPromptBlock} — a string to append to the system
 *    prompt so the model knows when to emit tool calls or inline tags.
 * 3. {@link PluginLoader.dispatch} — route a trigger to the matching handler
 *    and return its `ToolHandlerResult`.
 *
 * The loader is dependency-free (no JSON schema libs, no plugin registries).
 * All validation runs through {@link parseManifest} in `./manifest.ts`.
 *
 * Conflicts (tool names vs core, tool names across plugins, inline tag names
 * across plugins, package ids across roots) are resolved eagerly at load
 * time. On collision, the later package is dropped and a diagnostic is
 * routed through the optional logger. Core tools always win.
 *
 * **Spec:** design note, section "Loader lifecycle".
 *
 * @module plugins/loader
 */

import type {
  HostPolicySnapshot,
  StartupProfile,
} from "../../plugin-api/src/types/startup-profile.ts"
import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import type { ToolTextProvider } from "../../plugin-api/src/types/tool-text.ts"
import type { NormalizedPlatform } from "../../plugin-api/src/utils/platform.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { createPluginLogger } from "../bus/diagnostic-bus.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"

import { createAgentContext } from "./agent-context.ts"
import { EventBus } from "./event-bus.ts"
import { Hooks } from "./hooks/hooks.ts"
import type { PluginHost } from "./host/capabilities.ts"
import { buildPluginHost } from "./host/factory.ts"
import { findToolCollision } from "./loader/collisions.ts"
import type { CommandDispatchOptions } from "./loader/commands.ts"
import { createDiagnosticsRelay, type DiagnosticsRelay } from "./loader/diagnostics-relay.ts"
import { type ErrorRendererOptions, registerErrorRenderers } from "./loader/error-renderers.ts"
import { startPluginFragments } from "./loader/fragments.ts"
import { buildHandlerEnv, type HandlerStdio } from "./loader/handler-env.ts"
import {
  computeEffectiveName,
  pluginHandlerErrorText,
  unknownPluginToolText,
} from "./loader/helpers.ts"
import { resolvePluginHookSubs } from "./loader/hook-subs.ts"
import { installHostCoreResolver } from "./loader/host-core-resolver.ts"
import { collectHostModes, type ResolvedHostMode } from "./loader/host-modes.ts"
import type { PluginRoots } from "./loader/roots.ts"
import {
  buildSyntheticText,
  EMPTY_SYNTHETIC_HOLDER,
  type SyntheticTextHolder,
} from "./loader/synthetic-text.ts"
import { collectToolTextProviders } from "./loader/tool-text.ts"
import { warnSink } from "./loader/warn-sink.ts"
import {
  isPluginPromptSuppressed,
  NO_PLUGIN_PROMPT_SUPPRESSION,
  type PluginPromptSuppression,
} from "./plugin-prompt-resolution.ts"
import { createPluginPromptsContext } from "./prompts-context.ts"
import type {
  AgentContext,
  CommandInfo,
  CommandResult,
  LoadedPlugin,
  ManifestMode,
  ModelInfoSnapshot,
  PromptTemplateProvider,
  ResolvedCommand,
  ResolvedEventSub,
  ResolvedHandler,
  ResolvedHookSub,
  SetupBinaryInventory,
  SetupResult,
  SubagentModelRecommendation,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolTrigger,
} from "./types.ts"

/** The startup profile a host wrote, with its path. */
type StartupProfileInfo = { path: string; profile: StartupProfile }

/**
 * Module-handler default-export signature for hook subscriptions.
 *
 * Receives the hook payload and an {@link HookHandlerContext}. May return:
 * - `void`            — pass-through (no mutation, no halt). The default.
 * - For chain channels: a {@link ChainResult} (currently unused since the
 *   only registered channels are broadcast-sync, but we type the return
 *   loosely so future chain channels work without changing callers).
 * - For broadcast-sync channels with a mutable `result` holder in the
 *   payload: mutate `payload.result` directly. The return value is
 *   ignored.
 *
 * Subprocess handlers are NOT currently supported (the manifest parser
 * accepts them, but the loader logs and skips them — chain/sync handlers
 * require synchronous, in-process invocation that subprocess can't deliver).
 */

/**
 * A mode declaration as exposed by the loader to consumers.
 *
 * Carries everything the {@link ModeManager} needs plus the source plugin
 * id so diagnostics can point back to the contributing package.
 */
export interface LoadedMode extends ManifestMode {
  /** Plugin id that contributed this mode (for logging and disambiguation). */
  pluginId: string
}

/** Core tool definition shape (matches `ToolDefinition` in `../tools.ts`). */
export interface PluginToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/** Options for {@link PluginLoader.load}. */
export interface PluginLoaderOptions extends ErrorRendererOptions {
  /**
   * Plugin root directories by tier (S40). The host computes every root:
   * core knows no default plugin location. Each directory holds plugin
   * package directories directly. Precedence on a package id collision:
   * project, then user, then embedded. See
   * `./loader/roots.ts`.
   */
  roots?: PluginRoots
  /**
   * Shorthand for an embedded root at `<embeddedDir>/plugins`. Lowest
   * precedence. Hosts pass {@link roots} instead.
   */
  embeddedDir?: string
  /** Shorthand for a user root at `<userDir>/plugins`. Hosts pass {@link roots} instead. */
  userDir?: string
  /**
   * Core tool names that must never be overridden. The loader rejects any
   * plugin tool whose `name` is in this set.
   */
  coreToolNames?: Set<string>
  /**
   * Diagnostic sink. Load errors and conflict warnings go here. Defaults
   * to a no-op in tests and `process.stderr.write` in production.
   */
  logger?: (msg: string) => void
  /**
   * Runtime-level diagnostics handle (S20). Every loader diagnostic goes
   * here: load notices, the default {@link logger}, event bus and hook
   * warnings, slash command errors, and plugin `ctx.log`. Default: the
   * process handle. After a session opens, the host calls
   * {@link PluginLoader.attachSessionDiagnostics}, so later diagnostics
   * carry the session id and reach the session event log.
   */
  diagnostics?: Diagnostics
  /**
   * Host streams for plugin handler contexts (`ctx.stdin`, `ctx.stdout`,
   * `ctx.stderr`). Core reads no process stream itself (S44). A terminal
   * host passes its own streams. Without them, a handler context has none.
   */
  handlerStdio?: HandlerStdio
  /**
   * Per-dispatch timeout in ms. Default 5 minutes. Handlers that exceed
   * this budget are aborted via AbortController.
   */
  timeoutMs?: number
  /**
   * Optional event bus to install plugin event subscriptions on. If
   * omitted, the loader creates its own — accessible via
   * {@link PluginLoader.bus}. Pass an existing bus when you want plugin
   * subscriptions and host subscriptions to share the same instance
   * (the common case in the agent).
   */
  bus?: EventBus
  /**
   * Main-agent identity (session id, pid, model, version). When supplied,
   * the loader exposes it to every dispatched handler as `ctx.agent` AND
   * publishes the same values to subprocess handlers as `MINIMAL_AGENT_*`
   * env vars (`agentContextToEnv`).
   *
   * Build once at agent boot with {@link createAgentContext}, then pass
   * the SAME frozen object here (and to any other consumer like
   * `LiveAreaScheduler`). The loader does not synthesize a sensible
   * default — see {@link sessionId} for the back-compat path.
   */
  agent?: AgentContext
  /**
   * Live provider of the agent's CURRENT model snapshot. Unlike {@link agent}
   * (frozen at boot), this is a closure the loader calls at dispatch time and
   * exposes to module handlers as {@link ToolHandlerContext.queryModelInfo}, so a
   * decoupled `ModelInfo` tool always sees the model the agent will send next
   * (correct across mid-session switches + resume). The host builds it over its
   * live model id + the shared registry; omit it to leave `queryModelInfo`
   * undefined (back-compat).
   */
  modelInfoProvider?: () => ModelInfoSnapshot | undefined
  /**
   * Live provider of the ACTIVE model's sub-agent model recommendations,
   * exposed to module handlers as {@link ToolHandlerContext.recommendSubagentModels}.
   * Same pattern as {@link modelInfoProvider}: the host builds it over its live
   * model id + the shared registry + the active provider's optional port, so a
   * delegation plugin stays decoupled from any provider. Omit it to leave
   * `recommendSubagentModels` undefined (back-compat).
   */
  recommendSubagentModels?: () => SubagentModelRecommendation[]
  /**
   * Optional agent session id.
   *
   * @deprecated Prefer {@link agent}. Kept as a back-compat alias for
   * test/ad-hoc callers: when `agent` is omitted but `sessionId` is
   * provided, the loader synthesizes a minimal {@link AgentContext} with
   * `{ sessionId, pid: process.pid, model: process.env.MINIMAL_AGENT_MODEL ?? "", version: "" }`.
   * When both are provided, `agent` wins and `sessionId` is ignored.
   */
  sessionId?: string
  /**
   * Overrides for the per-plugin capability hosts built from manifest
   * `capabilities` grants (see {@link ManifestFile.capabilities}).
   * Production leaves this unset (hosts read the real
   * `~/.minimal-agent/sessions/` store); tests inject a temp
   * `sessionsDir` so capability-backed tools run against fixtures.
   */
  hostOptions?: { sessionsDir?: string }
  /**
   * Set of plugin ids to skip entirely. The loader silently ignores any
   * package whose `manifest.id` is in this set — discovery still walks
   * the dirs, but the manifest is dropped before validation, before
   * collision checks, and before handler resolution.
   *
   * Wired in the host entry point from `~/.minimal-agent/config.jsonc`:
   * any plugin whose `plugins.<id>.enabled` is `false` lands here. This
   * gives every plugin (current and future) a uniform opt-out without
   * each plugin having to implement disabling itself.
   */
  disabledPluginIds?: Set<string>
  /**
   * Extra contract ids that must have exactly one provider (G11, warn
   * mode). Contracts provided by a `required` plugin are always checked.
   * A failure records a diagnostic and does not stop boot.
   */
  requiredContracts?: readonly string[]
  /**
   * Accept a boot with zero plugins. With `true`, a boot that loads no
   * plugin skips the contract check ({@link requiredContracts}). Default:
   * `false`, so a bare boot records a diagnostic for each missing contract.
   */
  allowBareCore?: boolean
  /** `"fail"`: a failed contract check throws `ContractCheckFailedError`. Default `"warn"`. */
  contractCheckMode?: "warn" | "fail"
  /**
   * Set of plugin ids the user has explicitly enabled in their config
   * (`plugins.<id>.enabled === true`). This is an override signal that
   * brings back manifests shipped with `enabled: false`. Ids in
   * {@link disabledPluginIds} still win — deny beats allow.
   *
   * The loader only consults this set when a manifest has its OWN
   * `enabled: false` opt-out. If both sets are empty (the common case),
   * behavior is identical to before this option existed.
   */
  enabledPluginIds?: Set<string>
  /**
   * Per-plugin prompt-TEXT suppression. Default: nothing suppressed.
   *
   * A suppressed plugin still loads, still advertises its tools, and still
   * RUNS its prompt fragments (a fragment can call
   * {@link PluginLoader.registerDynamicTools}). Only the TEXT is dropped
   * from {@link PluginLoader.getPromptBlocksAsync}: its `PROMPT.md` body,
   * its sessionContext fragments, and its afterInstructions fragments.
   *
   * The host resolves this with `resolvePluginPromptSuppression` in
   * `./plugin-prompt-resolution.ts` and passes the result here.
   */
  pluginPrompts?: PluginPromptSuppression
  /**
   * The effective platform to gate manifest/tool `platforms` whitelists
   * against. Omit to use the host's detected platform
   * ({@link detectPlatform}). The host entry point resolves an env
   * (`MINIMAL_AGENT_PLATFORM`) / CLI (`--platform`) override and passes
   * it here; the `all` bypass loads every plugin/tool regardless of
   * whitelist. See `plugin-api/src/utils/platform.ts`.
   */
  effectivePlatform?: NormalizedPlatform
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FRAGMENT_ORDER = 100

/** Loaded plugin collection with dispatch, commands, and host capabilities. */
export class PluginLoader {
  private readonly plugins: LoadedPlugin[]
  /** Providers and the one resolver of this loader. Set once in `load()`. */
  private synthetic: SyntheticTextHolder = EMPTY_SYNTHETIC_HOLDER
  /** The boot contract check result of this loader. Set once in `load()`. */
  private contractCheckResult: ContractCheckResult = CONTRACT_CHECK_PASSED
  /** Built-in tool text providers of this loader. Set once in `load()`. */
  private toolText: readonly ToolTextProvider[] = []
  private readonly toolIndex: Map<string, ResolvedHandler>
  /** Alias → canonical tool-name map, never advertised to the model. */
  private readonly aliasIndex: Map<string, string>
  private readonly tagIndex: Map<string, ResolvedHandler>
  private readonly coreToolNames: Set<string>
  private readonly modes: LoadedMode[]
  private readonly defaultModeId: string | null
  private readonly timeoutMs: number
  private readonly eventBus: EventBus
  /** Shared async/sync plugin hooks facade. */
  private readonly hooksFacade: Hooks
  private readonly pendingFrags: PendingFragment[]
  private readonly logger: (msg: string) => void
  /** The diagnostics target of every loader diagnostic (S20). */
  private readonly relay: DiagnosticsRelay
  /** Host streams for handlers. See {@link PluginLoaderOptions.handlerStdio}. */
  private readonly stdio: HandlerStdio | undefined
  /** Optional main-agent identity forwarded to plugin handlers. */
  private readonly agent: AgentContext | undefined
  /**
   * Live current-model snapshot provider; see
   * {@link PluginLoaderOptions.modelInfoProvider}. Not `readonly`:
   * {@link setModelInfoSource} (S34 PORT fold) may replace it after
   * construction, once a caller's model id is known.
   */
  private modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined
  /** Live sub-agent model recommendations provider; see {@link PluginLoaderOptions.recommendSubagentModels}. */
  private recommendSubagentModels: (() => SubagentModelRecommendation[]) | undefined
  /** Live host policy source; see {@link setHostPolicySource}. */
  private hostPolicySource: (() => HostPolicySnapshot | undefined) | undefined = undefined
  /** Startup profile this host wrote; see {@link setStartupProfile}. */
  private startupProfileInfo: StartupProfileInfo | undefined = undefined
  /** Cached async prompt-block resolution, kept byte-stable for the session. */
  private asyncBlocksCache: PluginPromptBlocks | undefined = undefined
  /** Owners of the cached prompt blocks. Set with {@link asyncBlocksCache}. */
  private promptProvenance: PromptProvenance | undefined = undefined
  /**
   * Per-plugin prompt-text suppression, resolved once at construction. See
   * {@link PluginLoaderOptions.pluginPrompts}.
   */
  private readonly pluginPrompts: PluginPromptSuppression
  /** Global slash-command registry (first-wins by name). */
  private readonly commands: CommandRegistry
  /** Global host-mode registry (first-wins by id, like modes/commands). */
  private readonly hostModes: Map<string, ResolvedHostMode>
  /** Lazily memoized frozen capability hosts. */
  private readonly hostCache = new Map<string, PluginHost>()
  private readonly promptProvider: () => PromptTemplateProvider | undefined
  /** Capability-host overrides (test sessionsDir injection). See {@link PluginLoaderOptions.hostOptions}. */
  private readonly hostOptions: { sessionsDir?: string } | undefined
  private historyEditCommitHandler:
    | {
        beforeCommit: (
          input: import("./host/providers/sessions-write.ts").PreparedHistoryEditCommit,
        ) => Promise<void>
        afterCommit: (
          notice: import("./host/providers/sessions-write.ts").HistoryEditCommitNotice,
        ) => Promise<void>
      }
    | undefined

  private constructor(
    plugins: LoadedPlugin[],
    toolIndex: Map<string, ResolvedHandler>,
    aliasIndex: Map<string, string>,
    tagIndex: Map<string, ResolvedHandler>,
    modes: LoadedMode[],
    defaultModeId: string | null,
    timeoutMs: number,
    eventBus: EventBus,
    hooksFacade: Hooks,
    pendingFrags: PendingFragment[],
    logger: (msg: string) => void,
    agent: AgentContext | undefined,
    modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined,
    recommendSubagentModels: (() => SubagentModelRecommendation[]) | undefined,
    hostOptions: { sessionsDir?: string } | undefined,
    coreToolNames: Set<string> = new Set(),
    /** Pre-built command registry (T-8a0c44). */
    commands: CommandRegistry,
    /** Pre-built host-mode registry (`hostModes[]` manifest entries). */
    hostModes: Map<string, ResolvedHostMode> = new Map(),
    /** The diagnostics target of every loader diagnostic (S20). */
    relay: DiagnosticsRelay = createDiagnosticsRelay(processDiagnostics()),
    stdio?: HandlerStdio,
    /**
     * Per-plugin prompt-text suppression. See
     * {@link PluginLoaderOptions.pluginPrompts}.
     */
    pluginPrompts: PluginPromptSuppression = NO_PLUGIN_PROMPT_SUPPRESSION,
    /** Getter of the `prompts.template` provider, for `ctx.prompts`. */
    promptProvider: () => PromptTemplateProvider | undefined = () => undefined,
    private readonly systemBaseGet: () => promptBoot.SystemPromptBaseHolder = promptBoot.noSystemPromptBase,
  ) {
    this.promptProvider = promptProvider
    this.relay = relay
    this.stdio = stdio
    this.pluginPrompts = pluginPrompts
    this.plugins = plugins
    this.toolIndex = toolIndex
    this.aliasIndex = aliasIndex
    this.tagIndex = tagIndex
    this.coreToolNames = coreToolNames
    this.modes = modes
    this.defaultModeId = defaultModeId
    this.timeoutMs = timeoutMs
    this.eventBus = eventBus
    this.hooksFacade = hooksFacade
    this.pendingFrags = pendingFrags
    this.logger = logger
    this.agent = agent
    this.modelInfoProvider = modelInfoProvider
    this.recommendSubagentModels = recommendSubagentModels
    this.hostOptions = hostOptions
    this.commands = commands
    this.hostModes = hostModes
  }

  /**
   * Attach `scope` (a session's diagnostics scope), so loader diagnostics
   * carry the session id and reach that session's event log (S20).
   * Returns an idempotent detach function. Inside a `Session.run`, a
   * diagnostic goes to the scope of that run. Outside a run, it goes to the
   * one attached scope, or to the runtime-level handle when two or more
   * scopes are attached.
   */
  attachSessionDiagnostics(scope: Diagnostics): () => void {
    return this.relay.attach(scope)
  }

  /** The loader's current diagnostics handle (runtime-level, or the attached session scope). */
  diagnostics(): Diagnostics {
    return this.relay
  }

  /**
   * Shared event bus. Plugin event-subscriptions are installed on this
   * bus at load time; host code (REPL, agent) uses it for both emits
   * (e.g. `prompt.input.changed`) and listens (e.g. `mode.set.request`).
   *
   * When the caller provides a bus via {@link PluginLoaderOptions.bus},
   * this returns that same instance. Otherwise it returns the loader's
   * private one.
   */
  bus(): EventBus {
    return this.eventBus
  }

  /**
   * The {@link AgentContext} shared with every plugin handler dispatched
   * by this loader. Same frozen object reference passed in via
   * {@link PluginLoaderOptions.agent} (or synthesized from the deprecated
   * `sessionId` option). Useful for host code that needs to construct a
   * sibling consumer (e.g. {@link LiveAreaScheduler}) with the SAME
   * identity, so plugins see one consistent agent across dispatch paths.
   *
   * Returns `undefined` when neither option was passed (ad-hoc tests).
   */
  agentContext(): AgentContext | undefined {
    return this.agent
  }

  /**
   * Replace the live model-info source after construction (S34 PORT fold:
   * `src/llm/model-info.ts`'s data-source wiring, folded into
   * `loops/assemble.ts`). Lets a caller finish wiring
   * {@link PluginLoaderOptions.modelInfoProvider} /
   * {@link PluginLoaderOptions.recommendSubagentModels} once the run's model
   * is known — e.g. tied to the live {@link AgentCore.getModel} of the core
   * this loader ends up wired into — instead of having to build those
   * closures before `load()` is even called. Only replaces a provider that
   * is given; omit one to leave it exactly as `load()` set it (or still
   * unset).
   */
  setModelInfoSource(
    modelInfoProvider?: () => ModelInfoSnapshot | undefined,
    recommendSubagentModels?: () => SubagentModelRecommendation[],
  ): void {
    if (modelInfoProvider) this.modelInfoProvider = modelInfoProvider
    if (recommendSubagentModels) this.recommendSubagentModels = recommendSubagentModels
  }

  /**
   * Wire the live host policy source, exposed to handlers as
   * {@link ToolHandlerContext.queryHostPolicy}. The host calls it after it
   * builds its mode manager.
   */
  setHostPolicySource(src: () => HostPolicySnapshot | undefined): void {
    this.hostPolicySource = src
  }

  /**
   * Set (or clear with `undefined`) the startup profile this host wrote,
   * exposed to handlers as {@link ToolHandlerContext.startupProfile}.
   */
  setStartupProfile(v: { path: string; profile: StartupProfile } | undefined): void {
    this.startupProfileInfo = v
  }

  /** Stable getter handed to handler ctx, reads the current profile at call time. */
  private readonly startupProfileGetter = (): StartupProfileInfo | undefined =>
    this.startupProfileInfo

  /**
   * Shared {@link Hooks} facade. Routes registrations and emits to the
   * right backend based on the channel's declared {@link ChannelShape}:
   *
   * - `broadcast-async` → the same {@link EventBus} returned by {@link bus}.
   * - `broadcast-sync`, `chain`, `stream` → an internal {@link HookBus}.
   *
   * Plugin `manifest.hooks` entries are subscribed here at load time.
   * Host code uses this facade to emit on channels that have synchronous
   * delivery requirements (e.g. `editor.key`, where the editor's keystroke
   * pump cannot yield to async work between bytes).
   */
  hooks(): Hooks {
    return this.hooksFacade
  }

  /**
   * Discover, parse, and resolve plugin packages. See
   * {@link PluginLoaderOptions} for configuration.
   *
   * This method never throws for bad plugins. All plugin-level failures are
   * logged via the `logger` option and the offending package is skipped.
   * Only unrecoverable internal errors surface as exceptions.
   */
  static async load(opts: PluginLoaderOptions = {}): Promise<PluginLoader> {
    // Default logger fans out through the diagnostic bus (scrollback chrome,
    // file log, stderr mirror). Tests inject their own logger.
    const relay = createDiagnosticsRelay(opts.diagnostics ?? processDiagnostics())
    const logger = opts.logger ?? warnSink(relay, "plugin-loader")
    // Plugin imports of `@minimal-agent/core/*` get the host's copy, so only
    // one copy of the contract loads (see loader/host-core-resolver.ts).
    installHostCoreResolver()
    const coreToolNames = opts.coreToolNames ?? new Set<string>()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const eventBus = opts.bus ?? new EventBus(logger)
    const hooksFacade = new Hooks({ eventBus, logger })
    // Resolve the agent context. Priority:
    //   1. opts.agent (preferred — typed value object constructed by the
    //      agent at boot via createAgentContext).
    //   2. opts.sessionId (deprecated alias) — synthesize a minimal
    //      AgentContext from process.pid + ambient MINIMAL_AGENT_MODEL env
    //      var so back-compat callers still see ctx.agent populated.
    //   3. neither — leave `agent` undefined; existing tests preserve
    //      historical behavior (no `ctx.agent`, no `MINIMAL_AGENT_*` env
    //      injection beyond what's already in process.env).
    const agent: AgentContext | undefined = opts.agent
      ? opts.agent
      : opts.sessionId
        ? createAgentContext({
            sessionId: opts.sessionId,
            pid: process.pid,
            model: process.env.MINIMAL_AGENT_MODEL ?? "",
            version: process.env.MINIMAL_AGENT_VERSION ?? "",
          })
        : undefined
    const disabledPluginIds = opts.disabledPluginIds ?? new Set<string>()
    const enabledPluginIds = opts.enabledPluginIds ?? new Set<string>()

    // Discover packages under all root tiers, dedupe by realpath, parse
    // + gate manifests, and resolve PROMPT.md bodies. Lives in
    // `src/plugins/loader/discovery.ts`; see that module for the
    // precedence / opt-out / dead-weight rules.
    const discovered = discoverAndParsePackages({
      ...(opts.embeddedDir !== undefined ? { embeddedDir: opts.embeddedDir } : {}),
      ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
      ...(opts.roots !== undefined ? { roots: opts.roots } : {}),
      logger,
      explicitLogger: opts.logger,
      diagnostics: relay,
      disabledPluginIds,
      enabledPluginIds,
      ...(opts.effectivePlatform !== undefined
        ? { effectivePlatform: opts.effectivePlatform }
        : {}),
    })

    const { replayRenderersRaw, turnAttachmentsRaw, promptTemplateRaw } = discovered
    // Boot order: codec plugin, template plugin, then the rest (S10.1).
    const parsed = orderBootProviders(discovered.parsed, promptTemplateRaw)
    // F2: the closest tier owns each text contract (contract-owners.ts).
    const contractOwners = resolveContractOwners(parsed, relay)
    const boot = promptBoot.createPromptBoot()
    const getPromptProvider = () => boot.template.current

    // Resolve handlers, apply collision rules.
    // Replay-renderer tool names already claimed in this load
    // (first-wins across packages, walked in precedence order).
    const claimedReplayTools = new Set<string>()
    // Turn-attachment registry keys (`<pluginId>/<entryId>`) already
    // claimed in this load (first-wins across packages, precedence order).
    const claimedTurnAttachmentKeys = new Set<string>()
    const toolIndex = new Map<string, ResolvedHandler>()
    const aliasIndex = new Map<string, string>() // alias → canonical
    const tagIndex = new Map<string, ResolvedHandler>()
    const finalPlugins: LoadedPlugin[] = []

    // Forward-ref so event/hook handler contexts can expose the live
    // command registry (`ctx.listCommands()`). Registration happens in
    // the loop below, BEFORE `new PluginLoader(...)` builds the index, so
    // we hand listeners a closure over `loaderRef` that is read lazily at
    // event time — always after `load()` has returned and `loaderRef` is
    // set. The `slash-menu` overlay consumes this.
    let loaderRef: PluginLoader | null = null
    const listCommandsForCtx = (): CommandInfo[] => loaderRef?.listCommandInfo() ?? []

    for (const pkg of parsed) {
      const accepted: ResolvedHandler[] = []
      // First pass: collision check. A plugin is accepted only if ALL of
      // its tool names / tag names / aliases are conflict-free (see
      // `findToolCollision` in `./loader/collisions.ts`).
      const rejectReason = findToolCollision(
        pkg.manifest.tools ?? [],
        { coreToolNames, toolIndex, aliasIndex, tagIndex },
        logger,
      )
      if (rejectReason !== null) {
        logger(`skipping ${pkg.packageDir}: ${rejectReason}`)
        continue
      }

      // Second pass: resolve handler entry points.
      let resolveFailed = false
      for (const h of pkg.manifest.tools ?? []) {
        const resolved = await resolveHandler(h, pkg.packageDir, logger, () =>
          loaderRef?.syntheticText(),
        )
        if (!resolved) {
          resolveFailed = true
          break
        }
        accepted.push(resolved)
      }

      if (resolveFailed) {
        logger(`skipping ${pkg.packageDir}: handler resolution failed`)
        continue
      }

      // Commit to global indexes.
      for (const r of accepted) {
        if (r.definition.trigger.type === "tool") {
          // Apply CamelCase prefix convention.
          const { canonical, migrationAlias } = computeEffectiveName(
            r.definition.trigger.tool.name,
            r.definition.trigger.tool.explicitName,
            pkg.manifest.name,
            pkg.manifest.camelName,
          )
          r.definition.trigger.tool.name = canonical
          if (migrationAlias) {
            // Register old name as a deprecation alias for migration.
            const existing = r.definition.trigger.tool.aliases ?? []
            if (!existing.includes(migrationAlias)) {
              r.definition.trigger.tool.aliases = [...existing, migrationAlias]
            }
          }
          toolIndex.set(canonical, r)
          for (const alias of r.definition.trigger.tool.aliases ?? []) {
            aliasIndex.set(alias, canonical)
          }
        } else {
          tagIndex.set(r.definition.trigger.tag, r)
        }
      }

      pkg.handlers = accepted

      // Resolve event subscriptions. Failures here do NOT disqualify the
      // plugin's tools/inline-tags — a missing event handler module is
      // a partial-functionality bug, not a poisoned manifest. We log and
      // skip just the offending sub.
      const resolvedSubs: ResolvedEventSub[] = []
      for (const sub of pkg.manifest.events ?? []) {
        const r = await resolveEventSub(sub, pkg.packageDir, logger)
        if (r) resolvedSubs.push(r)
      }
      pkg.eventSubs = resolvedSubs

      // Subscribe each on the shared bus.
      for (const r of resolvedSubs) {
        registerEventSub(
          eventBus,
          hooksFacade,
          pkg.packageDir,
          r,
          logger,
          pkg.manifest.id,
          agent,
          listCommandsForCtx,
          opts.handlerStdio,
          relay,
        )
      }

      // Resolve hook subscriptions (lenient, permission gated).
      const resolvedHookSubs = await resolvePluginHookSubs(pkg, logger)
      pkg.hookSubs = resolvedHookSubs

      // Subscribe each on the hooks facade.
      for (const r of resolvedHookSubs) {
        registerHookSub(
          hooksFacade,
          pkg.packageDir,
          r,
          logger,
          pkg.manifest.id,
          agent,
          listCommandsForCtx,
          opts.handlerStdio,
          relay,
        )
      }

      // Resolve slash commands. Same lenient policy: a broken command
      // handler is logged + skipped, never disqualifies the plugin.
      // Cross-plugin name collisions are settled later (first-wins) when
      // the constructor builds the global command index.
      const resolvedCommands: ResolvedCommand[] = []
      for (const cmd of pkg.manifest.commands ?? []) {
        const r = await resolveCommand(cmd, pkg.manifest.id, pkg.packageDir, logger)
        if (r) resolvedCommands.push(r)
      }
      pkg.commands = resolvedCommands

      // Resolve + register manifest-declared replay renderers (the
      // `--resume` re-render seam). Lenient like events/hooks/commands:
      // a broken entry is logged and skipped, never disqualifies the
      // plugin. First-wins per tool name across packages (we walk in
      // precedence order).
      await registerManifestReplayRenderers(
        replayRenderersRaw.get(pkg.packageDir),
        pkg.packageDir,
        claimedReplayTools,
        logger,
      )

      // Resolve + register manifest-declared turn-attachment factories
      // (the per-turn user-message attachment seam consumed by the boot
      // path). Same lenient + first-wins policy as replay renderers.
      await registerManifestTurnAttachments(
        turnAttachmentsRaw.get(pkg.packageDir),
        pkg.manifest.id,
        pkg.packageDir,
        claimedTurnAttachmentKeys,
        logger,
      )

      await promptBoot.bootPromptProviders(
        boot,
        discovered,
        pkg,
        logger,
        relay,
        contractOwners.overridden.get(pkg.packageDir),
      )
      finalPlugins.push(pkg)
    }

    await registerErrorRenderers(finalPlugins, opts.errorRendererRegistry, relay)
    const synthetic = await buildSyntheticText(finalPlugins, relay, contractOwners.overridden)
    const toolText = await collectToolTextProviders(finalPlugins, relay, contractOwners.overridden)
    const contractCheck = runContractCheck(finalPlugins, opts, relay)
    if (contractCheck !== undefined && boot.template.current === undefined)
      relay.info("prompt.no_template_provider", "", { contract: "prompts.template" })

    // Collect modes after handlers because mode collisions don't disqualify
    // a plugin's tools — colliding modes are simply skipped with a warning.
    const modes: LoadedMode[] = []
    const seenModeIds = new Set<string>()
    let defaultModeId: string | null = null
    for (const pkg of finalPlugins) {
      for (const m of pkg.manifest.modes ?? []) {
        if (seenModeIds.has(m.id)) {
          logger(`${pkg.packageDir}: mode "${m.id}" collides with another loaded plugin; skipping`)
          continue
        }
        seenModeIds.add(m.id)
        modes.push({ ...m, pluginId: pkg.manifest.id })
        if (m.default) {
          if (defaultModeId === null) {
            defaultModeId = m.id
          } else {
            logger(
              `${pkg.packageDir}: mode "${m.id}" requested default but ` +
                `"${defaultModeId}" already claims it; ignoring`,
            )
          }
        }
      }
    }

    // Kick off async prompt fragments in parallel. We do NOT await them —
    // the TUI must boot instantly. Fragments are awaited the first time
    // the agent assembles a system prompt; see getPromptBlockAsync().
    const pendingFrags: PendingFragment[] = startPluginFragments({
      plugins: finalPlugins,
      logger,
      agent,
      modelInfoProvider: opts.modelInfoProvider,
      registerDynamicTools: (pluginId, handlers) =>
        loaderRef?.registerDynamicTools(pluginId, handlers),
      hostOptions: opts.hostOptions,
      stdio: opts.handlerStdio,
      relay,
      promptProvider: getPromptProvider,
      defaultOrder: DEFAULT_FRAGMENT_ORDER,
    })
    // Stable order: by `order` ascending, then by plugin id, then fragment id.
    pendingFrags.sort(
      (a, b) =>
        a.order - b.order ||
        a.pluginId.localeCompare(b.pluginId) ||
        a.fragmentId.localeCompare(b.fragmentId),
    )

    // Collect resolved commands from every plugin and build the
    // command registry (T-8a0c44).
    const allCommands: ResolvedCommand[] = []
    for (const pkg of finalPlugins) {
      for (const cmd of pkg.commands) {
        allCommands.push(cmd)
      }
    }
    // Collect host modes after commands, same first-wins + lenient policy
    // (see collectHostModes's doc for the implicit hostMode:stdio permission).
    const hostModes = await collectHostModes(finalPlugins, logger)

    const commandRegistry = new CommandRegistry(allCommands, {
      timeoutMs,
      agent,
      eventBus,
      hooksFacade,
      logger,
      diagnostics: relay,
      // Resolve a command's plugin capability host lazily via the forward-ref
      // (the loader is constructed just below), so `/usage` can read folded
      // token stats through `ctx.host.usage` without importing usage-stats.
      hostFor: (pluginId: string) => loaderRef?.capabilityHostFor(pluginId),
    })

    const loader = new PluginLoader(
      finalPlugins,
      toolIndex,
      aliasIndex,
      tagIndex,
      modes,
      defaultModeId,
      timeoutMs,
      eventBus,
      hooksFacade,
      pendingFrags,
      logger,
      agent,
      opts.modelInfoProvider,
      opts.recommendSubagentModels,
      opts.hostOptions,
      coreToolNames,
      commandRegistry,
      hostModes,
      relay,
      opts.handlerStdio,
      opts.pluginPrompts ?? NO_PLUGIN_PROMPT_SUPPRESSION,
      getPromptProvider,
      () => boot.systemBase,
    )
    // Resolve the forward-ref so handler contexts created earlier can
    // read the now-built command registry via `ctx.listCommands()`.
    loaderRef = loader
    loader.synthetic = synthetic
    loader.toolText = toolText
    loader.contractCheckResult = contractCheck ?? CONTRACT_CHECK_PASSED
    loader.baseRelease = promptBoot.registerBootHolder(boot)
    return loader
  }

  private baseRelease?: () => void
  /** Clear the process-wide base holder, only when this loader's holder is still current. */
  releaseSystemPromptBase = (): void => this.baseRelease?.()
  /** The registered system prompt base providers. */
  systemPromptBase = (): promptBoot.SystemPromptBaseHolder => this.systemBaseGet()

  /** All loaded modes contributed by plugins (in plugin-load order). */
  getModes(): LoadedMode[] {
    return [...this.modes]
  }

  getCommands(): ReadonlyArray<ResolvedCommand> {
    return this.commands.getCommands()
  }
  hasCommand(name: string): boolean {
    return this.commands.hasCommand(name)
  }
  listCommandInfo(): CommandInfo[] {
    return this.commands.listCommandInfo()
  }
  async dispatchCommand(
    line: string,
    opts: CommandDispatchOptions = {},
  ): Promise<CommandResult | null> {
    return this.commands.dispatchCommand(line, opts)
  }
  registerHostCommand(cmd: ResolvedCommand): boolean {
    return this.commands.registerHostCommand(cmd)
  }
  /** All loaded host modes contributed by plugins, first-wins by id. */
  getHostModes(): ResolvedHostMode[] {
    return [...this.hostModes.values()]
  }
  /** The resolved host mode for `id`, or `undefined` when none is loaded. */
  findHostMode(id: string): ResolvedHostMode | undefined {
    return this.hostModes.get(id)
  }
  getDefaultModeId(): string | null {
    return this.defaultModeId
  }
  getEventSubs(): ReadonlyArray<{ pluginId: string; sub: ResolvedEventSub }> {
    return collectEventSubscriptions(this.plugins)
  }
  getHookSubs(): ReadonlyArray<{ pluginId: string; sub: ResolvedHookSub }> {
    return collectHookSubscriptions(this.plugins)
  }
  /**
   * Accepted plugin packages, in load order (S35). A host UI loader reads
   * each package's `ui` block from here, so a UI part loads only for a
   * plugin that core accepted (enable gates, platform gates, collisions).
   */
  loadedPackages(): ReadonlyArray<{ readonly id: string; readonly packageDir: string }> {
    return this.plugins.map((p) => ({ id: p.manifest.id, packageDir: p.packageDir }))
  }

  /**
   * Tool definitions contributed by loaded plugins. Safe to concat to core.
   *
   * Tools whose handler exports an `available` predicate that returns `false`
   * for the current context are OMITTED: hidden from the model's tool list, and
   * `buildBlock` separately drops the prompt section of a plugin whose entire
   * tool surface is hidden, so a context-irrelevant tool costs no tokens and
   * can't be called by mistake. Evaluated fresh on every call (once per turn)
   * so the gate is dynamic. Dispatch is never gated this way; a hidden tool
   * still refuses defensively if somehow invoked.
   */
  getExtraTools(): PluginToolDefinition[] {
    return collectPluginTools(this.plugins, createToolAvailabilityContext(this.agent), this.logger)
  }

  /**
   * Plugin-contributed system-prompt text, or `null` if nothing contributes.
   *
   * The model never learns the word "plugin". Each contribution is composed
   * into a semantic, role-named section so it reads as a first-class part of
   * the agent's own instructions, not as documentation about a third-party
   * package:
   *
   * ```
   * <ma::sys::behavior name="writing-style">...</ma::sys::behavior>
   * <ma::sys::tool name="WebSearch">...</ma::sys::tool>
   * <ma::sys::emit name="diff">...</ma::sys::emit>
   * <ma::sys::mode name="ask">...</ma::sys::mode>
   * <ma::sys::context name="environment">...</ma::sys::context>
   * ```
   *
   * The `<ma::sys::*>` namespace is read-only to the model: it is composed
   * here into the system prompt and is never scanned from model output (that
   * is `<ma::emit::*>`) nor injected as a runtime signal (that is
   * `<ma::agent::*>`). The role and `name` are inferred from each plugin's
   * manifest shape by {@link classifyPluginPrompt}; a single leading H1 is
   * stripped from each `PROMPT.md` body (its text seeds the section `name`
   * for behavior/context sections). Sections sort by role then name so the
   * composed block is byte-stable for a given plugin set.
   */
  getPromptBlock(): string | null {
    return this.buildBlock(null).text
  }

  /**
   * Await all prompt fragments and return both system-prompt slots.
   *
   * - `afterInstructions`: plain join of fragments with
   *   `placement: "afterInstructions"` (order → pluginId → fragmentId).
   *   No `buildBlock`, no PROMPT.md, no `<ma::sys::…>` wrap.
   * - `sessionContext`: existing {@link buildBlock} path for PROMPT.md plus
   *   fragments with default/`sessionContext` placement only.
   *
   * Each fragment has its own `timeoutMs` (default 2000ms). Fragments
   * that exceed it (or throw) are dropped silently with a diagnostic
   * logged through the loader's logger; the rest of the prompt assembles
   * normally.
   *
   * The dual result is memoized for the rest of the loader's lifetime —
   * the system prompt sits on a prompt-cache breakpoint and must be
   * byte-stable across turns. Volatile content (current date, terminal
   * size, ...) is therefore captured once and reused, which is what the
   * `(at session start)` framing in the env-info plugin describes.
   *
   * Safe to call from multiple turns concurrently: the second call sees
   * the cached value if the first completed, or awaits the same in-flight
   * resolution otherwise (callers race on the same fragment promises).
   *
   * **Prompt-text suppression.** When
   * {@link PluginLoaderOptions.pluginPrompts} suppresses a plugin id, that
   * plugin contributes NO text: no `PROMPT.md` body, no sessionContext
   * fragments, no afterInstructions fragments. Suppression is PER PLUGIN,
   * never a blanket null (an unsuppressed plugin still contributes).
   * Fragments still RUN while suppressed, because a fragment can call
   * {@link PluginLoader.registerDynamicTools}; only their text is dropped. The memoized
   * cache stores the suppressed result, so it stays byte-stable.
   */
  async getPromptBlocksAsync(): Promise<PluginPromptBlocks> {
    if (this.asyncBlocksCache !== undefined) return this.asyncBlocksCache
    const resolved = (await this.resolveFragments()).filter(
      (r) => !isPluginPromptSuppressed(this.pluginPrompts, r.pluginId),
    )
    const session = this.buildBlock(groupSessionContextFragments(resolved))
    const blocks: PluginPromptBlocks = {
      afterInstructions: joinAfterInstructions(resolved),
      sessionContext: session.text,
    }
    this.promptProvenance = {
      afterInstructions: afterInstructionsSpans(resolved),
      sessionContext: session.sections,
    }
    this.asyncBlocksCache = blocks
    return blocks
  }

  /**
   * Like {@link getPromptBlock} but additionally awaits and embeds the
   * resolved text of every sessionContext-placement
   * {@link ManifestPromptFragment} contributed by a loaded plugin.
   *
   * Back-compat: returns only the `sessionContext` field of
   * {@link getPromptBlocksAsync}. Fragments with
   * `placement: "afterInstructions"` are excluded.
   */
  async getPromptBlockAsync(): Promise<string | null> {
    return (await this.getPromptBlocksAsync()).sessionContext
  }

  /**
   * Pending fragments still awaiting resolution. Useful for status-bar
   * indicators and diagnostics. Returns an empty array once
   * {@link getPromptBlocksAsync} / {@link getPromptBlockAsync} has fully
   * resolved.
   */
  pendingFragments(): {
    pluginId: string
    fragmentId: string
    startedAt: number
  }[] {
    if (this.asyncBlocksCache !== undefined) return []
    return this.pendingFrags.map((f) => ({
      pluginId: f.pluginId,
      fragmentId: f.fragmentId,
      startedAt: f.startedAt,
    }))
  }

  /**
   * Race each pending fragment against its declared timeout and collect
   * successful texts in pending order (`order`, then pluginId, then
   * fragmentId — set at load). Placement is preserved for slot split.
   */
  private async resolveFragments(): Promise<ResolvedFragment[]> {
    if (this.pendingFrags.length === 0) return []

    const timed = await Promise.all(
      this.pendingFrags.map(async (f) => {
        const frag = findFragmentDef(this.plugins, f.pluginId, f.fragmentId)
        const timeoutMs = frag?.timeoutMs ?? DEFAULT_FRAGMENT_TIMEOUT_MS
        let timer: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs)
          timer.unref?.()
        })
        const result = await Promise.race([f.promise, timeout])
        if (timer) clearTimeout(timer)
        if (result === null || result === undefined) {
          this.logger(
            `prompt fragment "${f.pluginId}:${f.fragmentId}" timed out or failed; dropping`,
          )
          return null
        }
        return {
          pluginId: f.pluginId,
          fragmentId: f.fragmentId,
          order: f.order,
          placement: f.placement,
          text: result,
        } satisfies ResolvedFragment
      }),
    )

    const out: ResolvedFragment[] = []
    for (const t of timed) {
      if (t == null) continue
      out.push(t)
    }
    return out
  }

  /**
   * Common path for {@link getPromptBlock} and the `sessionContext` half of
   * {@link getPromptBlocksAsync}. If `fragmentTexts` is `null`, fragments
   * are omitted entirely (sync path used for the session hash). Otherwise
   * only sessionContext-placement fragment text is folded into the same
   * plugin's section body (callers must filter placement before passing).
   *
   * Each contributing plugin yields exactly ONE `<ma::sys::ROLE name="…">`
   * section: its `PROMPT.md` body (leading H1 stripped) followed by any
   * resolved sessionContext fragment text. The role + name come from
   * {@link classifyPluginPrompt} (manifest-shape inference, no manifest
   * field, no plugin id leaked to the model). Sections sort by
   * {@link PROMPT_ROLE_ORDER} then by name so the composed block is
   * byte-stable for a given plugin set (the system prompt is cached).
   *
   * A plugin with NO `PROMPT.md` AND NO resolved sessionContext fragments
   * is silent: it contributes no section. We do NOT fall back to
   * `manifest.description` (that would leak per-plugin dev docs into the
   * cached system prompt). If every loaded plugin is silent, this returns
   * `null`, same as having no plugins at all.
   *
   * afterInstructions fragments never enter this path.
   */
  private buildBlock(fragmentTexts: Map<string, string[]> | null): SessionContextResult {
    return composeSessionContext({
      plugins: this.plugins,
      fragmentTexts,
      pluginPrompts: this.pluginPrompts,
      availability: createToolAvailabilityContext(this.agent),
      logger: this.logger,
    })
  }

  /**
   * Owners of the plugin system-prompt text: afterInstructions fragment
   * ranges and sessionContext sections. `undefined` until
   * {@link getPromptBlocksAsync} resolved.
   */
  getPromptProvenance(): PromptProvenance | undefined {
    return this.promptProvenance
  }

  /** Plugin tool name (canonical, dynamic tools included) to owner plugin. No core tool. */
  toolOwners(): ReadonlyMap<string, ToolOwner> {
    return collectToolOwners(this.plugins)
  }

  /**
   * True if a loaded plugin claims this tool name — either as a canonical
   * name or as a registered alias. Used by the agent loop to decide
   * whether to dispatch a `tool_use` block to a plugin handler.
   */
  hasTool(name: string): boolean {
    return this.toolIndex.has(name) || this.aliasIndex.has(name)
  }

  /** The one synthetic text resolver of this loader ("" for a kind with no provider). */
  syntheticText(): SyntheticTextResolver {
    return this.synthetic.resolver
  }

  /** Synthetic text providers of the loaded plugins, in precedence order. */
  syntheticTextProviders(): readonly SyntheticTextProvider[] {
    return this.synthetic.providers
  }

  /** The boot contract check result (missing and duplicate contract ids). */
  contractCheck(): ContractCheckResult {
    return this.contractCheckResult
  }

  /** Built-in tool text providers of the loaded plugins, in precedence order. */
  toolTextProviders(): readonly ToolTextProvider[] {
    return this.toolText
  }

  /** Manifest ids of the loaded plugins, in load order. */
  loadedPluginIds(): string[] {
    return this.plugins.map((p) => p.manifest.id)
  }

  /**
   * Register dynamic tool handlers into the loader's tool index.
   *
   * Called by prompt-fragment producers (e.g. the skills plugin) to push
   * skill-declared tools into the model's function list at boot time —
   * before any turn starts. Handlers registered here appear in
   * {@link getExtraTools} and are dispatched by {@link dispatch} alongside
   * manifest-declared tools.
   *
   * A handler whose name collides with an existing tool (core built-in
   * or already-registered plugin tool) is dropped with a diagnostic.
   *
   * @param pluginId - The plugin that owns these dynamic handlers.
   * @param handlers - ResolvedHandler objects to register.
   */
  registerDynamicTools(pluginId: string, handlers: ResolvedHandler[]): void {
    for (const h of handlers) {
      const name = h.definition.trigger.type === "tool" ? h.definition.trigger.tool.name : undefined
      if (!name) continue
      if (this.coreToolNames.has(name)) {
        this.logger(`dynamic tool "${name}" from ${pluginId} collides with a core tool; skipping`)
        continue
      }
      if (this.toolIndex.has(name) || this.aliasIndex.has(name)) {
        this.logger(`dynamic tool "${name}" from ${pluginId} collides with existing tool; skipping`)
        continue
      }
      this.toolIndex.set(name, h)
      const pkg = this.plugins.find((p) => p.manifest.id === pluginId)
      if (pkg) pkg.handlers.push(h)
    }
  }

  /**
   * Read-only snapshot of the alias-to-canonical map. Consumers (e.g.
   * the agent's `toolPresentation` builder) use this to mirror the
   * canonical tool's icon/color into the alias slots so transcript
   * rendering stays consistent when the model emits an old name.
   *
   * Returns a fresh Map each call; callers can mutate without affecting
   * the loader.
   */
  getToolAliases(): Map<string, string> {
    return new Map(this.aliasIndex)
  }

  /** True if a loaded plugin claims this inline tag name. */
  hasInlineTag(tag: string): boolean {
    return this.tagIndex.has(tag)
  }

  /**
   * Lazily build (and memoize) the frozen capability host for a plugin,
   * keyed by plugin id. Returns `undefined` when the plugin declared no
   * `capabilities` in its manifest — `ctx.host` stays absent and the
   * plugin has zero host-data access (deny-by-default).
   */
  private hostFor(pluginId: string): PluginHost | undefined {
    if (!pluginId) return undefined
    const cached = this.hostCache.get(pluginId)
    if (cached) return cached
    const pkg = this.plugins.find((p) => p.manifest.id === pluginId)
    const caps = pkg?.manifest.capabilities ?? []
    if (caps.length === 0) return undefined
    const host = buildPluginHost({
      capabilities: caps,
      logger: createPluginLogger(pluginId, this.relay),
      pluginName: pluginId,
      sessionsDir: this.hostOptions?.sessionsDir,
      ...(this.agent ? { activeSessionId: this.agent.sessionId } : {}),
      beforeHistoryEditCommit: async (input) => {
        if (!this.historyEditCommitHandler)
          throw new Error("history edit reload handler unavailable")
        await this.historyEditCommitHandler.beforeCommit(input)
      },
      onHistoryEditCommitted: async (notice) => {
        if (!this.historyEditCommitHandler)
          throw new Error("history edit reload handler unavailable")
        await this.historyEditCommitHandler.afterCommit(notice)
      },
      isHistoryEditCommitReady: () => this.historyEditCommitHandler !== undefined,
    })
    this.hostCache.set(pluginId, host)
    return host
  }

  /**
   * Public accessor for a plugin's frozen capability host (delegates to the
   * memoized {@link hostFor}). The live-area scheduler uses this to thread
   * `ctx.host` into live-area slot handlers, so a slot (e.g. `quota-status`)
   * reads host data via `ctx.host.sessionInfo` without importing `src/`.
   * Returns `undefined` when the plugin declared no `capabilities`.
   */
  capabilityHostFor(pluginId: string): PluginHost | undefined {
    return this.hostFor(pluginId)
  }

  /** Register the live-session reload coordinator used after history-edit commits. */
  setHistoryEditCommitHandler(handler: {
    beforeCommit: (
      input: import("./host/providers/sessions-write.ts").PreparedHistoryEditCommit,
    ) => Promise<void>
    afterCommit: (
      notice: import("./host/providers/sessions-write.ts").HistoryEditCommitNotice,
    ) => Promise<void>
  }): void {
    this.historyEditCommitHandler = handler
  }

  /**
   * Route a trigger to the matching handler and return its result.
   *
   * Handler exceptions and timeouts are converted to either
   * `{kind: "tool_result", is_error: true}` (tool triggers) or
   * `{kind: "rendered", ansi: raw-bytes}` (inline triggers) so the agent
   * loop never crashes on a bad plugin.
   *
   * @param trigger - The activation event.
   * @param agentCwd - The agent's current working directory.
   * @param externalSignal - Optional caller-provided AbortSignal (typically
   *   the agent's per-turn abort). When provided, it is OR-ed with the
   *   loader's internal timeout controller — either source firing aborts
   *   the handler's `ctx.abort`. Without this, Esc / Ctrl+C while a
   *   plugin tool was running could not reach the handler's subprocess
   *   (regression #mpdXX, see loader.test.ts "dispatch external
   *   AbortSignal" block for the full story).
   */
  async dispatch(
    trigger: ToolTrigger,
    agentCwd: string,
    externalSignal?: AbortSignal,
  ): Promise<ToolHandlerResult> {
    let handler: ResolvedHandler | undefined
    if (trigger.type === "tool") {
      // Canonical lookup first. On miss, fall through to the alias map —
      // the canonical handler runs unmodified; the alias name lives only
      // in the trigger and the JSONL log. Result content/display are
      // returned byte-identical to a canonical-name call. See `aliases`
      // on `ManifestTrigger.tool` for the public contract.
      handler = this.toolIndex.get(trigger.name)
      if (!handler) {
        const canonical = this.aliasIndex.get(trigger.name)
        if (canonical) handler = this.toolIndex.get(canonical)
      }
    } else {
      handler = this.tagIndex.get(trigger.name)
    }

    if (!handler) {
      return trigger.type === "tool"
        ? {
            kind: "tool_result",
            content: unknownPluginToolText(this.syntheticText(), trigger.name),
            is_error: true,
          }
        : { kind: "rendered", ansi: "" }
    }

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs).unref?.()
    void timer

    // Compose the caller's signal with the internal timeout controller.
    // Either source firing aborts ctx.abort. The listener is `once` and
    // attached only when the caller actually supplied a signal.
    let externalAbortListener: (() => void) | undefined
    if (externalSignal) {
      if (externalSignal.aborted) {
        ctrl.abort()
      } else {
        externalAbortListener = () => ctrl.abort()
        externalSignal.addEventListener("abort", externalAbortListener, {
          once: true,
        })
      }
    }

    const pluginId = findPluginIdFor(this.plugins, handler)
    const host = this.hostFor(pluginId)
    const packageDir = findPackageDirFor(this.plugins, handler)
    const ctx: ToolHandlerContext = {
      trigger,
      packageDir,
      cwd: agentCwd,
      env: buildHandlerEnv(this.agent),
      abort: ctrl.signal,
      ...(this.stdio?.stdout ? { stdout: this.stdio.stdout } : {}),
      ...(this.stdio?.stdin ? { stdin: this.stdio.stdin } : {}),
      ...(this.stdio?.stderr ? { stderr: this.stdio.stderr } : {}),
      log: createPluginLogger(pluginId, this.relay),
      agent: this.agent,
      ...(pluginId
        ? { prompts: createPluginPromptsContext(this.promptProvider, pluginId, packageDir) }
        : {}),
      ...(this.modelInfoProvider ? { queryModelInfo: this.modelInfoProvider } : {}),
      ...(this.recommendSubagentModels
        ? { recommendSubagentModels: this.recommendSubagentModels }
        : {}),
      ...(this.hostPolicySource ? { queryHostPolicy: this.hostPolicySource } : {}),
      ...(this.startupProfileInfo ? { startupProfile: this.startupProfileGetter } : {}),
      ...(host ? { host } : {}),
      emitChain: (ch, payload) =>
        this.hooksFacade
          .emitChain(ch, payload)
          .catch(() => ({ payload, halted: false as const, additionalContext: [] })),
    }

    try {
      const result = await handler.invoke(ctx)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (trigger.type === "tool") {
        return {
          kind: "tool_result",
          content: pluginHandlerErrorText(this.syntheticText(), msg),
          is_error: true,
        }
      }
      // Inline handler: emit empty render and let the caller fall back to raw.
      return { kind: "rendered", ansi: "" }
    } finally {
      // Drop our listener on the caller's signal so we don't pin a long-lived
      // turn AbortController via a still-attached listener after the handler
      // has returned. The internal timeout timer is `.unref()`-d already.
      if (externalSignal && externalAbortListener) {
        externalSignal.removeEventListener("abort", externalAbortListener)
      }
    }
  }

  /** Run optional plugin setup handlers without performing host-side effects. */
  async runSetups(
    inventory: SetupBinaryInventory,
  ): Promise<Array<{ pluginId: string; result: SetupResult }>> {
    return runPluginSetups(
      this.plugins,
      inventory,
      this.logger,
      this.timeoutMs,
      this.agent,
      this.relay,
    )
  }
}

import {
  CONTRACT_CHECK_PASSED,
  type ContractCheckResult,
  resolveContractOwners,
  runContractCheck,
} from "./loader/contract-owners.ts"
import { orderBootProviders } from "./loader/discovery.ts"
import {
  afterInstructionsSpans,
  CommandRegistry,
  collectEventSubscriptions,
  collectHookSubscriptions,
  collectPluginTools,
  collectToolOwners,
  createToolAvailabilityContext,
  DEFAULT_FRAGMENT_TIMEOUT_MS,
  discoverAndParsePackages,
  findFragmentDef,
  findPackageDirFor,
  findPluginIdFor,
  groupSessionContextFragments,
  joinAfterInstructions,
  type PendingFragment,
  type PluginPromptBlocks,
  type PromptProvenance,
  type ResolvedFragment,
  registerEventSub,
  registerHookSub,
  registerManifestReplayRenderers,
  registerManifestTurnAttachments,
  resolveCommand,
  resolveEventSub,
  resolveHandler,
  runPluginSetups,
  type ToolOwner,
} from "./loader/late.ts"
import { composeSessionContext, type SessionContextResult } from "./loader/session-context.ts"
import * as promptBoot from "./loader/system-prompt-base-boot.ts"

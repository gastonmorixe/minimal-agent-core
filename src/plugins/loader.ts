/**
 * Plugin loader.
 *
 * Discovers plugin packages under two roots (home + project), parses
 * their manifests, resolves handler entry points, and exposes three
 * capabilities to the rest of the agent:
 *
 * 1. {@link PluginLoader.getExtraTools} — tool definitions to merge into the
 *    API request `tools` array alongside the core tools.
 * 2. {@link PluginLoader.getPromptBlock} — a string to append to the system
 *    prompt so the model knows when to emit tool calls or inline tags.
 * 3. {@link PluginLoader.dispatch} — route a trigger to the matching handler
 *    and return its `TUIResult`.
 *
 * The loader is dependency-free (no JSON schema libs, no plugin registries).
 * All validation runs through {@link parseManifest} in `./manifest.ts`.
 *
 * Conflicts (tool names vs core, tool names across plugins, inline tag names
 * across plugins, package ids across roots) are resolved eagerly at load
 * time. On collision, the later package is dropped and a diagnostic is
 * routed through the optional logger. Core tools always win.
 *
 * **Spec:** `/Users/gaston/.claude/plans/polished-drifting-dijkstra.md`,
 * section "Loader lifecycle".
 *
 * @module plugins/loader
 */

import { paletteEnvJson } from "@minimal-agent/plugin-api/utils/palette"
import type { NormalizedPlatform } from "@minimal-agent/plugin-api/utils/platform"

import { createPluginLogger, diag } from "../bus/diagnostic-bus.ts"

import { agentContextToEnv, createAgentContext } from "./agent-context.ts"
import { EventBus } from "./event-bus.ts"
import { CHANNEL_BY_NAME, hasPermission } from "./hooks/channels.ts"
import { Hooks } from "./hooks/hooks.ts"
import type { PluginHost } from "./host/capabilities.ts"
import { buildPluginHost } from "./host/factory.ts"
import type {
  AgentContext,
  CommandInfo,
  CommandResult,
  LoadedPlugin,
  ManifestMode,
  ModelInfoSnapshot,
  ResolvedCommand,
  ResolvedEventSub,
  ResolvedHandler,
  ResolvedHookSub,
  ResolvedLiveAreaSlot,
  SetupBinaryInventory,
  SetupResult,
  SubagentModelRecommendation,
  ToolAvailabilityContext,
  TUIContext,
  TUIResult,
  TUITrigger,
} from "./types.ts"

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
  /** Optional cosmetic glyph shown in transcript headers. Not sent to API. */
  icon?: string
  /** Optional cosmetic color name (palette key) for the tool label. Not sent to API. */
  color?: string
  /**
   * Optional input field name to surface synchronously in the transcript
   * header (e.g. `"url"`). Lets a long-running plugin tool show a clean,
   * identifying header the moment the call starts. Not sent to API.
   */
  headerKey?: string
}

/** Options for {@link PluginLoader.load}. */
export interface PluginLoaderOptions {
  /**
   * Absolute path to the agent's install directory (the dir containing
   * `src/` and the bundled `plugins/`). The loader looks for a
   * `plugins/` subdirectory under this path. These are the
   * "embedded" / built-in plugins that ship with minimal-agent itself
   * (e.g. ask-mode, diff-view, env-info, memory). Lowest precedence on
   * package-id collision — project and home both shadow embedded.
   *
   * Wired from `import.meta.dirname` in `src/index.ts` so the embedded
   * plugins load regardless of the user's cwd.
   */
  embeddedDir?: string
  /**
   * Absolute path to the user's home-dir plugins root. The loader looks for
   * a `plugins/` subdirectory under this path. Defaults to
   * `~/.agents`.
   */
  homeDir?: string
  /**
   * Absolute path to minimal-agent's OWN per-user plugins root (the loader
   * looks for a `plugins/` subdirectory under this path). Wired in
   * `src/index.ts` to `~/.minimal-agent`, which is where the first-run
   * bootstrap clones the `minimal-agent-plugins` repo. These are the
   * "extended first-party" plugins (Fetch, Skill, slash-menu, …): they sit
   * ABOVE embedded built-ins but BELOW the user's hand-curated home
   * (`~/.agents/plugins`) and project (`.agents/plugins`) roots on
   * package-id collision, so a developer who symlinks a working copy into
   * either of those always shadows the auto-cloned one.
   */
  userDir?: string
  /**
   * Absolute path to the project root (typically the agent's cwd). The
   * loader looks for a `.agents/plugins/` subdirectory under this
   * path. Highest precedence — project plugins shadow home and embedded
   * on package-id collision.
   */
  projectDir?: string
  /**
   * Absolute dirs that DIRECTLY contain plugin package dirs (each an
   * immediate subdir with a `manifest.json`), NOT under a `plugins/`
   * subdir. This is the dev-time seam for the sibling
   * `../minimal-agent-plugins` checkout, whose plugin dirs live at its
   * ROOT. Their packages enter at the lowest ("embedded") precedence tier,
   * so user/home/project shadow them on package-id collision. Wired from
   * `src/index.ts` (a computed sibling path or the
   * `MINIMAL_AGENT_PLUGIN_SIBLINGS` override) only when the dir exists.
   * Production leaves this unset — the sibling repo is cloned into
   * `userDir` there.
   */
  siblingDirs?: string[]
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
   * env vars via {@link agentContextToEnv}.
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
   * exposes to module handlers as {@link TUIContext.queryModelInfo}, so a
   * decoupled `ModelInfo` tool always sees the model the agent will send next
   * (correct across mid-session switches + resume). The host builds it over its
   * live model id + the shared registry; omit it to leave `queryModelInfo`
   * undefined (back-compat).
   */
  modelInfoProvider?: () => ModelInfoSnapshot | undefined
  /**
   * Live provider of the ACTIVE model's sub-agent model recommendations,
   * exposed to module handlers as {@link TUIContext.recommendSubagentModels}.
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
   * Wired in `src/index.ts` from `~/.minimal-agent/config.jsonc`:
   * any plugin whose `plugins.<id>.enabled` is `false` lands here. This
   * gives every plugin (current and future) a uniform opt-out without
   * each plugin having to implement disabling itself.
   */
  disabledPluginIds?: Set<string>
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
   * The effective platform to gate manifest/tool `platforms` whitelists
   * against. Omit to use the host's detected platform
   * ({@link detectPlatform}). `src/index.ts` resolves an env
   * (`MINIMAL_AGENT_PLATFORM`) / CLI (`--platform`) override and passes
   * it here; the `all` bypass loads every plugin/tool regardless of
   * whitelist. See `@minimal-agent/plugin-api/utils/platform`.
   */
  effectivePlatform?: NormalizedPlatform
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FRAGMENT_ORDER = 100

/**
 * One async prompt fragment in flight.
 *
 * `promise` resolves to the fragment text or `null` (timeout / handler
 * error / not started). Each fragment is started eagerly at
 * {@link PluginLoader.load} and awaited at the first call to
 * {@link PluginLoader.getPromptBlockAsync}.
 */
interface PendingFragment {
  pluginId: string
  fragmentId: string
  order: number
  startedAt: number
  promise: Promise<string | null>
}

/**
 * Derive CamelCase prefix from a plugin's display name.
 *
 * Splits on word boundaries (spaces and hyphens), capitalizes each token,
 * and joins. The plugin author can override this via `manifest.camelName`.
 *
 * Examples:
 *   "Background Jobs"  → "BackgroundJobs"
 *   "Sub-agents"       → "SubAgents"
 *   "Diff Viewer"      → "DiffViewer"
 */
function deriveCamelName(name: string): string {
  return name
    .split(/[\s-]+/)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join("")
}

/**
 * Compute the effective canonical tool name after applying the auto-prefix
 * convention.
 *
 * Rules:
 * 1. If `explicitName` is `true`, the tool name passes through unchanged.
 * 2. Otherwise, the name is prefixed with the plugin's CamelCase name
 *    (from `manifest.camelName` if set, else derived from `manifest.name`).
 * 3. Automated migration alias: the ORIGINAL `tool.name` is returned as
 *    `migrationAlias` so the loader can register it as a deprecation alias.
 */
function computeEffectiveName(
  toolName: string,
  explicitName: boolean | undefined,
  manifestName: string,
  camelNameOverride: string | undefined,
): { canonical: string; migrationAlias: string | null } {
  if (explicitName === true) {
    return { canonical: toolName, migrationAlias: null }
  }
  const prefix = camelNameOverride ?? deriveCamelName(manifestName)
  const canonical = `${prefix}${toolName}`
  if (canonical === toolName) {
    // Perfect collision — the tool name already matches the convention.
    // Don't rewrite, don't alias.
    return { canonical: toolName, migrationAlias: null }
  }
  return { canonical, migrationAlias: toolName }
}

/**
 * Loaded collection of plugins with a dispatch entry point.
 *
 * Call {@link load} once at agent startup. The resulting loader is
 * reusable across turns and immutable after construction.
 */
export class PluginLoader {
  private readonly plugins: LoadedPlugin[]
  private readonly toolIndex: Map<string, ResolvedHandler>
  /**
   * Alias → canonical-tool-name map. Built once at load time. The
   * dispatcher consults this on a {@link toolIndex} miss; aliases are
   * never advertised to the model (see `getExtraTools`) and never
   * mutate the result on hit. See manifest's `tool.aliases` field for
   * the public contract.
   */
  private readonly aliasIndex: Map<string, string>
  private readonly tagIndex: Map<string, ResolvedHandler>
  private readonly coreToolNames: Set<string>
  private readonly modes: LoadedMode[]
  private readonly defaultModeId: string | null
  private readonly timeoutMs: number
  private readonly eventBus: EventBus
  /**
   * Hooks facade. Wraps {@link eventBus} (for `broadcast-async` channels)
   * AND an internal {@link HookBus} (for `chain`, `broadcast-sync`, `stream`
   * channels). Plugin `manifest.hooks` entries are subscribed here at load
   * time. Host code (the editor's key dispatch, REPL lifecycle) emits
   * through the same facade so plugins see a uniform surface.
   */
  private readonly hooksFacade: Hooks
  private readonly pendingFrags: PendingFragment[]
  private readonly logger: (msg: string) => void
  /**
   * Main-agent identity (session id, pid, model, version) if one was
   * provided to {@link load}. Forwarded to every dispatched handler as
   * `ctx.agent` and as `MINIMAL_AGENT_*` env vars for subprocesses, via
   * {@link agentContextToEnv}.
   *
   * `undefined` only when neither `agent` nor the deprecated `sessionId`
   * was supplied (ad-hoc tests).
   */
  private readonly agent: AgentContext | undefined
  /** Live current-model snapshot provider; see {@link PluginLoaderOptions.modelInfoProvider}. */
  private readonly modelInfoProvider: (() => ModelInfoSnapshot | undefined) | undefined
  /** Live sub-agent model recommendations provider; see {@link PluginLoaderOptions.recommendSubagentModels}. */
  private readonly recommendSubagentModels: (() => SubagentModelRecommendation[]) | undefined
  /**
   * Cached result of {@link getPromptBlockAsync}. Populated on first call
   * (after fragments resolve or time out). Subsequent calls return this
   * without re-awaiting — the system prompt sits on a cache breakpoint
   * and must be byte-stable for the rest of the session.
   */
  private asyncBlockCache: string | null | undefined = undefined
  /**
   * Global slash-command registry, keyed by command name (no slash).
   * Built in the constructor from each plugin's resolved `commands` with
   * first-wins collision handling. The host's `dispatchCommand` and the
   * `slash-menu` overlay (via `listCommandInfo`) read it.
   *
   * Lives in {@link CommandRegistry} (extracted to `./loader/commands.ts`
   * for T-8a0c44).
   */
  private readonly commands: CommandRegistry
  /**
   * Per-plugin capability hosts, memoized by plugin id. Built lazily on
   * first dispatch to a handler whose manifest declared `capabilities`.
   * One frozen host per plugin for the loader's lifetime — handler calls
   * across turns see the same object identity (cheap, and consistent
   * with the frozen-value-object discipline of {@link AgentContext}).
   */
  private readonly hostCache = new Map<string, PluginHost>()
  /** Capability-host overrides (test sessionsDir injection). See {@link PluginLoaderOptions.hostOptions}. */
  private readonly hostOptions: { sessionsDir?: string } | undefined

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
  ) {
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
    // Default logger fans out through the diagnostic bus so warnings get
    // the gold ⚠ chrome via `ScrollbackDiagnosticSink`, RFC 5424 records in
    // the file log, and the optional `MINIMAL_AGENT_LOG_STDERR=1` mirror —
    // instead of racing the startup banner box with a raw stderr write.
    // Tests inject their own logger and bypass the bus.
    const logger = opts.logger ?? ((msg: string) => diag.warn("plugin-loader", msg))
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

    // Discover packages under all four roots, dedupe by realpath, parse
    // + gate manifests, and resolve PROMPT.md bodies. Lives in
    // `src/plugins/loader/discovery.ts`; see that module for the
    // precedence / opt-out / dead-weight rules.
    const { parsed, replayRenderersRaw, turnAttachmentsRaw } = discoverAndParsePackages({
      ...(opts.embeddedDir !== undefined ? { embeddedDir: opts.embeddedDir } : {}),
      ...(opts.userDir !== undefined ? { userDir: opts.userDir } : {}),
      ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
      ...(opts.projectDir !== undefined ? { projectDir: opts.projectDir } : {}),
      ...(opts.siblingDirs !== undefined ? { siblingDirs: opts.siblingDirs } : {}),
      logger,
      explicitLogger: opts.logger,
      disabledPluginIds,
      enabledPluginIds,
      ...(opts.effectivePlatform !== undefined
        ? { effectivePlatform: opts.effectivePlatform }
        : {}),
    })

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
      let packageRejected = false
      let rejectReason = ""

      // First pass: collision check. A plugin is accepted only if ALL of its
      // tool names / tag names / aliases are conflict-free. Partial
      // acceptance would mean the plugin's PROMPT.md lies about what's
      // available.
      //
      // Aliases are checked against:
      //   - core tool names (no alias may shadow a core tool)
      //   - other plugins' canonical tool names (alias must not point at
      //     a different tool's canonical surface)
      //   - already-registered aliases (alias must not collide with
      //     another plugin's alias)
      // (Self-collision — alias === own canonical name, dups within the
      // alias array — is caught earlier in the manifest parser.)
      for (const h of pkg.manifest.tuis ?? []) {
        if (h.trigger.type === "tool") {
          const name = h.trigger.tool.name
          if (coreToolNames.has(name)) {
            packageRejected = true
            rejectReason = `tool name "${name}" collides with a core tool`
            break
          }
          if (toolIndex.has(name) || aliasIndex.has(name)) {
            packageRejected = true
            rejectReason = `tool name "${name}" collides with another loaded plugin`
            break
          }
          const validAliases: string[] = []
          for (const alias of h.trigger.tool.aliases ?? []) {
            if (coreToolNames.has(alias)) {
              logger(`dropping alias "${alias}" for tool "${name}": collides with a core tool`)
              continue
            }
            if (toolIndex.has(alias)) {
              logger(
                `dropping alias "${alias}" for tool "${name}": collides with another plugin's canonical tool`,
              )
              continue
            }
            if (aliasIndex.has(alias)) {
              logger(
                `dropping alias "${alias}" for tool "${name}": collides with another plugin's alias`,
              )
              continue
            }
            validAliases.push(alias)
          }
          h.trigger.tool.aliases = validAliases
          if (packageRejected) break
        } else if (h.trigger.type === "inline_tag") {
          const tag = h.trigger.tag
          if (tagIndex.has(tag)) {
            packageRejected = true
            rejectReason = `inline tag "${tag}" collides with another loaded plugin`
            break
          }
        }
      }

      if (packageRejected) {
        logger(`skipping ${pkg.packageDir}: ${rejectReason}`)
        continue
      }

      // Second pass: resolve handler entry points.
      let resolveFailed = false
      for (const h of pkg.manifest.tuis ?? []) {
        const resolved = await resolveHandler(h, pkg.packageDir, logger)
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
        )
      }

      // Resolve hook subscriptions. Same lenient policy as events: a broken
      // hook handler is logged and skipped, never disqualifies the plugin.
      // Permission gate runs first — a hook on a channel the manifest's
      // `permissions[]` doesn't grant is dropped with a clear log.
      //
      // `requiresUnsafeHooks: true` is honored at the plugin level: when
      // the manifest sets it AND `UNSAFE_HOOKS=1` is unset, we skip every
      // hook subscription this plugin declares (the plugin's tools / tags /
      // events continue to work).
      const unsafeOk = process.env.UNSAFE_HOOKS === "1"
      const skipAllHooks = (pkg.manifest.requiresUnsafeHooks ?? false) && !unsafeOk
      if (skipAllHooks) {
        logger(
          `${pkg.packageDir}: skipping all hooks for plugin "${pkg.manifest.id}" — ` +
            `manifest.requiresUnsafeHooks is true but UNSAFE_HOOKS=1 is not set`,
        )
      }
      const resolvedHookSubs: ResolvedHookSub[] = []
      if (!skipAllHooks) {
        const granted = pkg.manifest.permissions ?? []
        for (const sub of pkg.manifest.hooks ?? []) {
          const spec = CHANNEL_BY_NAME.get(sub.channel)
          if (!spec) {
            logger(
              `${pkg.packageDir}: hook "${sub.id}" — channel "${sub.channel}" is not ` +
                `in the catalog; skipping`,
            )
            continue
          }
          if (!hasPermission(granted, spec.permission)) {
            logger(
              `${pkg.packageDir}: hook "${sub.id}" — channel "${sub.channel}" requires ` +
                `permission "${spec.permission}", but manifest.permissions doesn't grant it; skipping`,
            )
            continue
          }
          const r = await resolveHookSub(sub, pkg.packageDir, logger)
          if (r) resolvedHookSubs.push(r)
        }
      }
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
        )
      }

      // Resolve live-area slots. Same lenient policy as event subs: a
      // missing/broken slot handler doesn't disqualify the plugin's tools.
      const resolvedSlots: ResolvedLiveAreaSlot[] = []
      for (const slot of pkg.manifest.liveAreaSlots ?? []) {
        const r = await resolveLiveAreaSlot(slot, pkg.manifest.id, pkg.packageDir, logger)
        if (r) resolvedSlots.push(r)
      }
      pkg.liveAreaSlots = resolvedSlots

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

      finalPlugins.push(pkg)
    }

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
    const pendingFrags: PendingFragment[] = []
    for (const pkg of finalPlugins) {
      for (const frag of pkg.manifest.promptFragments ?? []) {
        const startedAt = Date.now()
        const promise = startFragment(
          frag,
          pkg.packageDir,
          logger,
          agent,
          pkg.manifest.id,
          opts.modelInfoProvider,
          (handlers: ResolvedHandler[]) => {
            loaderRef?.registerDynamicTools(pkg.manifest.id, handlers)
          },
          // Capability host for THIS plugin (deny-by-default: undefined when it
          // declared none), so a prompt fragment can run a host-brokered action
          // like memory's `ctx.host.llm.complete`. Built directly here because
          // fragments start before `loaderRef` is assigned; mirrors `hostFor`.
          (pkg.manifest.capabilities?.length ?? 0) > 0
            ? buildPluginHost({
                capabilities: pkg.manifest.capabilities ?? [],
                logger: createPluginLogger(pkg.manifest.id),
                ...(opts.hostOptions?.sessionsDir
                  ? { sessionsDir: opts.hostOptions.sessionsDir }
                  : {}),
              })
            : undefined,
        )
        pendingFrags.push({
          pluginId: pkg.manifest.id,
          fragmentId: frag.id,
          order: frag.order ?? DEFAULT_FRAGMENT_ORDER,
          startedAt,
          promise,
        })
      }
    }
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
    const commandRegistry = new CommandRegistry(allCommands, {
      timeoutMs,
      agent,
      eventBus,
      hooksFacade,
      logger,
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
    )
    // Resolve the forward-ref so handler contexts created earlier can
    // read the now-built command registry via `ctx.listCommands()`.
    loaderRef = loader
    return loader
  }

  /** All loaded modes contributed by plugins (in plugin-load order). */
  getModes(): LoadedMode[] {
    return [...this.modes]
  }

  /**
   * All registered slash commands (post collision-dedupe), sorted by
   * name for stable display. The host's command dispatcher and the
   * `slash-menu` overlay both read this.
   *
   * Delegates to {@link CommandRegistry.getCommands}.
   */
  getCommands(): ReadonlyArray<ResolvedCommand> {
    return this.commands.getCommands()
  }

  /**
   * O(1) check whether a command name is registered. The REPL uses this
   * to decide, synchronously at submit time, whether a `/<name>` line is
   * a command (dispatch it) or just text (queue it as a prompt).
   *
   * @param name - Command name without the leading slash.
   *
   * Delegates to {@link CommandRegistry.hasCommand}.
   */
  hasCommand(name: string): boolean {
    return this.commands.hasCommand(name)
  }

  /**
   * Read-only metadata view of every registered command. This is the
   * shape exposed to plugin handler contexts via `listCommands()` so the
   * `slash-menu` overlay can render/filter without importing the loader.
   *
   * Delegates to {@link CommandRegistry.listCommandInfo}.
   */
  listCommandInfo(): CommandInfo[] {
    return this.commands.listCommandInfo()
  }

  /**
   * Dispatch a submitted line as a slash command.
   *
   * Returns `null` when `line` is not a command line OR names an
   * unregistered command — in both cases the host treats the text as an
   * ordinary prompt (so pasted paths like `/usr/bin` and unknown `/foo`
   * fall through untouched). Returns a {@link CommandResult} otherwise;
   * a handler throw (or malformed return) is caught and surfaced as
   * `{kind:"error"}` so a buggy command never crashes the REPL.
   *
   * The `opts` bag carries `cwd` (defaults to `process.cwd()`) and an
   * optional external abort `signal` composed with the per-call timeout.
   *
   * @param line - Raw submitted text.
   *
   * Delegates to {@link CommandRegistry.dispatchCommand}.
   */
  async dispatchCommand(
    line: string,
    opts: { cwd?: string; signal?: AbortSignal } = {},
  ): Promise<CommandResult | null> {
    return this.commands.dispatchCommand(line, opts)
  }

  /** Mode id flagged `default: true`, or `null` if none. */
  getDefaultModeId(): string | null {
    return this.defaultModeId
  }

  /**
   * Event subscriptions installed on the bus, flattened across all
   * plugins. Useful for diagnostics and tests; not needed at runtime
   * (the bus is the source of truth).
   */
  getEventSubs(): ReadonlyArray<{ pluginId: string; sub: ResolvedEventSub }> {
    const out: { pluginId: string; sub: ResolvedEventSub }[] = []
    for (const pkg of this.plugins) {
      for (const s of pkg.eventSubs) out.push({ pluginId: pkg.manifest.id, sub: s })
    }
    return out
  }

  /**
   * Hook subscriptions installed on the hooks facade, flattened across
   * all plugins. Diagnostics-only — the facade is the runtime source
   * of truth.
   */
  getHookSubs(): ReadonlyArray<{ pluginId: string; sub: ResolvedHookSub }> {
    const out: { pluginId: string; sub: ResolvedHookSub }[] = []
    for (const pkg of this.plugins) {
      for (const s of pkg.hookSubs) out.push({ pluginId: pkg.manifest.id, sub: s })
    }
    return out
  }

  /**
   * Live-area slots contributed by loaded plugins, flattened across all
   * packages. The REPL's live-area scheduler iterates this once at start
   * to wire periodic producers into the sticky bottom UI. Order is
   * stable (plugin-load order, then manifest declaration order).
   */
  getLiveAreaSlots(): ReadonlyArray<ResolvedLiveAreaSlot> {
    const out: ResolvedLiveAreaSlot[] = []
    for (const pkg of this.plugins) {
      for (const s of pkg.liveAreaSlots) out.push(s)
    }
    return out
  }

  /**
   * Build the read-only context a tool's `available` predicate sees. Keyed on
   * process-lifetime-stable facts (env, cwd, boot agent identity) so a tool's
   * advertisement decision is byte-stable across a session and the cached
   * system-prompt prefix doesn't churn turn-to-turn.
   */
  private availabilityContext(): ToolAvailabilityContext {
    return {
      env: { ...process.env } as Record<string, string>,
      cwd: process.cwd(),
      ...(this.agent ? { agent: this.agent } : {}),
    }
  }

  /**
   * Is this tool handler advertised to the model right now? A handler with no
   * `available` predicate is always advertised; otherwise the predicate
   * decides. A throwing predicate fails OPEN (the tool stays visible) and is
   * logged, so a buggy gate never silently strips a tool.
   */
  private isToolAvailable(h: ResolvedHandler, ctx: ToolAvailabilityContext): boolean {
    if (!h.available) return true
    try {
      return h.available(ctx) !== false
    } catch (e) {
      this.logger(
        `tool availability predicate threw for "${h.definition.trigger.type === "tool" ? h.definition.trigger.tool.name : h.definition.id}"; ` +
          `keeping the tool visible: ${e instanceof Error ? e.message : String(e)}`,
      )
      return true
    }
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
    const actx = this.availabilityContext()
    const out: PluginToolDefinition[] = []
    for (const pkg of this.plugins) {
      for (const h of pkg.handlers) {
        if (h.definition.trigger.type === "tool" && this.isToolAvailable(h, actx)) {
          out.push({
            name: h.definition.trigger.tool.name,
            description: h.definition.trigger.tool.description,
            input_schema: h.definition.trigger.tool.input_schema,
            ...(h.definition.icon ? { icon: h.definition.icon } : {}),
            ...(h.definition.color ? { color: h.definition.color } : {}),
            ...(h.definition.headerKey ? { headerKey: h.definition.headerKey } : {}),
          })
        }
      }
    }
    return out
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
    return this.buildBlock(null)
  }

  /**
   * Like {@link getPromptBlock} but additionally awaits and embeds the
   * resolved text of every {@link ManifestPromptFragment} contributed by
   * a loaded plugin.
   *
   * Each fragment has its own `timeoutMs` (default 2000ms). Fragments
   * that exceed it (or throw) are dropped silently with a diagnostic
   * logged through the loader's logger; the rest of the prompt assembles
   * normally.
   *
   * The result is memoized for the rest of the loader's lifetime — the
   * system prompt sits on a prompt-cache breakpoint and must be
   * byte-stable across turns. Volatile content (current date, terminal
   * size, ...) is therefore captured once and reused, which is what the
   * `(at session start)` framing in the env-info plugin describes.
   *
   * Safe to call from multiple turns concurrently: the second call sees
   * the cached value if the first completed, or awaits the same in-flight
   * resolution otherwise (callers race on the same fragment promises).
   */
  async getPromptBlockAsync(): Promise<string | null> {
    if (this.asyncBlockCache !== undefined) return this.asyncBlockCache
    const fragmentTexts = await this.resolveFragments()
    const block = this.buildBlock(fragmentTexts)
    this.asyncBlockCache = block
    return block
  }

  /**
   * Pending fragments still awaiting resolution. Useful for status-bar
   * indicators and diagnostics. Returns an empty array once
   * {@link getPromptBlockAsync} has fully resolved.
   */
  pendingFragments(): { pluginId: string; fragmentId: string; startedAt: number }[] {
    if (this.asyncBlockCache !== undefined) return []
    return this.pendingFrags.map((f) => ({
      pluginId: f.pluginId,
      fragmentId: f.fragmentId,
      startedAt: f.startedAt,
    }))
  }

  /**
   * Race each pending fragment against its declared timeout and collect
   * the resolved texts grouped by plugin id, ordered by `order`.
   */
  private async resolveFragments(): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    if (this.pendingFrags.length === 0) return out

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
          return { pluginId: f.pluginId, text: null }
        }
        return { pluginId: f.pluginId, text: result }
      }),
    )

    for (const t of timed) {
      if (t.text == null) continue
      const arr = out.get(t.pluginId) ?? []
      arr.push(t.text)
      out.set(t.pluginId, arr)
    }
    return out
  }

  /**
   * Common path for {@link getPromptBlock} and {@link getPromptBlockAsync}.
   * If `fragmentTexts` is `null`, fragments are omitted entirely (sync
   * path used for the session hash). Otherwise resolved fragment text is
   * folded into the same plugin's section body.
   *
   * Each contributing plugin yields exactly ONE `<ma::sys::ROLE name="…">`
   * section: its `PROMPT.md` body (leading H1 stripped) followed by any
   * resolved prompt-fragment text. The role + name come from
   * {@link classifyPluginPrompt} (manifest-shape inference, no manifest
   * field, no plugin id leaked to the model). Sections sort by
   * {@link PROMPT_ROLE_ORDER} then by name so the composed block is
   * byte-stable for a given plugin set (the system prompt is cached).
   *
   * A plugin with NO `PROMPT.md` AND NO resolved prompt fragments is
   * silent: it contributes no section. We do NOT fall back to
   * `manifest.description` (that would leak per-plugin dev docs into the
   * cached system prompt). If every loaded plugin is silent, this returns
   * `null`, same as having no plugins at all.
   */
  private buildBlock(fragmentTexts: Map<string, string[]> | null): string | null {
    if (this.plugins.length === 0) return null
    const actx = this.availabilityContext()
    const sections: { role: PromptRole; name: string; body: string }[] = []
    for (const pkg of this.plugins) {
      // Drop the prompt section for a plugin whose ENTIRE tool surface is
      // currently hidden by availability predicates. A multi-tool plugin keeps
      // its section as long as at least one tool is advertised (its shared
      // PROMPT.md still describes the visible tools). A plugin contributing no
      // tools at all (behavior/context) is never affected.
      const toolHandlers = pkg.handlers.filter((h) => h.definition.trigger.type === "tool")
      if (toolHandlers.length > 0 && !toolHandlers.some((h) => this.isToolAvailable(h, actx))) {
        continue
      }
      const promptBody = pkg.prompt ? stripLeadingHeading(pkg.prompt) : ""
      const frags = fragmentTexts?.get(pkg.manifest.id) ?? []
      const fragSection = frags.length > 0 ? frags.map((t) => t.trimEnd()).join("\n\n") : ""
      if (!promptBody && !fragSection) continue
      const body =
        promptBody && fragSection ? `${promptBody}\n\n${fragSection}` : promptBody || fragSection
      const { role, name } = classifyPluginPrompt(pkg)
      sections.push({ role, name, body })
    }
    if (sections.length === 0) return null
    // Deterministic order: role group, then name (alpha), then body as a
    // final tiebreak so two same-role same-name sections (unusual) stay
    // stable. Keeps the cached prefix byte-identical across discovery orders.
    sections.sort(
      (a, b) =>
        PROMPT_ROLE_ORDER[a.role] - PROMPT_ROLE_ORDER[b.role] ||
        a.name.localeCompare(b.name) ||
        (a.body < b.body ? -1 : a.body > b.body ? 1 : 0),
    )
    // Disambiguate same-(role,name) collisions deterministically. tool/emit/
    // mode names are already globally unique (the loader rejects colliding
    // tool/tag/mode ids before we get here), so this only ever fires for
    // behavior/context sections whose H1/display-name slugs happen to match.
    // Suffixing keeps every section addressable by a distinct name rather
    // than emitting two identical `name="…"` wrappers.
    const seen = new Map<string, number>()
    for (const s of sections) {
      const key = `${s.role}\u0000${s.name}`
      const n = (seen.get(key) ?? 0) + 1
      seen.set(key, n)
      if (n > 1) s.name = `${s.name}-${n}`
    }
    return sections
      .map(
        (s) =>
          `<ma::sys::${s.role} name="${escapeTagAttr(s.name)}">\n${s.body}\n</ma::sys::${s.role}>`,
      )
      .join("\n\n")
  }

  /**
   * True if a loaded plugin claims this tool name — either as a canonical
   * name or as a registered alias. Used by the agent loop to decide
   * whether to dispatch a `tool_use` block to a plugin handler.
   */
  hasTool(name: string): boolean {
    return this.toolIndex.has(name) || this.aliasIndex.has(name)
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
      logger: createPluginLogger(pluginId),
      sessionsDir: this.hostOptions?.sessionsDir,
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
    trigger: TUITrigger,
    agentCwd: string,
    externalSignal?: AbortSignal,
  ): Promise<TUIResult> {
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
            content: `Unknown plugin tool: ${trigger.name}`,
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
    const ctx: TUIContext = {
      trigger,
      packageDir: findPackageDirFor(this.plugins, handler),
      cwd: agentCwd,
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        MINIMAL_AGENT_PALETTE: paletteEnvJson(),
        ...(this.agent ? agentContextToEnv(this.agent) : {}),
      } as Record<string, string>,
      abort: ctrl.signal,
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
      log: createPluginLogger(pluginId),
      agent: this.agent,
      ...(this.modelInfoProvider ? { queryModelInfo: this.modelInfoProvider } : {}),
      ...(this.recommendSubagentModels
        ? { recommendSubagentModels: this.recommendSubagentModels }
        : {}),
      ...(host ? { host } : {}),
    }

    try {
      const result = await handler.invoke(ctx)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (trigger.type === "tool") {
        return { kind: "tool_result", content: `Handler error: ${msg}`, is_error: true }
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

  /**
   * Run every loaded plugin's optional `setup()` handler, in declaration
   * order, handing each the shared binary inventory. Returns the structured
   * {@link SetupResult}s (one per plugin that declares `setup`) WITHOUT
   * performing any side effect: the host (src/index.ts) owns downloads, TUI
   * progress, syslog audit, and halting boot.
   *
   * A plugin whose `setup()` throws is logged and skipped (its result is
   * dropped) so one broken setup can't poison boot. The handler is given a
   * per-call timeout via {@link timeoutMs}.
   *
   * @param inventory - The managed-binary inventory adapter the host builds
   *   from its `BinaryStore` (in `../binaries/store.ts`).
   */
  async runSetups(
    inventory: SetupBinaryInventory,
  ): Promise<Array<{ pluginId: string; result: SetupResult }>> {
    return runPluginSetups(this.plugins, inventory, this.logger, this.timeoutMs, this.agent)
  }
}

// ---------------------------------------------------------------------------
// Extracted submodules (kept under the max-lines lint budget):
//   ./loader/helpers.ts          — pure fs + handler-resolution helpers
//   ./loader/event-subs.ts       — event/hook/live-area/command resolution
//   ./loader/discovery.ts        — package discovery + manifest parsing
//   ./loader/fragments.ts        — async prompt-fragment producers
//   ./loader/replay-renderers.ts — --resume re-render seam
//   ./loader/turn-attachments.ts — per-turn attachment factory seam
//   ./loader/setups.ts           — plugin setup() execution
// ---------------------------------------------------------------------------

// Global slash-command registry (extracted T-8a0c44).
import { CommandRegistry } from "./loader/commands.ts"
// Package discovery + manifest parsing (the four-root walk, realpath
// dedupe, enable/disable gates, PROMPT.md resolution) lives in
// `src/plugins/loader/discovery.ts`.
import { discoverAndParsePackages } from "./loader/discovery.ts"
import {
  registerEventSub,
  registerHookSub,
  resolveCommand,
  resolveEventSub,
  resolveHookSub,
  resolveLiveAreaSlot,
} from "./loader/event-subs.ts"
// Async prompt-fragment producers (module + subprocess) live in
// `src/plugins/loader/fragments.ts`.
import { DEFAULT_FRAGMENT_TIMEOUT_MS, findFragmentDef, startFragment } from "./loader/fragments.ts"
// Pure filesystem + handler-resolution helpers live in
// `src/plugins/loader/helpers.ts`. Async event-sub / hook-sub /
// live-area-slot resolution + registration live in
// `src/plugins/loader/event-subs.ts`. Both are imported here for the
// `PluginLoader` class's internal use and are NOT re-exported (no
// external consumer of this module touched those names).
import {
  classifyPluginPrompt,
  escapeTagAttr,
  findPackageDirFor,
  findPluginIdFor,
  PROMPT_ROLE_ORDER,
  type PromptRole,
  resolveHandler,
  stripLeadingHeading,
} from "./loader/helpers.ts"
// Replay-renderer resolution (the `--resume` re-render seam) lives in
// `src/plugins/loader/replay-renderers.ts`.
import { registerManifestReplayRenderers } from "./loader/replay-renderers.ts"
// Plugin `setup()` execution (binary-provisioning declarations) lives in
// `src/plugins/loader/setups.ts`.
import { runPluginSetups } from "./loader/setups.ts"
// Turn-attachment factory resolution (the per-turn user-message
// attachment seam) lives in `src/plugins/loader/turn-attachments.ts`.
import { registerManifestTurnAttachments } from "./loader/turn-attachments.ts"

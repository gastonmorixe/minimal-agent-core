/**
 * TUI plugin loader.
 *
 * Discovers tui-plugin packages under two roots (home + project), parses
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

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs"
import { join, resolve, isAbsolute } from "node:path"
import { paletteEnvJson } from "../palette.ts"
import { EventBus, type EventContext } from "./event-bus.ts"
import { parseManifest, ManifestError } from "./manifest.ts"
import type {
  EventHandler,
  EventHandlerContext,
  LiveAreaHandler,
  LiveAreaHandlerContext,
  LoadedPlugin,
  ManifestEventSubscription,
  ManifestFile,
  ManifestHandler,
  ManifestLiveAreaSlot,
  ManifestMode,
  ManifestPromptFragment,
  PromptFragmentContext,
  PromptFragmentHandler,
  ResolvedEventSub,
  ResolvedHandler,
  ResolvedLiveAreaSlot,
  TUIContext,
  TUIHandler,
  TUIResult,
  TUITrigger,
} from "./types.ts"

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
}

/** Options for {@link PluginLoader.load}. */
export interface PluginLoaderOptions {
  /**
   * Absolute path to the agent's install directory (the dir containing
   * `src/` and the bundled `tui-plugins/`). The loader looks for a
   * `tui-plugins/` subdirectory under this path. These are the
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
   * a `tui-plugins/` subdirectory under this path. Defaults to
   * `~/.agents`.
   */
  homeDir?: string
  /**
   * Absolute path to the project root (typically the agent's cwd). The
   * loader looks for a `.agents/tui-plugins/` subdirectory under this
   * path. Highest precedence — project plugins shadow home and embedded
   * on package-id collision.
   */
  projectDir?: string
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
   * Optional agent session id. When provided, it is exposed to prompt
   * fragments — module handlers receive it as
   * {@link PromptFragmentContext.sessionId}, subprocess handlers see it
   * in the `MINIMAL_AGENT_SESSION_ID` env var. Useful for env-info-style
   * plugins that want to embed the session id in the system prompt.
   *
   * Should be the same value `metadata.getSessionId()` returns; passed
   * explicitly here so the loader stays decoupled from `metadata.ts`.
   */
  sessionId?: string
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
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
const DEFAULT_FRAGMENT_TIMEOUT_MS = 2000
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
 * Loaded collection of tui-plugins with a dispatch entry point.
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
  private readonly modes: LoadedMode[]
  private readonly defaultModeId: string | null
  private readonly timeoutMs: number
  private readonly eventBus: EventBus
  private readonly pendingFrags: PendingFragment[]
  private readonly logger: (msg: string) => void
  /**
   * Agent session id (UUID v4) if one was provided to {@link load}.
   * Forwarded to module handlers via `ctx.env.MINIMAL_AGENT_SESSION_ID`
   * (matching the subprocess-handler contract) so handlers like the
   * `memory` plugin can stamp their output with the originating session.
   */
  private readonly sessionId: string | undefined
  /**
   * Cached result of {@link getPromptBlockAsync}. Populated on first call
   * (after fragments resolve or time out). Subsequent calls return this
   * without re-awaiting — the system prompt sits on a cache breakpoint
   * and must be byte-stable for the rest of the session.
   */
  private asyncBlockCache: string | null | undefined = undefined

  private constructor(
    plugins: LoadedPlugin[],
    toolIndex: Map<string, ResolvedHandler>,
    aliasIndex: Map<string, string>,
    tagIndex: Map<string, ResolvedHandler>,
    modes: LoadedMode[],
    defaultModeId: string | null,
    timeoutMs: number,
    eventBus: EventBus,
    pendingFrags: PendingFragment[],
    logger: (msg: string) => void,
    sessionId: string | undefined,
  ) {
    this.plugins = plugins
    this.toolIndex = toolIndex
    this.aliasIndex = aliasIndex
    this.tagIndex = tagIndex
    this.modes = modes
    this.defaultModeId = defaultModeId
    this.timeoutMs = timeoutMs
    this.eventBus = eventBus
    this.pendingFrags = pendingFrags
    this.logger = logger
    this.sessionId = sessionId
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
   * Discover, parse, and resolve tui-plugin packages. See
   * {@link PluginLoaderOptions} for configuration.
   *
   * This method never throws for bad plugins. All plugin-level failures are
   * logged via the `logger` option and the offending package is skipped.
   * Only unrecoverable internal errors surface as exceptions.
   */
  static async load(opts: PluginLoaderOptions = {}): Promise<PluginLoader> {
    const logger = opts.logger ?? ((msg) => process.stderr.write(`[plugins] ${msg}\n`))
    const coreToolNames = opts.coreToolNames ?? new Set<string>()
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const eventBus = opts.bus ?? new EventBus(logger)
    const sessionId = opts.sessionId
    const disabledPluginIds = opts.disabledPluginIds ?? new Set<string>()

    // Discover packages in all three roots. Precedence on package-id
    // collision: project > home > embedded (closer-to-user wins).
    const packages: { dir: string; root: "embedded" | "home" | "project" }[] = []
    if (opts.embeddedDir) {
      for (const d of discoverPackageDirs(opts.embeddedDir, "tui-plugins")) {
        packages.push({ dir: d, root: "embedded" })
      }
    }
    if (opts.homeDir) {
      for (const d of discoverPackageDirs(opts.homeDir, "tui-plugins")) {
        packages.push({ dir: d, root: "home" })
      }
    }
    if (opts.projectDir) {
      for (const d of discoverPackageDirs(opts.projectDir, ".agents/tui-plugins")) {
        packages.push({ dir: d, root: "project" })
      }
    }

    // Parse manifests.
    const parsed: LoadedPlugin[] = []
    const seenIds = new Set<string>()
    // Walk in precedence order: project > home > embedded.
    const ordered = [
      ...packages.filter((p) => p.root === "project"),
      ...packages.filter((p) => p.root === "home"),
      ...packages.filter((p) => p.root === "embedded"),
    ]
    for (const { dir, root } of ordered) {
      const manifestPath = join(dir, "manifest.json")
      let manifest: ManifestFile
      try {
        const raw = JSON.parse(readFileSync(manifestPath, "utf-8"))
        manifest = parseManifest(raw, manifestPath)
      } catch (e) {
        const msg =
          e instanceof ManifestError
            ? `skipping ${dir}: manifest error: ${e.message}`
            : e instanceof SyntaxError
              ? `skipping ${dir}: manifest.json is not valid JSON: ${e.message}`
              : `skipping ${dir}: ${e instanceof Error ? e.message : String(e)}`
        logger(msg)
        continue
      }

      if (seenIds.has(manifest.id)) {
        logger(
          `skipping ${dir}: package id "${manifest.id}" already loaded ` +
            `(precedence: project > home > embedded)`,
        )
        continue
      }

      if (disabledPluginIds.has(manifest.id)) {
        logger(
          `skipping ${dir}: plugin "${manifest.id}" is disabled in user config ` +
            `(plugins.${manifest.id}.enabled = false)`,
        )
        // Reserve the id so a later (lower-precedence) copy doesn't sneak in.
        seenIds.add(manifest.id)
        continue
      }

      // Resolve prompt content.
      const promptRel = manifest.prompt ?? "./PROMPT.md"
      const promptAbs = resolvePath(dir, promptRel)
      let prompt: string | null = null
      if (existsSync(promptAbs)) {
        prompt = readFileSync(promptAbs, "utf-8")
      }

      parsed.push({
        packageDir: dir,
        root,
        manifest,
        handlers: [], // filled after collision resolution
        eventSubs: [], // filled after handler resolution
        hookSubs: [], // filled after hook permission/shape checks
        liveAreaSlots: [], // filled after handler resolution
        prompt,
      })
      seenIds.add(manifest.id)
    }

    // Resolve handlers, apply collision rules.
    const toolIndex = new Map<string, ResolvedHandler>()
    const aliasIndex = new Map<string, string>() // alias → canonical
    const tagIndex = new Map<string, ResolvedHandler>()
    const finalPlugins: LoadedPlugin[] = []

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
          for (const alias of h.trigger.tool.aliases ?? []) {
            if (coreToolNames.has(alias)) {
              packageRejected = true
              rejectReason = `tool alias "${alias}" collides with a core tool`
              break
            }
            if (toolIndex.has(alias)) {
              packageRejected = true
              rejectReason = `tool alias "${alias}" collides with another plugin's canonical tool`
              break
            }
            if (aliasIndex.has(alias)) {
              packageRejected = true
              rejectReason = `tool alias "${alias}" collides with another plugin's alias`
              break
            }
          }
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
          const canonical = r.definition.trigger.tool.name
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
        registerEventSub(eventBus, pkg.packageDir, r, logger)
      }

      // Resolve live-area slots. Same lenient policy as event subs: a
      // missing/broken slot handler doesn't disqualify the plugin's tools.
      const resolvedSlots: ResolvedLiveAreaSlot[] = []
      for (const slot of pkg.manifest.liveAreaSlots ?? []) {
        const r = await resolveLiveAreaSlot(slot, pkg.manifest.id, pkg.packageDir, logger)
        if (r) resolvedSlots.push(r)
      }
      pkg.liveAreaSlots = resolvedSlots

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
        const promise = startFragment(frag, pkg.packageDir, logger, sessionId)
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

    return new PluginLoader(
      finalPlugins,
      toolIndex,
      aliasIndex,
      tagIndex,
      modes,
      defaultModeId,
      timeoutMs,
      eventBus,
      pendingFrags,
      logger,
      sessionId,
    )
  }

  /** All loaded modes contributed by plugins (in plugin-load order). */
  getModes(): LoadedMode[] {
    return [...this.modes]
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

  /** Tool definitions contributed by loaded plugins. Safe to concat to core. */
  getExtraTools(): PluginToolDefinition[] {
    const out: PluginToolDefinition[] = []
    for (const pkg of this.plugins) {
      for (const h of pkg.handlers) {
        if (h.definition.trigger.type === "tool") {
          out.push({
            name: h.definition.trigger.tool.name,
            description: h.definition.trigger.tool.description,
            input_schema: h.definition.trigger.tool.input_schema,
            ...(h.definition.icon ? { icon: h.definition.icon } : {}),
            ...(h.definition.color ? { color: h.definition.color } : {}),
          })
        }
      }
    }
    return out
  }

  /**
   * Prompt fragment to append to the system prompt, or `null` if no plugins
   * are loaded.
   *
   * The block is structured with XML-style tags rather than Markdown headings
   * so it composes cleanly into a larger system prompt without colliding with
   * the host document's heading hierarchy:
   *
   * ```
   * <tui-plugins>
   *   <overview>...</overview>
   *   <plugin id="...">...PROMPT.md body...</plugin>
   *   ...
   * </tui-plugins>
   * ```
   *
   * Each plugin's `PROMPT.md` is embedded verbatim except that a single
   * leading top-level heading (e.g. `# ask-mode`) is stripped if present —
   * the surrounding `<plugin id="...">` tag already names the plugin, and
   * keeping the `#` would both duplicate the id and inject a stray H1 into
   * the host prompt.
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
   * appended inside each plugin's `<plugin>` block.
   */
  private buildBlock(fragmentTexts: Map<string, string[]> | null): string | null {
    if (this.plugins.length === 0) return null
    const parts: string[] = []
    parts.push("<tui-plugins>")
    parts.push(
      "<overview>\n" +
        "You have access to the following TUI plugins. Each plugin provides one\n" +
        "or more tools and/or inline rendering tags.\n" +
        "\n" +
        "Inline tags are detected in your streamed output and rendered by the\n" +
        "plugin in place. Tag shape: <tui::NAME attr=\"val\" attr2='val'>body</tui::NAME>,\n" +
        'or self-closing <tui::NAME attr="val" />. Tag names must match exactly.\n' +
        "Attribute values must be quoted.\n" +
        "\n" +
        "Interactive TUIs MUST be invoked via a tool call, not an inline tag.\n" +
        "Inline tags are for non-interactive rendering only.\n" +
        "</overview>",
    )
    for (const pkg of this.plugins) {
      const body = stripLeadingHeading(pkg.prompt ?? pkg.manifest.description)
      const frags = fragmentTexts?.get(pkg.manifest.id) ?? []
      const fragSection =
        frags.length > 0 ? `\n\n${frags.map((t) => t.trimEnd()).join("\n\n")}` : ""
      parts.push(`<plugin id="${pkg.manifest.id}">\n${body}${fragSection}\n</plugin>`)
    }
    parts.push("</tui-plugins>")
    return parts.join("\n\n")
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
   * Route a trigger to the matching handler and return its result.
   *
   * Handler exceptions and timeouts are converted to either
   * `{kind: "tool_result", is_error: true}` (tool triggers) or
   * `{kind: "rendered", ansi: raw-bytes}` (inline triggers) so the agent
   * loop never crashes on a bad plugin.
   *
   * @param trigger - The activation event.
   * @param agentCwd - The agent's current working directory.
   */
  async dispatch(trigger: TUITrigger, agentCwd: string): Promise<TUIResult> {
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

    const ctx: TUIContext = {
      trigger,
      packageDir: findPackageDirFor(this.plugins, handler),
      cwd: agentCwd,
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        MINIMAL_AGENT_PALETTE: paletteEnvJson(),
        ...(this.sessionId ? { MINIMAL_AGENT_SESSION_ID: this.sessionId } : {}),
      } as Record<string, string>,
      abort: ctrl.signal,
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
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
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function discoverPackageDirs(rootDir: string, sub: string): string[] {
  const base = join(rootDir, sub)
  if (!existsSync(base) || !statSync(base).isDirectory()) return []
  const out: string[] = []
  for (const entry of readdirSync(base)) {
    const full = join(base, entry)
    if (!statSync(full).isDirectory()) continue
    if (!existsSync(join(full, "manifest.json"))) continue
    out.push(full)
  }
  return out
}

function resolvePath(pkgDir: string, rel: string): string {
  return isAbsolute(rel) ? rel : resolve(pkgDir, rel)
}

/**
 * Strip a single leading ATX-style top-level heading (`# ...`) from a
 * Markdown body, plus any blank lines that follow it. Used when embedding a
 * plugin's `PROMPT.md` inside a `<plugin id="...">` wrapper so the plugin id
 * doesn't appear twice (once as the XML attribute, once as a stray H1) and
 * so plugin authors don't accidentally inject a top-level heading into the
 * host system prompt's outline.
 *
 * Only the first heading is removed, and only if it is the very first
 * non-empty line. Deeper headings (`##`, `###`, ...) and headings that appear
 * later in the body are left untouched.
 */
function stripLeadingHeading(body: string): string {
  // Tolerate a UTF-8 BOM and any leading blank lines before the heading.
  const match = body.match(/^\uFEFF?\s*#[ \t]+[^\n]*\n+/)
  if (!match) return body.trim()
  return body.slice(match[0].length).trim()
}

async function resolveHandler(
  h: ManifestHandler,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedHandler | null> {
  if (h.handler.type === "module") {
    const abs = resolvePath(packageDir, h.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: module handler not found: ${abs}`)
      return null
    }
    let mod: { default?: TUIHandler }
    try {
      mod = await import(abs)
    } catch (e) {
      logger(
        `${packageDir}: failed to import ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: ${abs} has no default export function`)
      return null
    }
    return {
      definition: h,
      entryAbsolute: abs,
      invoke: async (ctx) => fn(ctx),
    }
  }

  // subprocess
  const cmd = h.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: subprocess executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition: h,
    entryAbsolute: exeAbs,
    invoke: async (ctx) => invokeSubprocess(exeAbs, cmd.slice(1), ctx),
  }
}

/**
 * Spawn a subprocess handler with the v1 stdio protocol.
 *
 * The subprocess receives a JSON envelope on stdin and writes its response
 * to stdout. Tool-call non-interactive handlers return stdout as
 * `tool_result.content`. Inline handlers return stdout as `rendered.ansi`.
 * Interactive handlers are not yet supported via subprocess; they fall back
 * to the module-handler path.
 */
async function invokeSubprocess(exe: string, args: string[], ctx: TUIContext): Promise<TUIResult> {
  const proc = Bun.spawn([exe, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ctx.packageDir,
    env: ctx.env,
  })
  const envelope = JSON.stringify({
    trigger: ctx.trigger,
    cwd: ctx.cwd,
    env: ctx.env,
  })
  void proc.stdin.write(envelope + "\n")
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (ctx.trigger.type === "tool") {
    return { kind: "tool_result", content: out, is_error: code !== 0 }
  }
  return { kind: "rendered", ansi: out }
}

function findPackageDirFor(plugins: LoadedPlugin[], handler: ResolvedHandler): string {
  for (const pkg of plugins) {
    if (pkg.handlers.includes(handler)) return pkg.packageDir
  }
  return process.cwd()
}

// ---------------------------------------------------------------------------
// Async prompt-fragment producers
// ---------------------------------------------------------------------------

/**
 * Look up the {@link ManifestPromptFragment} definition for a given
 * plugin id + fragment id pair. Used by `resolveFragments` to retrieve
 * `timeoutMs` after the producer has been kicked off (we don't keep a
 * back-pointer from `PendingFragment` to the manifest entry).
 */
function findFragmentDef(
  plugins: LoadedPlugin[],
  pluginId: string,
  fragmentId: string,
): ManifestPromptFragment | null {
  for (const pkg of plugins) {
    if (pkg.manifest.id !== pluginId) continue
    for (const f of pkg.manifest.promptFragments ?? []) {
      if (f.id === fragmentId) return f
    }
  }
  return null
}

/**
 * Start a prompt fragment producer.
 *
 * The returned promise resolves to the fragment text on success, or
 * `null` if the producer fails. Rejection paths (missing entry, import
 * error, non-zero exit) are converted to `null` here so the caller in
 * `resolveFragments` can treat success-or-drop uniformly.
 *
 * The producer runs immediately at loader-init time and is detached from
 * the boot path — its eventual error never throws synchronously.
 */
function startFragment(
  frag: ManifestPromptFragment,
  packageDir: string,
  logger: (msg: string) => void,
  sessionId: string | undefined,
): Promise<string | null> {
  return runFragment(frag, packageDir, sessionId).catch((e) => {
    logger(
      `${packageDir}: prompt fragment "${frag.id}" failed: ${e instanceof Error ? e.message : String(e)}`,
    )
    return null
  })
}

async function runFragment(
  frag: ManifestPromptFragment,
  packageDir: string,
  sessionId: string | undefined,
): Promise<string | null> {
  const ctrl = new AbortController()
  // The loader-level timeout in resolveFragments races this; if it wins,
  // we never see the resolved value. We still wire the abort signal in case
  // the handler wants to cooperatively stop. (For subprocess we don't kill
  // the process here — that's intentional: a stuck probe is dropped, not
  // surfaced, and the OS reaps it on agent exit.)
  void ctrl
  const env = {
    ...process.env,
    TUI_PLUGIN_PROTOCOL: "1",
    MINIMAL_AGENT_PALETTE: paletteEnvJson(),
    ...(sessionId ? { MINIMAL_AGENT_SESSION_ID: sessionId } : {}),
  } as Record<string, string>

  if (frag.handler.type === "module") {
    const abs = resolvePath(packageDir, frag.handler.path)
    if (!existsSync(abs)) {
      throw new Error(`module not found: ${abs}`)
    }
    const mod = (await import(abs)) as { default?: PromptFragmentHandler }
    const fn = mod.default
    if (typeof fn !== "function") {
      throw new Error(`${abs} has no default export function`)
    }
    const ctx: PromptFragmentContext = {
      packageDir,
      cwd: process.cwd(),
      env,
      sessionId,
      abort: ctrl.signal,
      stderr: process.stderr,
    }
    const out = await fn(ctx)
    return typeof out === "string" ? out : null
  }

  // subprocess
  const cmd = frag.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    throw new Error(`subprocess executable not found: ${exeAbs}`)
  }
  // Run the probe in the agent's cwd, not the plugin dir, so probes that
  // report `$PWD` / `git status` / etc. describe the agent's environment
  // (which is what env-info wants). The plugin dir is exposed via
  // TUI_PLUGIN_DIR so a probe that needs sibling files can still find them.
  const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: process.cwd(),
    env: { ...env, TUI_PLUGIN_DIR: packageDir },
  })
  // Empty stdin — fragments don't get a trigger envelope (there is none).
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`exited with code ${code}`)
  return out
}

// ---------------------------------------------------------------------------
// Event subscription resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a manifest event subscription to an invocable form. Mirrors
 * {@link resolveHandler} but for one-way event handlers (no `TUIResult`,
 * no return value).
 *
 * Returns `null` and logs on failure. The plugin keeps its tool/tag
 * functionality; only this one subscription is dropped.
 */
async function resolveEventSub(
  sub: ManifestEventSubscription,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedEventSub | null> {
  if (sub.handler.type === "module") {
    const abs = resolvePath(packageDir, sub.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: event handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: EventHandler }
    try {
      mod = await import(abs)
    } catch (e) {
      logger(
        `${packageDir}: failed to import event handler ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: event handler ${abs} has no default export function`)
      return null
    }
    return {
      definition: sub,
      entryAbsolute: abs,
      invoke: async (ctx) => fn(ctx),
    }
  }

  // subprocess
  const cmd = sub.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: event subprocess executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition: sub,
    entryAbsolute: exeAbs,
    invoke: async (ctx) => invokeEventSubprocess(exeAbs, cmd.slice(1), ctx),
  }
}

/**
 * Subscribe a resolved event sub on the shared bus. The bus owns
 * coalesce/throttle/error handling; we just adapt its `EventContext`
 * (event + payload + emit + abort) to the plugin's
 * `EventHandlerContext` (which adds `packageDir`, `cwd`, `env`, `stderr`).
 */
function registerEventSub(
  bus: EventBus,
  packageDir: string,
  sub: ResolvedEventSub,
  logger: (msg: string) => void,
): void {
  const label = `${packageDir}:${sub.definition.id}`
  const listener = (ctx: EventContext): void | Promise<void> => {
    const handlerCtx: EventHandlerContext = {
      event: ctx.event,
      payload: ctx.payload,
      packageDir,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TUI_PLUGIN_PROTOCOL: "1",
        MINIMAL_AGENT_PALETTE: paletteEnvJson(),
      } as Record<string, string>,
      emit: ctx.emit,
      abort: ctx.abort,
      stderr: process.stderr,
    }
    try {
      return sub.invoke(handlerCtx)
    } catch (e) {
      logger(`${label}: handler threw: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  bus.on(sub.definition.on, listener, {
    coalesce: sub.definition.coalesce,
    throttleMs: sub.definition.throttleMs,
    label,
  })
}

/**
 * Subprocess event-handler protocol.
 *
 * The subprocess receives a JSON envelope on stdin:
 *
 *   `{event, payload, cwd, env}\n`
 *
 * It writes zero or more re-emit lines to stdout, one JSON object per
 * line:
 *
 *   `{"emit": "<event>", "payload": <any>}\n`
 *
 * Stdout EOF terminates parsing. Lines that don't parse, lack `emit`, or
 * specify a non-string event name are silently dropped — this is a
 * notification path, not a tool call; we don't want a sloppy plugin to
 * crash the bus.
 */
async function invokeEventSubprocess(
  exe: string,
  args: string[],
  ctx: EventHandlerContext,
): Promise<void> {
  const proc = Bun.spawn([exe, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: ctx.packageDir,
    env: ctx.env,
  })
  const envelope = JSON.stringify({
    event: ctx.event,
    payload: ctx.payload,
    cwd: ctx.cwd,
    env: ctx.env,
  })
  void proc.stdin.write(envelope + "\n")
  void proc.stdin.end()
  const out = await new Response(proc.stdout).text()
  await proc.exited
  for (const raw of out.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { emit?: unknown }).emit === "string"
    ) {
      const p = parsed as { emit: string; payload?: unknown }
      ctx.emit(p.emit, p.payload)
    }
  }
}

/**
 * Resolve a single {@link ManifestLiveAreaSlot} to invocable form.
 *
 * Module handlers must `export default` a {@link LiveAreaHandler}. The
 * loader applies normalized defaults (position=`"footer"`,
 * refreshMs=60_000, timeoutMs=5000) before invocation so the scheduler
 * never has to second-guess them.
 *
 * Returns `null` (with a logged diagnostic) on missing module / bad
 * default export / missing executable. The plugin's tools and other
 * subscriptions are NOT affected — broken slot ≠ broken plugin.
 */
async function resolveLiveAreaSlot(
  slot: ManifestLiveAreaSlot,
  pluginId: string,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedLiveAreaSlot | null> {
  const definition: ManifestLiveAreaSlot = {
    ...slot,
    position: slot.position ?? "footer",
    refreshMs: slot.refreshMs ?? 60_000,
    timeoutMs: slot.timeoutMs ?? 5000,
    // Pass through verbatim — empty string is a deliberate opt-out;
    // undefined means "no row reserved before first invoke".
    placeholder: slot.placeholder,
    // Normalize undefined/null → empty array so the scheduler can iterate
    // without a null check.
    refreshOn: slot.refreshOn ?? [],
  }

  if (slot.handler.type === "module") {
    const abs = resolvePath(packageDir, slot.handler.path)
    if (!existsSync(abs)) {
      logger(`${packageDir}: live-area slot handler module not found: ${abs}`)
      return null
    }
    let mod: { default?: LiveAreaHandler }
    try {
      mod = await import(abs)
    } catch (e) {
      logger(
        `${packageDir}: failed to import live-area slot handler ${abs}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
      return null
    }
    const fn = mod.default
    if (typeof fn !== "function") {
      logger(`${packageDir}: live-area slot handler ${abs} has no default export function`)
      return null
    }
    return {
      definition,
      pluginId,
      packageDir,
      entryAbsolute: abs,
      invoke: async (ctx: LiveAreaHandlerContext) => {
        const out = await fn(ctx)
        if (out == null) return null
        if (typeof out !== "string") {
          throw new Error(
            `live-area slot "${slot.id}" returned non-string (${typeof out}); expected string | null`,
          )
        }
        return out
      },
    }
  }

  // subprocess
  const cmd = slot.handler.command
  const exe = cmd[0]
  const exeAbs = isAbsolute(exe) ? exe : resolve(packageDir, exe)
  if (!existsSync(exeAbs)) {
    logger(`${packageDir}: live-area slot executable not found: ${exeAbs}`)
    return null
  }
  return {
    definition,
    pluginId,
    packageDir,
    entryAbsolute: exeAbs,
    invoke: async (ctx: LiveAreaHandlerContext) => {
      const proc = Bun.spawn([exeAbs, ...cmd.slice(1)], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
        cwd: ctx.packageDir,
        env: ctx.env,
      })
      const envelope = JSON.stringify({ tick: ctx.tick, cwd: ctx.cwd, env: ctx.env })
      void proc.stdin.write(envelope + "\n")
      void proc.stdin.end()
      const out = await new Response(proc.stdout).text()
      await proc.exited
      const trimmed = out.replace(/\n+$/, "")
      return trimmed.length === 0 ? null : trimmed
    },
  }
}

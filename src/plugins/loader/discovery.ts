/**
 * Package discovery + manifest parsing for the plugin loader.
 *
 * Walks the three plugin root tiers (embedded / user / project),
 * dedupes physical directories by realpath, parses each package's
 * `manifest.json` (via `parseManifest`), applies the enable/disable
 * gates, and resolves the optional `PROMPT.md` body — yielding the
 * ordered `LoadedPlugin[]` skeleton the loader's handler-resolution
 * pass fills in.
 *
 * Split out of `src/plugins/loader.ts` to keep that file under the
 * `max-lines` lint budget. Names are imported by the `PluginLoader`
 * class only and are NOT re-exported from `loader.ts` (no external
 * consumer touched them).
 *
 * @module plugins/loader/discovery
 */

import { existsSync, readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"

import {
  detectPlatform,
  type NormalizedPlatform,
  platformAllowed,
} from "../../../plugin-api/src/utils/platform.ts"
import { type Diagnostics, processDiagnostics } from "../../diagnostics/hub.ts"
import { ManifestError, parseManifest, ReservedPluginIdError } from "../manifest.ts"
import type { LoadedPlugin, ManifestFile } from "../types.ts"

import { CONTRIBUTION_KEYS, declaresAnyContribution } from "./contribution-keys.ts"
import { discoverPackageDirs, resolvePath } from "./helpers.ts"
import { PLUGIN_ROOT_TIERS, type PluginRoots, type PluginRootTier } from "./roots.ts"

/** Which root a discovered package directory came from. */
export type PkgRoot = PluginRootTier

/** Inputs for {@link discoverAndParsePackages}. */
export interface DiscoveryOptions {
  /** Agent install dir (scanned at `<dir>/plugins`); lowest precedence. */
  embeddedDir?: string
  /** minimal-agent's per-user root (scanned at `<dir>/plugins`). */
  userDir?: string
  /**
   * Root directories by tier, computed by the host (S40). Each directory
   * holds plugin package directories directly. See `./roots.ts`.
   */
  roots?: PluginRoots
  /** Effective diagnostic sink (the loader's resolved logger). */
  logger: (msg: string) => void
  /**
   * The CALLER-injected logger, if one was supplied to
   * `PluginLoader.load`. Routine precedence-resolution skips (id shadow,
   * manifest-level opt-out) go here when present (so tests observe them)
   * and to a file-log-only `diag.notice` otherwise — they must never
   * race the startup banner in production.
   */
  explicitLogger?: ((msg: string) => void) | undefined
  /**
   * Diagnostics handle for routine notices (realpath dedup, id shadow,
   * opt-outs, platform gates) and manifest warnings (S20). Default: the
   * process handle.
   */
  diagnostics?: Diagnostics
  /** Plugin ids force-disabled by user config (deny beats allow). */
  disabledPluginIds: Set<string>
  /** Plugin ids force-enabled by user config (revives `enabled: false` manifests). */
  enabledPluginIds: Set<string>
  /**
   * The effective platform to gate manifest `platforms` whitelists
   * against. Defaults to the host's detected platform
   * ({@link detectPlatform}); an env var / CLI flag override (resolved in
   * the host entry point) can change it, or set it to the `all` bypass to load
   * every plugin regardless of its whitelist.
   */
  effectivePlatform?: NormalizedPlatform
}

/** Result of {@link discoverAndParsePackages}. */
export interface DiscoveryResult {
  /**
   * Accepted packages in precedence order (project, then user, then
   * embedded), each with manifest + prompt resolved and
   * contribution arrays left empty for the loader's resolution pass
   * to fill.
   */
  parsed: LoadedPlugin[]
  /**
   * Raw `replayRenderers` manifest values keyed by package dir. The
   * manifest parser ignores the key (loader-resolved glue, not a
   * validated contribution), so it is captured from the raw JSON here
   * and resolved after package acceptance. See
   * `./replay-renderers.ts`.
   */
  replayRenderersRaw: Map<string, unknown>
  /**
   * Raw `turnAttachments` manifest values keyed by package dir. Same
   * capture rationale as {@link DiscoveryResult.replayRenderersRaw};
   * resolved after package acceptance. See `./turn-attachments.ts`.
   */
  turnAttachmentsRaw: Map<string, unknown>
  /**
   * Raw top-level `promptTemplate` manifest values keyed by package dir.
   * Same capture rationale as {@link DiscoveryResult.replayRenderersRaw}.
   * See `../prompts-context.ts`.
   */
  promptTemplateRaw: Map<string, unknown>
}

/**
 * Discover plugin package dirs under all three root tiers, dedupe by
 * realpath (highest-precedence root wins), then parse + gate each
 * manifest in precedence order. Per-package failures are logged and
 * skipped; this function never throws for a bad package.
 */
export function discoverAndParsePackages(opts: DiscoveryOptions): DiscoveryResult {
  const { logger, disabledPluginIds, enabledPluginIds } = opts
  const diagnostics = opts.diagnostics ?? processDiagnostics()
  const effectivePlatform: NormalizedPlatform = opts.effectivePlatform ?? detectPlatform()

  // Discover packages in all roots (embedded / user / project).
  // Precedence on package-id collision: project > user > embedded
  // (closer-to-user wins).
  const packages: { dir: string; root: PkgRoot }[] = []
  if (opts.embeddedDir) {
    for (const d of discoverPackageDirs(opts.embeddedDir, "plugins")) {
      packages.push({ dir: d, root: "embedded" })
    }
  }
  if (opts.userDir) {
    for (const d of discoverPackageDirs(opts.userDir, "plugins")) {
      packages.push({ dir: d, root: "user" })
    }
  }
  // Host-computed roots (S40). Each dir holds package dirs directly, so
  // scan it as is: `discoverPackageDirs(x, "")` joins to `x`.
  for (const tier of PLUGIN_ROOT_TIERS) {
    for (const rootDir of opts.roots?.[tier] ?? []) {
      for (const d of discoverPackageDirs(rootDir, "")) {
        packages.push({ dir: d, root: tier })
      }
    }
  }

  // Dedupe by realpath BEFORE the id-collision check. Two roots can
  // legitimately point at the same physical directory:
  //   - the host passes the same dir as a project root and a user root
  //     (for example when the cwd is the user plugin clone)
  //   - symlinks under a user or project root point into a shared dev
  //     checkout that is also an embedded root
  // Keep only the highest-precedence root (project > user > embedded)
  // for each physical package. This is not a user-actionable warning —
  // emit a Notice that lands in the file log only, not the scrollback.
  const ROOT_PRECEDENCE = { project: 3, user: 2, embedded: 1 } as const
  const byRealPath = new Map<string, { dir: string; root: PkgRoot }>()
  for (const pkg of packages) {
    let real: string
    try {
      real = realpathSync(pkg.dir)
    } catch {
      // realpath failed (broken symlink, racing unlink, permission) —
      // fall back to the lexical path so we still dedupe identical strings.
      real = pkg.dir
    }
    const existing = byRealPath.get(real)
    if (existing === undefined) {
      byRealPath.set(real, pkg)
      continue
    }
    // Same physical directory discovered through a second root.
    const winner = ROOT_PRECEDENCE[pkg.root] > ROOT_PRECEDENCE[existing.root] ? pkg : existing
    const loser = winner === pkg ? existing : pkg
    byRealPath.set(real, winner)
    diagnostics.notice(
      "plugin-loader",
      `deduped overlapping package roots for ${real}: kept ${winner.root}, ` +
        `dropped ${loser.root} (${loser.dir})`,
    )
  }
  const dedupedPackages = Array.from(byRealPath.values())

  // Parse manifests.
  const parsed: LoadedPlugin[] = []
  const seenIds = new Set<string>()
  // Root tier of each accepted package dir (for the G11 shadow diagnostic).
  const packageRoots = new Map<string, PkgRoot>()
  // Raw `replayRenderers` values per package dir; see DiscoveryResult.
  const replayRenderersRaw = new Map<string, unknown>()
  // Raw `turnAttachments` values per package dir; see DiscoveryResult.
  const turnAttachmentsRaw = new Map<string, unknown>()
  // Raw top-level `promptTemplate` values per package dir; see DiscoveryResult.
  const promptTemplateRaw = new Map<string, unknown>()
  // Raw top-level `toolResultTransforms` values per package dir. S2.2 adds the
  // DiscoveryResult field when the loader collects this key.
  const toolResultTransformsRaw = new Map<string, unknown>()
  // Walk in precedence order: project > user > embedded.
  const ordered = [
    ...dedupedPackages.filter((p) => p.root === "project"),
    ...dedupedPackages.filter((p) => p.root === "user"),
    ...dedupedPackages.filter((p) => p.root === "embedded"),
  ]
  for (const { dir, root } of ordered) {
    const manifestPath = join(dir, "manifest.json")
    let manifest: ManifestFile
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"))
      // Manifest warnings go to the caller's logger when a test supplies
      // one, else to the diagnostics bus with warning severity.
      const warn =
        opts.explicitLogger ?? ((msg: string) => diagnostics.warn("plugin.manifest", msg))
      manifest = parseManifest(raw, manifestPath, { warn })
      // The headless block that core loads (S31). `parseManifest` rejects
      // a flat manifest (S41), so the block is all there is.
      const headless = ((raw as Record<string, unknown>).headless ?? {}) as Record<string, unknown>
      const promptTemplate = (raw as Record<string, unknown>).promptTemplate
      if (promptTemplate != null) promptTemplateRaw.set(dir, promptTemplate)
      const toolResultTransforms = (raw as Record<string, unknown>).toolResultTransforms
      if (toolResultTransforms != null) toolResultTransformsRaw.set(dir, toolResultTransforms)
      if (headless.replayRenderers != null) {
        replayRenderersRaw.set(dir, headless.replayRenderers)
      }
      if (headless.turnAttachments != null) {
        turnAttachmentsRaw.set(dir, headless.turnAttachments)
      }
    } catch (e) {
      // A RESERVED id is the one manifest error that is fatal. Skipping it
      // would leave a user config key (`plugins.prompts`) that silently does
      // nothing, so the whole load rejects and the process fails to start.
      if (e instanceof ReservedPluginIdError) throw e
      const msg =
        e instanceof ManifestError
          ? `skipping ${dir}: manifest error: ${e.message}`
          : e instanceof SyntaxError
            ? `skipping ${dir}: manifest.json is not valid JSON: ${e.message}`
            : `skipping ${dir}: ${e instanceof Error ? e.message : String(e)}`
      logger(msg)
      continue
    }

    // G11 shadow rule: a required copy sits below a winner. The winner
    // keeps the id only when it is also required and provides every
    // contract of this copy. Else this copy replaces it, but only after it
    // passes every later check, so the id never vanishes.
    let replaceAt = -1
    // A higher copy that was skipped (disabled, platform) never loaded, so
    // it cannot shadow a required copy below it.
    let reservedOnly = false
    if (seenIds.has(manifest.id) && manifest.required === true) {
      const at = parsed.findIndex((p) => p.manifest.id === manifest.id)
      const winner = at >= 0 ? parsed[at] : undefined
      reservedOnly = winner === undefined
      if (winner !== undefined) {
        const have = new Set(winner.manifest.provides ?? [])
        const ok =
          winner.manifest.required === true && (manifest.provides ?? []).every((c) => have.has(c))
        if (ok) continue
        replaceAt = at
      }
    }

    if (seenIds.has(manifest.id) && replaceAt < 0 && !reservedOnly) {
      // A higher-precedence copy of this id already won, so this copy is
      // skipped. That part is correct and intentional. But this is routine
      // precedence resolution, NOT a user-actionable error: the common
      // trigger is the same plugins repo present under two roots with
      // DISTINCT realpaths (e.g. a project root symlinked into one checkout
      // while the user root is a second checkout of the same repo — same
      // manifest id, different files on disk, so the realpath dedup above
      // can't collapse them). Emitting a loud ⚠ warn
      // for that on every startup just races the banner box with noise.
      //
      // Route through the injected logger when a test supplies one (so the
      // shadow stays observable in tests) and otherwise emit a Notice that
      // lands in the file log only, never the scrollback — matching the
      // realpath-dedup and disabled-by-manifest branches that bracket this
      // one.
      const msg =
        `skipping ${dir}: package id "${manifest.id}" already loaded ` +
        `(precedence: project > user > embedded)`
      if (opts.explicitLogger) {
        opts.explicitLogger(msg)
      } else {
        diagnostics.notice("plugin-loader", msg)
      }
      continue
    }

    if (disabledPluginIds.has(manifest.id) && manifest.required === true) {
      // G11: a disable request for a required id is refused. Data only.
      diagnostics.warn("plugin.required_disable_refused", "", { pluginId: manifest.id })
    } else if (disabledPluginIds.has(manifest.id)) {
      logger(`skipping ${dir}: plugin "${manifest.id}" is explicitly disabled`)
      // Reserve the id so a later (lower-precedence) copy doesn't sneak in.
      seenIds.add(manifest.id)
      continue
    }

    // Manifest-level opt-out: plugin author shipped with `enabled: false`.
    // The user can still bring it back online with an explicit `enabled:
    // true` in their config (the `enabledPluginIds` override set).
    //
    // Unlike the user-config opt-out above, this is BY DESIGN: the author
    // intentionally shipped the package disabled. Emit as a notice (file
    // log only, never stderr) so the by-design state stays auditable
    // without polluting the scrollback. Tests that inject a custom
    // `logger` still see the message verbatim.
    if (manifest.enabled === false && !enabledPluginIds.has(manifest.id)) {
      const msg =
        `skipping ${dir}: plugin "${manifest.id}" is disabled by its manifest ` +
        `(manifest.enabled = false). Set plugins.${manifest.id}.enabled = true ` +
        `in ~/.minimal-agent/config.jsonc to enable`
      if (opts.explicitLogger) {
        opts.explicitLogger(msg)
      } else {
        diagnostics.notice("plugin-loader", msg)
      }
      // Reserve the id so a later (lower-precedence) copy doesn't sneak in.
      seenIds.add(manifest.id)
      continue
    }

    // Platform whitelist gate (plugin level). When a manifest declares a
    // `platforms` whitelist that excludes the effective platform, skip the
    // ENTIRE plugin — tools, modes, events, hooks, fragments, slots, and
    // PROMPT.md. This is a hard capability constraint (the plugin's native
    // helper/daemon simply isn't there), not a user preference, so a
    // config/CLI force-enable does NOT revive it; only the `all` platform
    // bypass (or naming the right platform) does. Routine + by-design, so
    // emit as a notice (file log only) unless a test injected a logger.
    if (!platformAllowed(manifest.platforms, effectivePlatform)) {
      const msg =
        `skipping ${dir}: plugin "${manifest.id}" is not available on this ` +
        `platform (${effectivePlatform}). manifest.platforms = ` +
        `[${(manifest.platforms ?? []).join(", ")}]`
      if (opts.explicitLogger) {
        opts.explicitLogger(msg)
      } else {
        diagnostics.notice("plugin-loader", msg)
      }
      // Reserve the id so a lower-precedence copy doesn't sneak in.
      seenIds.add(manifest.id)
      continue
    }

    // Platform whitelist gate (tool level). A single tool handler may
    // carry its own `platforms` whitelist; when it excludes the effective
    // platform, drop just that tool (the rest of the plugin loads
    // normally). Filtering here — before the loader's collision/resolve
    // passes — means an excluded tool never reserves its name and never
    // reaches the model's tool list or its system-prompt slot. Tool
    // whitelist is ANDed with the plugin whitelist, which already passed
    // above. Only `tool` triggers carry the field; `inline_tag` entries
    // pass through untouched.
    if (manifest.tools && manifest.tools.length > 0) {
      const kept = manifest.tools.filter((h) => {
        if (h.trigger.type !== "tool") return true
        if (platformAllowed(h.platforms, effectivePlatform)) return true
        const toolName = h.trigger.tool.name
        const msg =
          `${dir}: tool "${toolName}" of plugin "${manifest.id}" is not ` +
          `available on this platform (${effectivePlatform}). Platforms = ` +
          `[${(h.platforms ?? []).join(", ")}]`
        if (opts.explicitLogger) {
          opts.explicitLogger(msg)
        } else {
          diagnostics.notice("plugin-loader", msg)
        }
        return false
      })
      if (kept.length !== manifest.tools.length) {
        manifest.tools = kept
      }
    }

    // Resolve prompt content.
    //
    // PROMPT.md is genuinely optional. A plugin that contributes only
    // editor hooks, live-area slots, or other UX-layer behavior has
    // nothing to teach the model and should ship NO PROMPT.md at all
    // (the `buildBlock` codepath then omits the `<plugin id="...">`
    // wrapper entirely). Falling back to `manifest.description` here
    // would leak per-plugin dev docs into the cached system prompt for
    // every request, which is what we're trying to avoid.
    //
    // If `manifest.prompt` is explicitly set but the referenced file is
    // missing, that's an authoring error (the author asked for a specific
    // file). Warn so it surfaces in the file log without breaking load.
    const promptExplicit = typeof manifest.prompt === "string"
    const promptRel = manifest.prompt ?? "./PROMPT.md"
    const promptAbs = resolvePath(dir, promptRel)
    let prompt: string | null = null
    if (existsSync(promptAbs)) {
      prompt = readFileSync(promptAbs, "utf-8")
    } else if (promptExplicit) {
      logger(
        `${dir}: manifest.prompt points to "${promptRel}" but the file is ` +
          `missing; the plugin will be silent in the system prompt`,
      )
    }

    // Dead-weight check: a plugin with no declared contributions AND no
    // PROMPT.md on disk loads successfully but does nothing. This is
    // almost always an authoring mistake (typo'd manifest, abandoned
    // scaffold). Surface it via the logger so the operator notices,
    // but don't block. The loader keeps going.
    //
    // We deliberately let `prompt` count (any non-null `prompt` value,
    // resolved from disk via either the default `./PROMPT.md` or an
    // explicit `manifest.prompt` override). A plugin whose entire
    // value is a system-prompt fragment (writing-style discipline,
    // coding-conventions doc) is a legitimate shape.
    const hasAnyDeclared = declaresAnyContribution(manifest, {
      promptTemplate: promptTemplateRaw.get(dir),
      toolResultTransforms: toolResultTransformsRaw.get(dir),
      replayRenderers: replayRenderersRaw.get(dir),
      turnAttachments: turnAttachmentsRaw.get(dir),
    })
    if (!hasAnyDeclared && prompt === null) {
      logger(
        `${dir}: plugin "${manifest.id}" declares no contributions ` +
          `(${CONTRIBUTION_KEYS.join(", ")}) and ships ` +
          `no PROMPT.md; it will load but do nothing`,
      )
    }

    packageRoots.set(dir, root)
    const entry: LoadedPlugin = {
      packageDir: dir,
      root,
      manifest,
      handlers: [], // filled after collision resolution
      eventSubs: [], // filled after handler resolution
      hookSubs: [], // filled after hook permission/shape checks
      commands: [], // filled after handler resolution
      prompt,
    }
    if (replaceAt >= 0) {
      const dropped = parsed[replaceAt]
      diagnostics.warn("plugin.required_shadow_refused", "", {
        pluginId: manifest.id,
        droppedRoot: dropped ? (packageRoots.get(dropped.packageDir) ?? "") : "",
        keptRoot: root,
      })
      parsed[replaceAt] = entry
    } else {
      parsed.push(entry)
    }
    seenIds.add(manifest.id)
  }

  return { parsed, replayRenderersRaw, turnAttachmentsRaw, promptTemplateRaw }
}

/**
 * G11 contract check, warn mode. Every required contract needs exactly one
 * provider among the accepted plugins. The required list is `extra` plus
 * every contract that a `required` plugin provides. Records one typed
 * diagnostic per failure and never throws. Core holds no prose for it.
 */
export function checkRequiredContracts(
  plugins: readonly LoadedPlugin[],
  extra: readonly string[],
  diagnostics: Diagnostics,
): void {
  const contracts = new Set<string>(extra)
  for (const p of plugins) {
    if (p.manifest.required === true) for (const c of p.manifest.provides ?? []) contracts.add(c)
  }
  for (const contract of contracts) {
    const providers = plugins
      .filter((p) => (p.manifest.provides ?? []).includes(contract))
      .map((p) => p.manifest.id)
    if (providers.length === 0) {
      diagnostics.warn("boot.contract_missing", "", { contract })
    } else if (providers.length > 1) {
      diagnostics.warn("boot.contract_duplicate", "", {
        contract,
        providers: providers.join(","),
      })
    }
  }
}

/**
 * Stable boot order: the plugin with `sidebandCodec` first, the plugin with
 * `promptTemplate` second (by raw key), all others keep their relative
 * order. Pure. Returns a new array.
 */
export function orderBootProviders(
  plugins: readonly LoadedPlugin[],
  promptTemplateRaw: ReadonlyMap<string, unknown>,
): LoadedPlugin[] {
  const codec = plugins.filter((p) => p.manifest.sidebandCodec !== undefined)
  const template = plugins.filter(
    (p) => p.manifest.sidebandCodec === undefined && promptTemplateRaw.has(p.packageDir),
  )
  const first = new Set<LoadedPlugin>([...codec, ...template])
  return [...codec, ...template, ...plugins.filter((p) => !first.has(p))]
}

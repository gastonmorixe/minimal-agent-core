/**
 * Package discovery + manifest parsing for the plugin loader.
 *
 * Walks the four plugin roots (embedded / user / home / project),
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

import { diag } from "../../diagnostic-bus.ts"
import { ManifestError, parseManifest } from "../manifest.ts"
import type { LoadedPlugin, ManifestFile } from "../types.ts"

import { discoverPackageDirs, resolvePath } from "./helpers.ts"

/** Which root a discovered package directory came from. */
export type PkgRoot = "embedded" | "user" | "home" | "project"

/** Inputs for {@link discoverAndParsePackages}. */
export interface DiscoveryOptions {
  /** Agent install dir (scanned at `<dir>/plugins`); lowest precedence. */
  embeddedDir?: string
  /** minimal-agent's per-user root (scanned at `<dir>/plugins`). */
  userDir?: string
  /** User home root (scanned at `<dir>/plugins`). */
  homeDir?: string
  /** Project root (scanned at `<dir>/.agents/plugins`); highest precedence. */
  projectDir?: string
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
  /** Plugin ids force-disabled by user config (deny beats allow). */
  disabledPluginIds: Set<string>
  /** Plugin ids force-enabled by user config (revives `enabled: false` manifests). */
  enabledPluginIds: Set<string>
}

/** Result of {@link discoverAndParsePackages}. */
export interface DiscoveryResult {
  /**
   * Accepted packages in precedence order (project, then home, then
   * user, then embedded), each with manifest + prompt resolved and
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
}

/**
 * Discover plugin package dirs under all four roots, dedupe by
 * realpath (highest-precedence root wins), then parse + gate each
 * manifest in precedence order. Per-package failures are logged and
 * skipped; this function never throws for a bad package.
 */
export function discoverAndParsePackages(opts: DiscoveryOptions): DiscoveryResult {
  const { logger, disabledPluginIds, enabledPluginIds } = opts

  // Discover packages in all four roots. Precedence on package-id
  // collision: project > home > user > embedded (closer-to-user wins).
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
  if (opts.homeDir) {
    for (const d of discoverPackageDirs(opts.homeDir, "plugins")) {
      packages.push({ dir: d, root: "home" })
    }
  }
  if (opts.projectDir) {
    for (const d of discoverPackageDirs(opts.projectDir, ".agents/plugins")) {
      packages.push({ dir: d, root: "project" })
    }
  }

  // Dedupe by realpath BEFORE the id-collision check. Two roots can
  // legitimately point at the same physical directory:
  //   - cwd == $HOME → projectDir = $HOME → scans $HOME/.agents/plugins
  //   - homeDir = $HOME/.agents       → scans $HOME/.agents/plugins (same dir!)
  //   - symlinks under ~/.agents/plugins pointing into a shared
  //     dev checkout that also lives under projectDir
  // Keep only the highest-precedence root (project > home > user > embedded)
  // for each physical package. This is not a user-actionable warning —
  // emit a Notice that lands in the file log only, not the scrollback.
  const ROOT_PRECEDENCE = { project: 4, home: 3, user: 2, embedded: 1 } as const
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
    diag.notice(
      "plugin-loader",
      `deduped overlapping package roots for ${real}: kept ${winner.root}, ` +
        `dropped ${loser.root} (${loser.dir})`,
    )
  }
  const dedupedPackages = Array.from(byRealPath.values())

  // Parse manifests.
  const parsed: LoadedPlugin[] = []
  const seenIds = new Set<string>()
  // Raw `replayRenderers` values per package dir; see DiscoveryResult.
  const replayRenderersRaw = new Map<string, unknown>()
  // Raw `turnAttachments` values per package dir; see DiscoveryResult.
  const turnAttachmentsRaw = new Map<string, unknown>()
  // Walk in precedence order: project > home > user > embedded.
  const ordered = [
    ...dedupedPackages.filter((p) => p.root === "project"),
    ...dedupedPackages.filter((p) => p.root === "home"),
    ...dedupedPackages.filter((p) => p.root === "user"),
    ...dedupedPackages.filter((p) => p.root === "embedded"),
  ]
  for (const { dir, root } of ordered) {
    const manifestPath = join(dir, "manifest.json")
    let manifest: ManifestFile
    try {
      const raw = JSON.parse(readFileSync(manifestPath, "utf-8"))
      manifest = parseManifest(raw, manifestPath)
      const rawObj = raw as Record<string, unknown>
      if (rawObj.replayRenderers != null) {
        replayRenderersRaw.set(dir, rawObj.replayRenderers)
      }
      if (rawObj.turnAttachments != null) {
        turnAttachmentsRaw.set(dir, rawObj.turnAttachments)
      }
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
      // A higher-precedence copy of this id already won, so this copy is
      // skipped. That part is correct and intentional. But this is routine
      // precedence resolution, NOT a user-actionable error: the common
      // trigger is the same plugins repo present under two roots with
      // DISTINCT realpaths (e.g. ~/.agents/plugins/* symlinked into one
      // checkout while ~/.minimal-agent/plugins/* is a second checkout of
      // the same repo — same manifest id, different files on disk, so the
      // realpath dedup above can't collapse them). Emitting a loud ⚠ warn
      // for that on every startup just races the banner box with noise.
      //
      // Route through the injected logger when a test supplies one (so the
      // shadow stays observable in tests) and otherwise emit a Notice that
      // lands in the file log only, never the scrollback — matching the
      // realpath-dedup and disabled-by-manifest branches that bracket this
      // one.
      const msg =
        `skipping ${dir}: package id "${manifest.id}" already loaded ` +
        `(precedence: project > home > user > embedded)`
      if (opts.explicitLogger) {
        opts.explicitLogger(msg)
      } else {
        diag.notice("plugin-loader", msg)
      }
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
        `(manifest.enabled = false); set plugins.${manifest.id}.enabled = true ` +
        `in ~/.minimal-agent/config.jsonc to enable`
      if (opts.explicitLogger) {
        opts.explicitLogger(msg)
      } else {
        diag.notice("plugin-loader", msg)
      }
      // Reserve the id so a later (lower-precedence) copy doesn't sneak in.
      seenIds.add(manifest.id)
      continue
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
    const hasAnyDeclared =
      (manifest.tuis?.length ?? 0) > 0 ||
      (manifest.modes?.length ?? 0) > 0 ||
      (manifest.events?.length ?? 0) > 0 ||
      (manifest.hooks?.length ?? 0) > 0 ||
      (manifest.promptFragments?.length ?? 0) > 0 ||
      (manifest.liveAreaSlots?.length ?? 0) > 0
    if (!hasAnyDeclared && prompt === null) {
      logger(
        `${dir}: plugin "${manifest.id}" declares no contributions (tuis, ` +
          `modes, events, hooks, promptFragments, liveAreaSlots) and ships ` +
          `no PROMPT.md; it will load but do nothing`,
      )
    }

    parsed.push({
      packageDir: dir,
      root,
      manifest,
      handlers: [], // filled after collision resolution
      eventSubs: [], // filled after handler resolution
      hookSubs: [], // filled after hook permission/shape checks
      liveAreaSlots: [], // filled after handler resolution
      commands: [], // filled after handler resolution
      prompt,
    })
    seenIds.add(manifest.id)
  }

  return { parsed, replayRenderersRaw, turnAttachmentsRaw }
}

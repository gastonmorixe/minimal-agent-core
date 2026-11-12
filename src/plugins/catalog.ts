/**
 * Lightweight plugin catalog for `plugins list` and CLI help: filesystem
 * scan only, no handler imports. Reuses the loader's root precedence and
 * enable gates. {@link buildPluginCliCatalog} also applies the loader's
 * platform whitelist and `hostMode:stdio` gates (SPEC-HELP R-22, M-5).
 *
 * @module plugins/catalog
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

import type {
  CatalogCliEntry,
  CatalogCliHostMode,
  CatalogCliHostModeDisabled,
  CatalogCliNote,
} from "../../plugin-api/src/types/cli-contract.ts"
import {
  detectPlatform,
  type NormalizedPlatform,
  platformAllowed,
} from "../../plugin-api/src/utils/platform.ts"
import { processDiagnostics } from "../diagnostics/hub.ts"

import { hasHostModeStdio } from "./host-mode-permission.ts"
import { discoverPackageDirs } from "./loader/helpers.ts"
import { PLUGIN_ROOT_TIERS, type PluginRoots, type PluginRootTier } from "./loader/roots.ts"
import { parseManifest } from "./manifest.ts"
import type { CliWarn } from "./manifest-cli.ts"
import type { PluginEnableOverrideSets } from "./plugin-enable-resolution.ts"
import {
  collectFlagValues,
  parseCommaSeparatedIds,
  resolvePluginEnabledOverrides,
} from "./plugin-enable-resolution.ts"
import { diskPluginPackage, embeddedPluginPackages, type PluginPackage } from "./source.ts"
import type { ManifestFile, ManifestHostMode } from "./types.ts"

export type CatalogRoot = PluginRootTier

export interface PluginCatalogEntry {
  id: string
  name: string
  description: string
  root: CatalogRoot
  /** Author shipped with manifest.enabled === false. */
  manifestDisabled: boolean
  /** Effective on/off after config/env/CLI overrides (manifest applied). */
  effectiveOn: boolean
  /** Why off, when not default-on; empty when on with no override note. */
  note: string
}

/**
 * Catalog roots: the same host-computed plugin roots the loader takes
 * (S40). Each directory holds plugin package directories directly.
 */
export type CatalogRoots = PluginRoots

export interface CatalogOverridesInput {
  config: PluginEnableOverrideSets
  env?: { disable?: string; enable?: string }
  /**
   * Raw argv. The catalog reads only `--disable-plugin` and
   * `--enable-plugin`. Ignored when {@link CatalogOverridesInput.cli} is
   * set.
   */
  cliArgs?: readonly string[]
  /**
   * The CLI override lists, in the same shape the loader input takes
   * (`ResolvePluginEnableInput.cli`). Pass the exact lists you give the
   * loader, including aliases such as `--no-agents-md` that a host turns
   * into a disable of `agents-md`. When set, `cliArgs` is ignored.
   */
  cli?: { disable?: readonly string[]; enable?: readonly string[] }
}

/** One first-seen manifest, before overrides. Internal to the catalog. */
interface ScannedManifest {
  row: Omit<PluginCatalogEntry, "effectiveOn" | "note">
  manifest: Record<string, unknown>
  manifestPath: string
}

/** Scan plugin roots and return one row per first-seen manifest id. */
export function scanPluginCatalog(
  roots: CatalogRoots,
): Omit<PluginCatalogEntry, "effectiveOn" | "note">[] {
  return scanManifests(roots, defaultWarn).map((m) => m.row)
}

/** The default diagnostics sink: the process bus, source `plugin.manifest`. */
function defaultWarn(msg: string): void {
  processDiagnostics().warn("plugin.manifest", msg)
}

/**
 * Read every first-seen manifest as raw JSON, sorted by id. The first
 * copy of an id in root precedence order wins. Never imports a module.
 */
function scanManifests(roots: CatalogRoots, warn: CliWarn): ScannedManifest[] {
  const seen = new Set<string>()
  const out: ScannedManifest[] = []
  for (const m of collectManifests(roots, warn)) {
    if (seen.has(m.row.id)) continue
    seen.add(m.row.id)
    out.push(m)
  }
  out.sort((a, b) => a.row.id.localeCompare(b.row.id))
  return out
}

/**
 * Read every manifest with a string id as raw JSON, in root precedence
 * order (project, user, embedded). No dedupe. Never imports a module.
 */
function collectManifests(roots: CatalogRoots, warn: CliWarn): ScannedManifest[] {
  const packages: { pkg: PluginPackage; root: CatalogRoot }[] = []
  for (const tier of PLUGIN_ROOT_TIERS) {
    for (const rootDir of roots[tier] ?? []) {
      for (const d of packageDirsOf(rootDir, warn)) {
        packages.push({ pkg: diskPluginPackage(d, tier), root: tier })
      }
    }
  }
  // The registered embedded table, after the disk roots of the embedded
  // tier, the same order as the loader. Empty in a source run.
  for (const pkg of embeddedPluginPackages()) packages.push({ pkg, root: "embedded" })

  const ordered = [
    ...packages.filter((p) => p.root === "project"),
    ...packages.filter((p) => p.root === "user"),
    ...packages.filter((p) => p.root === "embedded"),
  ]

  const out: ScannedManifest[] = []
  for (const { pkg, root } of ordered) {
    const manifestPath = pkg.resolve("manifest.json")
    let raw: unknown
    try {
      const text = pkg.readText("manifest.json")
      if (text === null) continue
      raw = JSON.parse(text)
    } catch {
      continue
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const manifest = raw as Record<string, unknown>
    const id = manifest.id
    if (typeof id !== "string" || id.length === 0) continue
    out.push({
      row: {
        id,
        name: typeof manifest.name === "string" ? manifest.name : id,
        description: typeof manifest.description === "string" ? manifest.description : "",
        root,
        manifestDisabled: manifest.enabled === false,
      },
      manifest,
      manifestPath,
    })
  }
  return out
}

/**
 * The package dirs of one root, the same list and order as the loader's
 * `discoverPackageDirs`. That helper throws when an entry cannot be
 * stat'ed (a broken symlink gives ENOENT). The catalog then rescans the
 * root one entry at a time, skips each entry that throws, and warns once
 * per skipped entry (M14A-5). A root it cannot read gives no package.
 */
function packageDirsOf(rootDir: string, warn: CliWarn): string[] {
  try {
    return discoverPackageDirs(rootDir, "")
  } catch {
    // Fall through to the per-entry scan below.
  }
  let names: string[]
  try {
    names = readdirSync(rootDir).sort()
  } catch (e) {
    warn(`${rootDir}: catalog skips the plugin root: ${errText(e)}`)
    return []
  }
  const out: string[] = []
  for (const name of names) {
    const full = join(rootDir, name)
    try {
      if (!statSync(full).isDirectory()) continue
      if (!existsSync(join(full, "manifest.json"))) continue
    } catch (e) {
      warn(`${full}: catalog skips the entry: ${errText(e)}`)
      continue
    }
    out.push(full)
  }
  return out
}

/** Apply enable/disable overrides and attach effective state + note. */
export function buildPluginCatalog(
  roots: CatalogRoots,
  overridesInput: CatalogOverridesInput,
): PluginCatalogEntry[] {
  const resolveState = overrideResolver(overridesInput)
  return scanPluginCatalog(roots).map((entry) => {
    const state = resolveState(entry)
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      root: entry.root,
      manifestDisabled: entry.manifestDisabled,
      effectiveOn: state.effectiveOn,
      note: state.note,
    }
  })
}

/** Options for {@link buildPluginCliCatalog}. */
export interface CatalogCliOptions {
  /**
   * Platform to gate manifest `platforms` whitelists against. Pass the
   * value of `resolveEffectivePlatform` (the loader gets the same value).
   * Default: the detected platform, the same default as the loader.
   */
  effectivePlatform?: NormalizedPlatform
  /**
   * Sink for manifest diagnostics (`cli` block or host-mode help dropped,
   * invalid manifest). Default: the process diagnostics bus, source
   * `plugin.manifest`, the same sink `parseManifest` uses.
   */
  warn?: CliWarn
}

/**
 * Build the help and dispatch catalog: one {@link CatalogCliEntry} per
 * plugin id, with the validated `cli` block and host-mode help. Each
 * manifest goes through the loader's own `parseManifest` (which calls
 * `parseCli` and `parseHostMode`). It reads JSON only and never imports a
 * handler module (SPEC-HELP R-18, R-22).
 *
 * Gates, in the loader's order (`loader/discovery.ts`):
 * - An invalid manifest does not reserve its id, so a valid lower-root
 *   copy wins. With no valid copy, the entry is off with note `"invalid"`.
 * - Enable overrides and the manifest opt-out (CLI \> env \> config \>
 *   manifest), with the notes of {@link buildPluginCatalog}.
 * - The platform whitelist (`platformAllowed`). A gated entry is off with
 *   note `"platform"`. A force-enable does not revive it, the same as the
 *   loader.
 * - A host mode of a plugin with no `hostMode:stdio` permission gets
 *   `disabled: "permission"` (`loader/host-modes.ts`, `hasHostModeStdio`).
 * - Host-mode id collisions, first wins in the loader's load order (root
 *   tier project, user, embedded, then root list order, then
 *   package dir name), not in the sorted output order. Only entries that
 *   are on and host modes that pass the permission gate take part, the
 *   same as `collectHostModes`. A later host mode with a taken id gets
 *   `disabled: "collision"`.
 *
 * Static gates only. The loader also rejects a whole plugin at load time
 * for a tool name collision or a handler module that fails to resolve,
 * and skips a host mode whose entry module fails to resolve. The catalog
 * cannot see these without an import, so such a plugin (or host mode)
 * still shows as on (SPEC-HELP K-12).
 *
 * Gated entries and host modes stay in the list, so `--help --all` can
 * show them. The output is sorted by plugin id.
 */
export function buildPluginCliCatalog(
  roots: CatalogRoots,
  overridesInput: CatalogOverridesInput,
  options: CatalogCliOptions = {},
): CatalogCliEntry[] {
  return scanPluginCliCatalog(roots, overridesInput, options).map((w) => w.entry)
}

/**
 * One {@link CatalogCliEntry} plus the package dir of the winning
 * manifest. Internal to core: the package dir is a machine path, so it
 * stays out of the public catalog type. `packageDir` is absent for an
 * `"invalid"` entry (no copy passed validation).
 */
export interface CatalogCliWinner {
  entry: CatalogCliEntry
  packageDir?: string
}

/**
 * The scan behind {@link buildPluginCliCatalog}, with the same gates, but
 * each row also keeps the package dir of its winning manifest. The CLI
 * command loader (`cli-command-loader.ts`) uses it so the catalog and the
 * loader can never disagree on which copy wins or on the on/off state.
 * Sorted by plugin id. Never imports a module.
 */
export function scanPluginCliCatalog(
  roots: CatalogRoots,
  overridesInput: CatalogOverridesInput,
  options: CatalogCliOptions = {},
): CatalogCliWinner[] {
  const resolveState = overrideResolver(overridesInput)
  const effectivePlatform = options.effectivePlatform ?? detectPlatform()
  const warn = options.warn ?? defaultWarn

  // Map insertion order is the loader's load order: `collectManifests`
  // walks root precedence, and each id is inserted at its winning copy.
  const valid = new Map<string, CatalogCliEntry>()
  const dirs = new Map<string, string>()
  const invalid = new Map<string, CatalogCliEntry>()
  for (const { row, manifest: raw, manifestPath } of collectManifests(roots, warn)) {
    if (valid.has(row.id)) continue
    let manifest: ManifestFile
    try {
      manifest = parseManifest(raw, manifestPath, { warn })
    } catch (e) {
      warn(`${manifestPath}: catalog marks plugin "${row.id}" invalid: ${errText(e)}`)
      if (!invalid.has(row.id)) {
        invalid.set(row.id, {
          pluginId: row.id,
          root: row.root,
          effectiveOn: false,
          note: "invalid",
          hostModes: [],
        })
      }
      continue
    }
    let { effectiveOn, note } = resolveState(row)
    if (effectiveOn && !platformAllowed(manifest.platforms, effectivePlatform)) {
      effectiveOn = false
      note = "platform"
    }
    const disabled = hasHostModeStdio(manifest) ? undefined : "permission"
    valid.set(row.id, {
      pluginId: row.id,
      root: row.root,
      effectiveOn,
      note,
      ...(manifest.cli ? { cli: manifest.cli } : {}),
      hostModes: (manifest.hostModes ?? []).map((spec) => toCatalogHostMode(spec, disabled)),
    })
    dirs.set(row.id, dirname(manifestPath))
  }
  markHostModeCollisions(valid.values())
  for (const [id, entry] of invalid) {
    if (!valid.has(id)) valid.set(id, entry)
  }
  return [...valid.values()]
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId))
    .map((entry) => {
      const packageDir = dirs.get(entry.pluginId)
      return packageDir === undefined ? { entry } : { entry, packageDir }
    })
}

/**
 * Mark host-mode id collisions in load order, first wins, the same rule
 * as `collectHostModes` (`loader/host-modes.ts`). Entries that are off
 * and host modes already disabled never claim an id, because the loader
 * never reaches them.
 */
function markHostModeCollisions(entriesInLoadOrder: Iterable<CatalogCliEntry>): void {
  const claimed = new Set<string>()
  for (const entry of entriesInLoadOrder) {
    if (!entry.effectiveOn) continue
    for (const hostMode of entry.hostModes) {
      if (hostMode.disabled !== undefined) continue
      if (claimed.has(hostMode.id)) {
        hostMode.disabled = "collision"
        continue
      }
      claimed.add(hostMode.id)
    }
  }
}

/** Copy the help fields of one validated host mode. Never its `entry`. */
function toCatalogHostMode(
  spec: ManifestHostMode,
  disabled: CatalogCliHostModeDisabled | undefined,
): CatalogCliHostMode {
  return {
    id: spec.id,
    description: spec.description,
    ...(spec.args ? { args: spec.args } : {}),
    ...(spec.examples ? { examples: spec.examples } : {}),
    ...(disabled ? { disabled } : {}),
  }
}

/** The message of an unknown thrown value. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The CLI override lists: the structured `cli` input when set, else the
 * `--disable-plugin` and `--enable-plugin` values of `cliArgs`.
 */
function cliOverrideLists(overridesInput: CatalogOverridesInput): {
  disable: string[]
  enable: string[]
} {
  if (overridesInput.cli) {
    return {
      disable: [...(overridesInput.cli.disable ?? [])],
      enable: [...(overridesInput.cli.enable ?? [])],
    }
  }
  const args = overridesInput.cliArgs ?? []
  return {
    disable: collectFlagValues(args, "--disable-plugin"),
    enable: collectFlagValues(args, "--enable-plugin"),
  }
}

/** Resolve the override layers (CLI, then env, then config, then manifest) once per build. */
function overrideResolver(overridesInput: CatalogOverridesInput): (
  entry: Pick<PluginCatalogEntry, "id" | "manifestDisabled">,
) => {
  effectiveOn: boolean
  note: CatalogCliNote
} {
  const { disable: cliDisable, enable: cliEnable } = cliOverrideLists(overridesInput)
  const resolved = resolvePluginEnabledOverrides({
    config: overridesInput.config,
    env: overridesInput.env,
    cli: { disable: cliDisable, enable: cliEnable },
  })

  const envDisable = new Set(parseCommaSeparatedIds(overridesInput.env?.disable))
  const envEnable = new Set(parseCommaSeparatedIds(overridesInput.env?.enable))
  const cliDisableSet = new Set(cliDisable)
  const cliEnableSet = new Set(cliEnable)

  return (entry) =>
    effectiveState(entry, resolved, {
      config: overridesInput.config,
      envDisable,
      envEnable,
      cliDisable: cliDisableSet,
      cliEnable: cliEnableSet,
    })
}

function effectiveState(
  entry: Pick<PluginCatalogEntry, "id" | "manifestDisabled">,
  resolved: PluginEnableOverrideSets,
  layers: {
    config: PluginEnableOverrideSets
    envDisable: Set<string>
    envEnable: Set<string>
    cliDisable: Set<string>
    cliEnable: Set<string>
  },
): { effectiveOn: boolean; note: CatalogCliNote } {
  const { id } = entry
  if (resolved.forceDisabled.has(id)) {
    const note = disableReason(id, layers)
    return { effectiveOn: false, note }
  }
  if (entry.manifestDisabled && !resolved.forceEnabled.has(id)) {
    return { effectiveOn: false, note: "manifest" }
  }
  if (resolved.forceEnabled.has(id)) {
    const note = enableReason(id, layers)
    return { effectiveOn: true, note }
  }
  return { effectiveOn: true, note: "" }
}

function disableReason(
  id: string,
  layers: {
    config: PluginEnableOverrideSets
    envDisable: Set<string>
    cliDisable: Set<string>
  },
): CatalogCliNote {
  if (layers.cliDisable.has(id)) return "cli"
  if (layers.envDisable.has(id)) return "env"
  if (layers.config.forceDisabled.has(id)) return "config"
  return ""
}

function enableReason(
  id: string,
  layers: {
    config: PluginEnableOverrideSets
    envEnable: Set<string>
    cliEnable: Set<string>
  },
): CatalogCliNote {
  if (layers.cliEnable.has(id)) return "cli"
  if (layers.envEnable.has(id)) return "env"
  if (layers.config.forceEnabled.has(id)) return "config"
  return ""
}

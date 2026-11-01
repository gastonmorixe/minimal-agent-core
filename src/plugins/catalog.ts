/**
 * Lightweight plugin catalog for `plugins list` — filesystem scan only,
 * no handler imports. Reuses the loader's root precedence and enable gates.
 *
 * @module plugins/catalog
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { discoverPackageDirs } from "./loader/helpers.ts"
import { PLUGIN_ROOT_TIERS, type PluginRoots, type PluginRootTier } from "./loader/roots.ts"
import type { PluginEnableOverrideSets } from "./plugin-enable-resolution.ts"
import {
  collectFlagValues,
  parseCommaSeparatedIds,
  resolvePluginEnabledOverrides,
} from "./plugin-enable-resolution.ts"

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
  cliArgs?: readonly string[]
}

/** Scan plugin roots and return one row per first-seen manifest id. */
export function scanPluginCatalog(
  roots: CatalogRoots,
): Omit<PluginCatalogEntry, "effectiveOn" | "note">[] {
  const packages: { dir: string; root: CatalogRoot }[] = []
  for (const tier of PLUGIN_ROOT_TIERS) {
    for (const rootDir of roots[tier] ?? []) {
      for (const d of discoverPackageDirs(rootDir, "")) {
        packages.push({ dir: d, root: tier })
      }
    }
  }

  const ordered = [
    ...packages.filter((p) => p.root === "project"),
    ...packages.filter((p) => p.root === "home"),
    ...packages.filter((p) => p.root === "user"),
    ...packages.filter((p) => p.root === "embedded"),
  ]

  const seen = new Set<string>()
  const out: Omit<PluginCatalogEntry, "effectiveOn" | "note">[] = []
  for (const { dir, root } of ordered) {
    const manifestPath = join(dir, "manifest.json")
    if (!existsSync(manifestPath)) continue
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(manifestPath, "utf-8"))
    } catch {
      continue
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const manifest = raw as Record<string, unknown>
    const id = manifest.id
    if (typeof id !== "string" || id.length === 0) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: typeof manifest.name === "string" ? manifest.name : id,
      description: typeof manifest.description === "string" ? manifest.description : "",
      root,
      manifestDisabled: manifest.enabled === false,
    })
  }
  out.sort((a, b) => a.id.localeCompare(b.id))
  return out
}

/** Apply enable/disable overrides and attach effective state + note. */
export function buildPluginCatalog(
  roots: CatalogRoots,
  overridesInput: CatalogOverridesInput,
): PluginCatalogEntry[] {
  const cliDisable = overridesInput.cliArgs
    ? collectFlagValues(overridesInput.cliArgs, "--disable-plugin")
    : []
  const cliEnable = overridesInput.cliArgs
    ? collectFlagValues(overridesInput.cliArgs, "--enable-plugin")
    : []
  const resolved = resolvePluginEnabledOverrides({
    config: overridesInput.config,
    env: overridesInput.env,
    cli: { disable: cliDisable, enable: cliEnable },
  })

  const envDisable = new Set(parseCommaSeparatedIds(overridesInput.env?.disable))
  const envEnable = new Set(parseCommaSeparatedIds(overridesInput.env?.enable))
  const cliDisableSet = new Set(cliDisable)
  const cliEnableSet = new Set(cliEnable)

  return scanPluginCatalog(roots).map((entry) => {
    const state = effectiveState(entry, resolved, {
      config: overridesInput.config,
      envDisable,
      envEnable,
      cliDisable: cliDisableSet,
      cliEnable: cliEnableSet,
    })
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
): { effectiveOn: boolean; note: string } {
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
): string {
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
): string {
  if (layers.cliEnable.has(id)) return "cli"
  if (layers.envEnable.has(id)) return "env"
  if (layers.config.forceEnabled.has(id)) return "config"
  return ""
}

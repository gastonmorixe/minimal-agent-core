/**
 * Plugin dependency check for the host boot (WEB-PLUGINS-001, Q-3).
 *
 * The boot does not install plugin dependencies. The operator installs them.
 * This module finds provider plugin dirs whose `package.json` declares a
 * dependency but that have no `node_modules` dir, and returns one
 * diagnostic for each. It never throws and never writes.
 *
 * `@minimal-agent/core` does not count as a dependency here. The host-core
 * resolver serves every `@minimal-agent/core/*` import from the host's own
 * copy, so a plugin that needs only core loads with no `node_modules`.
 *
 * @module adapters/plugin-deps
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { findProviderPluginDirs } from "../llm/provider-discovery.ts"

/** The package name that the host-core resolver serves. */
const CORE_PACKAGE = "@minimal-agent/core"

/** One problem that the host boot found. The boot reports it and continues. */
export interface HostBootDiagnostic {
  /**
   * - `plugin-deps-missing`: a provider plugin declares dependencies but has
   *   no `node_modules`.
   * - `provider-discovery-failed`: provider discovery threw (for example, a
   *   plugin imports a package that is not installed).
   * - `plugin-sync-failed`: the first-run plugin clone failed.
   * - `plugin-warning`: the plugin loader logged a warning.
   */
  readonly kind:
    | "plugin-deps-missing"
    | "provider-discovery-failed"
    | "plugin-sync-failed"
    | "plugin-warning"
  /** Plain-text description. It names the fix when there is one. */
  readonly message: string
  /** Plugin id, when the problem belongs to one plugin. */
  readonly pluginId?: string
  /** Plugin dir, when the problem belongs to one plugin. */
  readonly dir?: string
}

/** Read the non-core dependency names from `<dir>/package.json`. */
function declaredDependencies(dir: string): string[] {
  const path = join(dir, "package.json")
  if (!existsSync(path)) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return []
  const deps = (parsed as Record<string, unknown>).dependencies
  if (!deps || typeof deps !== "object" || Array.isArray(deps)) return []
  return Object.keys(deps).filter((name) => name !== CORE_PACKAGE)
}

/**
 * Find provider plugin dirs under `roots` that declare dependencies but
 * have no `node_modules`. Returns one diagnostic for each such dir.
 *
 * @param roots - provider plugin roots, in discovery order.
 */
export function findMissingPluginDeps(roots: readonly string[]): HostBootDiagnostic[] {
  const out: HostBootDiagnostic[] = []
  for (const root of roots) {
    for (const { dir, descriptor } of findProviderPluginDirs(root)) {
      const deps = declaredDependencies(dir)
      if (deps.length === 0 || existsSync(join(dir, "node_modules"))) continue
      out.push({
        kind: "plugin-deps-missing",
        pluginId: descriptor.id,
        dir,
        message:
          `provider plugin "${descriptor.id}" declares dependencies (${deps.join(", ")}) ` +
          `but has no node_modules. Run "bun install" in ${dir}.`,
      })
    }
  }
  return out
}

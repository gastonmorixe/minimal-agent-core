/**
 * Host-mode resolution: turns `hostModes[]` manifest entries into an
 * invocable `HostModeHandler`. Mirrors `event-subs.ts`'s `resolveCommand`: module
 * handlers only (enforced earlier, in `manifest.ts`'s `parseHostMode`), and
 * lenient on a resolution failure — a broken host mode is logged and
 * skipped, it never disqualifies the rest of the plugin's tools.
 *
 * `ResolvedHostMode` lives here, in core, rather than in the plugin-api
 * leaf package: its `handler` is a real `HostModeHandler`
 * (`src/host-public/host-mode.ts`), which carries core's own session/event
 * types, and the leaf package may import nothing from `src/`. The plain
 * manifest shape (`ManifestHostMode`) stays in plugin-api; only the
 * RESOLVED, invocable form is core-only.
 *
 * @module plugins/loader/host-modes
 */

import type { HostModeHandler } from "../../host-public/host-mode.ts"
import { hasHostModeStdio } from "../host-mode-permission.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin, ManifestHostMode } from "../types.ts"

/** A `hostModes[]` entry paired with its resolved, invocable handler. */
export interface ResolvedHostMode {
  /** The original manifest entry. */
  spec: ManifestHostMode
  /** Plugin id this host mode belongs to (for grouping / diagnostics). */
  pluginId: string
  /** Absolute path to the package directory (the handler's `cwd`). */
  packageDir: string
  /** Absolute path to the handler module. */
  entryAbsolute: string
  /** The resolved handler. Called at most once per process (Level 1). */
  handler: HostModeHandler
}

/**
 * Resolve one `hostModes[i]` entry to an invocable {@link ResolvedHostMode}.
 *
 * @param spec - Validated manifest host-mode entry.
 * @param pluginId - Owning plugin id.
 * @param packageDir - Absolute package dir (the handler's cwd).
 * @param logger - Diagnostic sink.
 * @returns The resolved host mode, or `null` when it could not be loaded.
 */
export async function resolveHostMode(
  spec: ManifestHostMode,
  pluginId: string,
  packageDir: string,
  logger: (msg: string) => void,
): Promise<ResolvedHostMode | null> {
  if (spec.entry.type !== "module") {
    logger(`${packageDir}: host mode "${spec.id}" entry must be module type; skipping`)
    return null
  }
  const pkg = pluginPackageFor(packageDir)
  const rel = spec.entry.path
  const abs = pkg.resolve(rel)
  if (!pkg.hasFile(rel)) {
    logger(`${packageDir}: host mode "${spec.id}" entry module not found: ${abs}`)
    return null
  }
  let mod: { default?: HostModeHandler }
  try {
    mod = (await pkg.importModule(rel)) as typeof mod
  } catch (e) {
    logger(
      `${packageDir}: failed to import host mode entry ${abs}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    )
    return null
  }
  const handler = mod.default
  if (typeof handler !== "function") {
    logger(`${packageDir}: host mode entry ${abs} has no default export function`)
    return null
  }
  return { spec, pluginId, packageDir, entryAbsolute: abs, handler }
}

/**
 * Collect every loaded plugin's `hostModes[]` into one first-wins map, by
 * id. Same lenient policy as modes/commands: a collision or a resolution
 * failure is logged and skipped, never thrown.
 *
 * `hostMode:stdio` is an IMPLICIT permission every `hostModes[]` entry
 * requires beyond whatever it lists itself in `ManifestHostMode.permissions`
 * (owning the process's stdin/stdout for the run's lifetime is a large
 * capability; see the hostModes design doc, Q-H4). A plugin that omits it
 * gets every entry skipped with a diagnostic, the same lenient way a
 * missing hook permission is handled.
 */
export async function collectHostModes(
  finalPlugins: readonly LoadedPlugin[],
  logger: (msg: string) => void,
): Promise<Map<string, ResolvedHostMode>> {
  const hostModes = new Map<string, ResolvedHostMode>()
  for (const pkg of finalPlugins) {
    const entries = pkg.manifest.hostModes ?? []
    if (entries.length === 0) continue
    const hasStdioPermission = hasHostModeStdio(pkg.manifest)
    for (const spec of entries) {
      if (!hasStdioPermission) {
        logger(
          `${pkg.packageDir}: host mode "${spec.id}" needs the "hostMode:stdio" permission; skipping`,
        )
        continue
      }
      if (hostModes.has(spec.id)) {
        logger(
          `${pkg.packageDir}: host mode "${spec.id}" collides with another loaded plugin; skipping`,
        )
        continue
      }
      const resolved = await resolveHostMode(spec, pkg.manifest.id, pkg.packageDir, logger)
      if (resolved) hostModes.set(spec.id, resolved)
    }
  }
  return hostModes
}

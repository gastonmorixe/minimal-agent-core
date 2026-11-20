/**
 * Collect the modes of the loaded plugins. Split out of `loader.ts` to keep
 * that file under the line limit.
 *
 * @module plugins/loader/plugin-modes
 */

import type { LoadedPlugin, ManifestMode } from "../types.ts"

/**
 * A mode declaration as exposed by the loader to consumers (`LoadedMode` in
 * `loader.ts` is an alias of this type).
 *
 * Carries everything the `ModeManager` needs plus the source plugin id so
 * diagnostics can point back to the contributing package.
 */
export interface PluginMode extends ManifestMode {
  /** Plugin id that contributed this mode (for logging and disambiguation). */
  pluginId: string
}

/**
 * Collect the modes after the handlers, because a mode collision does not
 * disqualify the tools of a plugin: a colliding mode is skipped with a
 * warning. The first mode that asks to be the default wins.
 *
 * @param plugins - The loaded plugins, in load order.
 * @param logger - Where the warnings go.
 * @returns The modes and the id of the default mode, or `null`.
 */
export function collectPluginModes(
  plugins: readonly LoadedPlugin[],
  logger: (msg: string) => void,
): { modes: PluginMode[]; defaultModeId: string | null } {
  const modes: PluginMode[] = []
  const seenModeIds = new Set<string>()
  let defaultModeId: string | null = null
  for (const pkg of plugins) {
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
  return { modes, defaultModeId }
}

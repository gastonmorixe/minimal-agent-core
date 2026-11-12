/**
 * Public entry for `@minimal-agent/core/host-kit/embedded-plugins`.
 *
 * A compiled host registers its build-time generated plugin table here
 * once at startup, before provider discovery and `PluginLoader.load`:
 *
 * ```ts
 * import { registerEmbeddedPlugins } from "@minimal-agent/core/host-kit/embedded-plugins"
 * import { TABLE } from "#embedded-plugins"
 * registerEmbeddedPlugins(TABLE)
 * ```
 *
 * The table is the lowest-precedence plugin source: a project or user copy
 * of a plugin id wins. A source run registers nothing. See
 * `../plugins/source.ts` for the full contract.
 *
 * @module host-public/embedded-plugins
 */

export {
  clearEmbeddedPlugins,
  type EmbeddedPluginPackageEntry,
  type EmbeddedPluginTable,
  embeddedPluginPackages,
  findEmbeddedScript,
  hasEmbeddedPlugins,
  type MaterializeOptions,
  materializeEmbedded,
  normalizePackagePath,
  type PluginPackage,
  type PluginPackageKind,
  type PluginPackageRoot,
  pluginPackageFor,
  pruneEmbeddedCache,
  type RegisterEmbeddedPluginsOptions,
  registerEmbeddedPlugins,
} from "../plugins/source.ts"

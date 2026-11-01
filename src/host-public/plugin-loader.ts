/**
 * Public re-export of src/plugins/loader.ts (`PluginLoader` and its
 * option/result types). The single highest-value module in the `host-kit`
 * construction kit (S34 exports-gap decision): every other `host-kit`
 * collaborator is built around one instance of this class.
 *
 * Also re-exports the plugin root types and `providerRootsOf` from
 * `src/plugins/loader/roots.ts` (S40). The host computes every plugin
 * root and passes them in as data.
 *
 * @module host-public/plugin-loader
 */

export {
  PLUGIN_ROOT_TIERS,
  type PluginRoots,
  type PluginRootTier,
  providerRootsOf,
} from "../plugins/loader/roots.ts"
export * from "../plugins/loader.ts"

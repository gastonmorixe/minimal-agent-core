/**
 * Public re-export of src/plugins/loader.ts (`PluginLoader` and its
 * option/result types). The single highest-value module in the `host-kit`
 * construction kit (S34 exports-gap decision): every other `host-kit`
 * collaborator is built around one instance of this class.
 *
 * @module host-public/plugin-loader
 */
export * from "../plugins/loader.ts"

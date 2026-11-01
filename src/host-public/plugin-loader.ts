/**
 * Public re-export of src/plugins/loader.ts (`PluginLoader` and its
 * option/result types). The single highest-value module in the `host-kit`
 * construction kit (S34 exports-gap decision): every other `host-kit`
 * collaborator is built around one instance of this class.
 *
 * Also re-exports `resolveSiblingPluginRoots` from
 * `src/plugins/loader/helpers.ts` by name (sibling-plugin-repo root
 * discovery, the host entry point's only need from that file's 14-export
 * loader-internal grab-bag) — S34 Phase 0 / Bucket C. Folded directly
 * into this barrel rather than given its own file, the same way
 * `src/plugins/loader/commands.ts` folds in
 * `../../cli/slash-command-parse.ts`'s `parseCommandLine` /
 * `looksLikeCommand` by name instead of a dedicated barrel (see
 * `./host-kit/command-registry`).
 *
 * @module host-public/plugin-loader
 */

export { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
export * from "../plugins/loader.ts"

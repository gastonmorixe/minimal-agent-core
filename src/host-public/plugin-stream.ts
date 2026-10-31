/**
 * Public re-export of src/plugins/stream.ts (`PluginStream`), the stateful
 * wrapper that routes text-chunk output through inline-tag dispatch to the
 * loader. Part of the `host-kit` construction kit (S34 exports-gap
 * decision) — tightly bound to `PluginLoader`.
 *
 * @module host-public/plugin-stream
 */
export * from "../plugins/stream.ts"

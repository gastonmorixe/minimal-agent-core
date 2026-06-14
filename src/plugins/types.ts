/**
 * Re-export shim (Wave D-1). The plugin public type surface MOVED to the leaf
 * contract package `@minimal-agent/plugin-api/types/plugin` so plugins can
 * depend on the author-facing handler/manifest/context types without reaching
 * into `src/`. This shim keeps the old `src/plugins/types.ts` import path alive
 * for core (the loader, dispatcher, agent context factory) and any not-yet-swept
 * plugin until the per-plugin D-5..D-12 sweeps re-point importers at the
 * package.
 *
 * It's a types-only module, so `export type *` is sufficient and carries the
 * whole surface, including the `PluginLogger` re-export the package makes for
 * plugin authors. The host references inside the moved module (`PluginLogger`,
 * `PluginHost`) resolve against package-local, type-only structural copies;
 * the runtime that backs them stays in `src/diagnostic-bus.ts` and
 * `src/plugins/host/`, and the host's real logger/host objects satisfy those
 * copies structurally at runtime.
 *
 * @module plugins/types
 */

export type * from "@minimal-agent/plugin-api/types/plugin"

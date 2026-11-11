/**
 * Public re-export shim for `@minimal-agent/core/host/config`.
 *
 * See `host-public/auth-store.ts`'s module doc for why this file lives here.
 * The real implementation stays at `../config/config.ts`: the global
 * user-preferences reader (`loadUserConfig`, `UserConfig`, `configPath`,
 * `loadPluginEnabledOverrides`, `loadModeUserOverrides`). Terminal keys
 * are not here: the CLI reads them itself.
 *
 * @module host-public/config
 */

export * from "../config/config.ts"

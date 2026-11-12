/**
 * Loader-side resolution of manifest `hooks` into `ResolvedHookSub` records.
 * Applies the `requiresUnsafeHooks` gate and the channel permission gate.
 *
 * @module plugins/loader/hook-subs
 */

import { CHANNEL_BY_NAME, hasPermission } from "../hooks/channels.ts"
import type { LoadedPlugin, ResolvedHookSub } from "../types.ts"

import { resolveHookSub } from "./event-subs.ts"

/**
 * Resolve hook subscriptions. Same lenient policy as events: a broken
 * hook handler is logged and skipped, never disqualifies the plugin.
 * Permission gate runs first — a hook on a channel the manifest's
 * `permissions[]` doesn't grant is dropped with a clear log.
 *
 * `requiresUnsafeHooks: true` is honored at the plugin level: when
 * the manifest sets it AND `UNSAFE_HOOKS=1` is unset, we skip every
 * hook subscription this plugin declares (the plugin's tools / tags /
 * events continue to work).
 *
 * @param pkg - The plugin package whose manifest hooks are resolved.
 * @param logger - Sink for skip and failure diagnostics.
 * @returns The resolved hook subscriptions (empty when all are skipped).
 */
export async function resolvePluginHookSubs(
  pkg: LoadedPlugin,
  logger: (msg: string) => void,
): Promise<ResolvedHookSub[]> {
  const unsafeOk = process.env.UNSAFE_HOOKS === "1"
  const skipAllHooks = (pkg.manifest.requiresUnsafeHooks ?? false) && !unsafeOk
  if (skipAllHooks) {
    logger(
      `${pkg.packageDir}: skipping all hooks for plugin "${pkg.manifest.id}" — ` +
        `manifest.requiresUnsafeHooks is true but UNSAFE_HOOKS=1 is not set`,
    )
  }
  const resolvedHookSubs: ResolvedHookSub[] = []
  if (!skipAllHooks) {
    const granted = pkg.manifest.permissions ?? []
    for (const sub of pkg.manifest.hooks ?? []) {
      const spec = CHANNEL_BY_NAME.get(sub.channel)
      if (!spec) {
        logger(
          `${pkg.packageDir}: hook "${sub.id}" — channel "${sub.channel}" is not ` +
            `in the catalog; skipping`,
        )
        continue
      }
      if (!hasPermission(granted, spec.permission)) {
        logger(
          `${pkg.packageDir}: hook "${sub.id}" — channel "${sub.channel}" requires ` +
            `permission "${spec.permission}", but manifest.permissions doesn't grant it; skipping`,
        )
        continue
      }
      const r = await resolveHookSub(sub, pkg.packageDir, logger)
      if (r) resolvedHookSubs.push(r)
    }
  }
  return resolvedHookSubs
}

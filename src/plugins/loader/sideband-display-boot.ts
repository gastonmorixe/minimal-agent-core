/**
 * Boot of the sideband display handlers (manifest `sideband[].display`).
 *
 * For each plugin and each manifest kind with a `display`, the handler loads
 * only when the registry gave the kind to that plugin (the first declaration
 * in boot order). Else the plugin gets one `sideband.display-not-owner`
 * diagnostic. The handler path must stay inside the package and the file must
 * exist. The module import has the boot time limit. The default export must
 * be a function. Each failure gives one `sideband.display-load-failed`
 * diagnostic `{pluginId, kind, reason}`. Nothing here throws.
 *
 * @module plugins/loader/sideband-display-boot
 */

import { isAbsolute, relative } from "node:path"

import type { SidebandDisplayHandler } from "@minimal-agent/core/plugin-api/types/plugin"

import type { SidebandDisplayEntry } from "../../sideband/display.ts"
import type { ReadonlySidebandRegistry } from "../../sideband/types.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

import { BOOT_IMPORT_TIMEOUT_MS, raceImport, TIMED_OUT } from "./boot-import-race.ts"
import type { DiagnosticsRelay } from "./diagnostics-relay.ts"

/** Why a display handler did not load. */
export type SidebandDisplayLoadFailReason =
  | "path-outside"
  | "module-missing"
  | "timeout"
  | "not-function"
  | "import-threw"

/** Options of the display boot. */
export interface DisplayBootOptions {
  /** Time limit for one handler module import, in ms. Default {@link BOOT_IMPORT_TIMEOUT_MS}. */
  timeoutMs?: number
}

/**
 * Import the display handlers of `plugins`. Gives a frozen map from the kind
 * name to the handler entry. Never throws.
 *
 * @param plugins - The accepted plugins, in boot order.
 * @param registry - The frozen registry: it names the owner of each kind.
 * @param relay - The target of the diagnostics.
 * @param timeoutMs - The time limit of one import.
 */
export async function loadDisplayHandlers(
  plugins: readonly LoadedPlugin[],
  registry: ReadonlySidebandRegistry,
  relay: DiagnosticsRelay,
  timeoutMs: number = BOOT_IMPORT_TIMEOUT_MS,
): Promise<ReadonlyMap<string, SidebandDisplayEntry>> {
  const out = new Map<string, SidebandDisplayEntry>()
  for (const p of plugins) {
    const pluginId = p.manifest.id
    for (const k of p.manifest.sideband ?? []) {
      const d = k.display
      if (d === undefined) continue
      if (registry.kind(k.kind)?.owner !== pluginId || out.has(k.kind)) {
        relay.warn("sideband.display-not-owner", "", { pluginId, kind: k.kind })
        continue
      }
      const failed = (reason: SidebandDisplayLoadFailReason): void => {
        relay.warn("sideband.display-load-failed", "", { pluginId, kind: k.kind, reason })
      }
      try {
        const pkg = pluginPackageFor(p.packageDir)
        const rel = relative(p.packageDir, pkg.resolve(d.handler.path))
        if (rel.startsWith("..") || isAbsolute(rel)) {
          failed("path-outside")
          continue
        }
        if (!pkg.hasFile(d.handler.path)) {
          failed("module-missing")
          continue
        }
        const mod = await raceImport(pkg.importModule(d.handler.path), timeoutMs)
        if (mod === TIMED_OUT) {
          failed("timeout")
          continue
        }
        const fn = (mod as { default?: unknown }).default
        if (typeof fn !== "function") {
          failed("not-function")
          continue
        }
        out.set(
          k.kind,
          Object.freeze({
            owner: pluginId,
            fn: fn as SidebandDisplayHandler,
            host: d.host === true,
          }),
        )
      } catch {
        failed("import-threw")
      }
    }
  }
  return out
}

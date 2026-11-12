/**
 * Loader-side wiring of manifest `errorRenderers` into the host's
 * `ErrorRendererRegistry`. Each entry names a module and an export. The
 * export is a factory that returns an `ErrorRenderer`. A failure is a
 * diagnostic with identifier data only (core holds no text). It never stops
 * the boot.
 *
 * @module plugins/loader/error-renderers
 */

import { isAbsolute, relative } from "node:path"

import type { Diagnostics } from "../../diagnostics/hub.ts"
import {
  type ErrorRenderer,
  type ErrorRendererRegistry,
  HOST_OWNER_ID,
} from "../../errors/index.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

/** Loader option that carries the host's registry. */
export interface ErrorRendererOptions {
  /** Receives each loaded plugin's manifest `errorRenderers`. Without it the key is ignored. */
  errorRendererRegistry?: ErrorRendererRegistry
}

function isRenderer(v: unknown): v is ErrorRenderer {
  if (typeof v !== "object" || v === null) return false
  const r = v as { kinds?: unknown; render?: unknown }
  return typeof r.render === "function" && (r.kinds === "*" || Array.isArray(r.kinds))
}

/**
 * Register every declared error renderer of the loaded packages.
 * Factories must be synchronous. A factory that returns a promise fails.
 * An entry that resolves outside its package dir fails.
 * Does nothing when `registry` is undefined.
 */
export async function registerErrorRenderers(
  packages: readonly LoadedPlugin[],
  registry: ErrorRendererRegistry | undefined,
  diagnostics: Diagnostics,
): Promise<void> {
  if (!registry) return
  for (const pkg of packages) {
    const entries = pkg.manifest.errorRenderers ?? []
    if (entries.length === 0) continue
    const pluginId = pkg.manifest.id
    if (pluginId === HOST_OWNER_ID) {
      diagnostics.warn("error_renderer.owner_reserved", "", { pluginId })
      continue
    }
    const source = pluginPackageFor(pkg.packageDir)
    for (const e of entries) {
      const fail = () => diagnostics.warn("error_renderer.load_failed", "", { pluginId, id: e.id })
      const abs = source.resolve(e.entry)
      const rel = relative(pkg.packageDir, abs)
      if (rel.startsWith("..") || isAbsolute(rel) || !source.hasFile(e.entry)) {
        fail()
        continue
      }
      try {
        const mod = (await source.importModule(e.entry)) as Record<string, unknown>
        const factory = mod[e.export ?? "default"]
        const renderer = typeof factory === "function" ? (factory as () => unknown)() : undefined
        if (typeof (renderer as { then?: unknown } | undefined)?.then === "function") {
          Promise.resolve(renderer).catch(() => {})
        }
        if (!isRenderer(renderer)) {
          fail()
          continue
        }
        registry.register(renderer, pluginId)
      } catch {
        fail()
      }
    }
  }
}

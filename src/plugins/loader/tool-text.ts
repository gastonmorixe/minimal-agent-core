/**
 * Loader-side wiring of manifest `toolText` (built-in tool text, contract
 * `text.tools`). Each entry names a module and an export. The export is a
 * synchronous factory that returns a `ToolTextProvider`. The loader checks
 * that `provider.tools` equals the manifest `tools` list. A failure is a
 * diagnostic with identifier data only (core holds no text). It never stops
 * the boot.
 *
 * @module plugins/loader/tool-text
 */

import { isAbsolute, relative } from "node:path"

import type { ToolTextProvider } from "../../../plugin-api/src/types/tool-text.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

import { resolvePath } from "./helpers.ts"
import { sameNames } from "./synthetic-text.ts"

function isProvider(v: unknown): v is ToolTextProvider {
  if (typeof v !== "object" || v === null) return false
  const p = v as { tools?: unknown; tool?: unknown }
  return (
    typeof p.tool === "function" &&
    Array.isArray(p.tools) &&
    p.tools.every((t) => typeof t === "string")
  )
}

/**
 * Collect every declared tool text provider of the loaded packages, in
 * package order. A provider whose `tools` differ from the manifest list is
 * kept, with a `tool_text.tools_mismatch` diagnostic (same policy as
 * `synthetic.kinds_mismatch`). Any other failure is
 * `tool_text.load_failed`. A package whose `text.tools` a closer root tier
 * owns (`overridden`, F2) is skipped.
 */
export async function collectToolTextProviders(
  packages: readonly LoadedPlugin[],
  diagnostics: Diagnostics,
  overridden?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ToolTextProvider[]> {
  const out: ToolTextProvider[] = []
  for (const pkg of packages) {
    // F2: a closer root tier owns `text.tools`, so this copy is not used.
    if (overridden?.get(pkg.packageDir)?.has("text.tools") === true) continue
    const pluginId = pkg.manifest.id
    // Go through the package source, so an embedded package loads too.
    const source = pluginPackageFor(pkg.packageDir)
    for (const e of pkg.manifest.toolText ?? []) {
      const fail = () => diagnostics.warn("tool_text.load_failed", "", { pluginId, id: e.id })
      const abs = resolvePath(pkg.packageDir, e.entry)
      const rel = relative(pkg.packageDir, abs)
      if (rel.startsWith("..") || isAbsolute(rel) || !source.hasFile(e.entry)) {
        fail()
        continue
      }
      try {
        const mod = (await source.importModule(e.entry)) as Record<string, unknown>
        const factory = mod[e.export ?? "default"]
        const provider = typeof factory === "function" ? (factory as () => unknown)() : undefined
        if (typeof (provider as { then?: unknown } | undefined)?.then === "function") {
          Promise.resolve(provider).catch(() => {})
        }
        if (!isProvider(provider)) {
          fail()
          continue
        }
        if (!sameNames(e.tools, provider.tools)) {
          // Data only: the two lists, sorted and comma joined.
          diagnostics.warn("tool_text.tools_mismatch", "", {
            pluginId,
            id: e.id,
            manifest: [...e.tools].sort().join(","),
            provider: [...provider.tools].sort().join(","),
          })
        }
        out.push(provider)
      } catch {
        fail()
      }
    }
  }
  return out
}

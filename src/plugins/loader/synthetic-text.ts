/**
 * Loader-side wiring of manifest `syntheticText` into one resolver per
 * loader. Each entry names a module and an export. The export is a
 * synchronous factory that returns a `SyntheticTextProvider`. A failure is a
 * diagnostic with identifier data only (core holds no text). It never stops
 * the boot.
 *
 * @module plugins/loader/synthetic-text
 */

import { isAbsolute, relative } from "node:path"

import type { SyntheticTextProvider } from "../../../plugin-api/src/types/synthetic-text.ts"
import {
  createSyntheticTextResolver,
  type SyntheticTextResolver,
} from "../../agent/synthetic-text.ts"
import type { Diagnostics } from "../../diagnostics/hub.ts"
import type { SidebandApi } from "../../sideband/types.ts"
import { pluginPackageFor } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

import { resolvePath } from "./helpers.ts"

/** The providers of one loader and the single resolver built from them. */
export interface SyntheticTextHolder {
  readonly providers: readonly SyntheticTextProvider[]
  readonly resolver: SyntheticTextResolver
}

/** A resolver with no provider: always "", never a diagnostic. */
export const EMPTY_SYNTHETIC_HOLDER: SyntheticTextHolder = Object.freeze({
  providers: Object.freeze([]) as readonly SyntheticTextProvider[],
  resolver: Object.freeze<SyntheticTextResolver>({
    resolve: (_kind, _facts) => "",
  }),
})

/** Do two name lists hold the same set of names? Order does not matter. */
export function sameNames(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size !== sb.size) return false
  for (const x of sa) if (!sb.has(x)) return false
  return true
}

function isProvider(v: unknown): v is SyntheticTextProvider {
  if (typeof v !== "object" || v === null) return false
  const p = v as { kinds?: unknown; text?: unknown }
  return typeof p.text === "function" && Array.isArray(p.kinds)
}

/**
 * The provider minus the kinds that a closer root tier owns (F2). The same
 * object when nothing is overridden.
 */
function withoutOverridden(
  provider: SyntheticTextProvider,
  lost: ReadonlySet<string> | undefined,
): SyntheticTextProvider {
  if (lost === undefined) return provider
  const kinds = provider.kinds.filter((k) => !lost.has(`synthetic:${k}`))
  if (kinds.length === provider.kinds.length) return provider
  return { kinds, text: (kind, facts, sb) => provider.text(kind, facts, sb) }
}

/**
 * Collect every declared provider of the loaded packages, in package order.
 * Factories must be synchronous. A factory that returns a promise fails.
 * An entry that resolves outside its package dir fails.
 */
export async function collectSyntheticTextProviders(
  packages: readonly LoadedPlugin[],
  diagnostics: Diagnostics,
  overridden?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<SyntheticTextProvider[]> {
  const out: SyntheticTextProvider[] = []
  for (const pkg of packages) {
    const pluginId = pkg.manifest.id
    // Go through the package source, so an embedded package loads too.
    const source = pluginPackageFor(pkg.packageDir)
    for (const e of pkg.manifest.syntheticText ?? []) {
      const fail = () => diagnostics.warn("synthetic_text.load_failed", "", { pluginId, id: e.id })
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
        if (e.kinds !== undefined && !sameNames(e.kinds, provider.kinds)) {
          // Data only: the two lists, sorted and comma joined.
          diagnostics.warn("synthetic.kinds_mismatch", "", {
            pluginId,
            id: e.id,
            manifest: [...e.kinds].sort().join(","),
            provider: [...provider.kinds].sort().join(","),
          })
        }
        out.push(withoutOverridden(provider, overridden?.get(pkg.packageDir)))
      } catch {
        fail()
      }
    }
  }
  return out
}

/** Collect the providers and build ONE resolver over them. */
export async function buildSyntheticText(
  packages: readonly LoadedPlugin[],
  diagnostics: Diagnostics,
  overridden?: ReadonlyMap<string, ReadonlySet<string>>,
  sideband?: () => SidebandApi,
): Promise<SyntheticTextHolder> {
  const providers = await collectSyntheticTextProviders(packages, diagnostics, overridden)
  return { providers, resolver: createSyntheticTextResolver(providers, diagnostics, sideband) }
}

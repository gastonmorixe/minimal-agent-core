/**
 * `errorRenderers` manifest parser, split out of `manifest.ts` to keep that
 * file under the line limit. Shape checks only.
 *
 * @module plugins/manifest-error-renderer
 */

import { isObject } from "./manifest-helpers.ts"
import type { ManifestErrorRenderer } from "./types.ts"

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Parse the optional `errorRenderers` array. A non-array is ignored with a
 * warning. A bad or duplicate entry is skipped with a warning. Never throws.
 */
export function parseErrorRenderers(
  raw: unknown,
  warn: (msg: string) => void,
): ManifestErrorRenderer[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    warn("errorRenderers:not_array")
    return undefined
  }
  const out: ManifestErrorRenderer[] = []
  const seen = new Set<string>()
  for (const [i, e] of (raw as unknown[]).entries()) {
    const at = `errorRenderers[${i}]`
    if (!isObject(e)) {
      warn(`${at}:not_object`)
      continue
    }
    const o = e as Record<string, unknown>
    if (!nonEmpty(o.id)) {
      warn(`${at}:id`)
      continue
    }
    if (!nonEmpty(o.entry)) {
      warn(`${at}:entry`)
      continue
    }
    if (o.export != null && !nonEmpty(o.export)) {
      warn(`${at}:export`)
      continue
    }
    if (seen.has(o.id)) {
      warn(`${at}:duplicate_id`)
      continue
    }
    seen.add(o.id)
    out.push({ id: o.id, entry: o.entry, ...(o.export ? { export: o.export as string } : {}) })
  }
  return out
}

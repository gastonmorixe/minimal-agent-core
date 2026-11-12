/**
 * `errorRenderers` manifest parser, split out of `manifest.ts` to keep that
 * file under the line limit. Shape checks only.
 *
 * @module plugins/manifest-error-renderer
 */

import type { CliWarn } from "./manifest-cli.ts"
import { isObject } from "./manifest-helpers.ts"
import type { ManifestErrorRenderer } from "./types.ts"

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Parse the optional `errorRenderers` array. A non-array is ignored with a
 * warning. A bad or duplicate entry is skipped with a warning. Never throws.
 */
export function parseErrorRenderers(
  raw: unknown,
  warn: CliWarn,
  manifestPath: string,
): ManifestErrorRenderer[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    warn("errorRenderers:not_array", { code: "error_renderers_not_array", manifestPath })
    return undefined
  }
  const out: ManifestErrorRenderer[] = []
  const seen = new Set<string>()
  for (const [i, e] of (raw as unknown[]).entries()) {
    const at = `errorRenderers[${i}]`
    if (!isObject(e)) {
      warn(`${at}:not_object`, { code: "error_renderer_not_object", manifestPath, index: i })
      continue
    }
    const o = e as Record<string, unknown>
    if (!nonEmpty(o.id)) {
      warn(`${at}:id`, { code: "error_renderer_id_invalid", manifestPath, index: i })
      continue
    }
    if (!nonEmpty(o.entry)) {
      warn(`${at}:entry`, { code: "error_renderer_entry_invalid", manifestPath, index: i })
      continue
    }
    if (o.export != null && !nonEmpty(o.export)) {
      warn(`${at}:export`, { code: "error_renderer_export_invalid", manifestPath, index: i })
      continue
    }
    if (seen.has(o.id)) {
      warn(`${at}:duplicate_id`, { code: "error_renderer_duplicate_id", manifestPath, index: i })
      continue
    }
    seen.add(o.id)
    out.push({ id: o.id, entry: o.entry, ...(o.export ? { export: o.export as string } : {}) })
  }
  return out
}

/**
 * `syntheticText` manifest parser, split out of `manifest.ts` to keep that
 * file under the line limit. Shape checks only.
 *
 * @module plugins/manifest-synthetic-text
 */

import type { CliWarn } from "./manifest-cli.ts"
import { isObject } from "./manifest-helpers.ts"
import type { ManifestSyntheticText } from "./types.ts"

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Parse the optional `syntheticText` array. A non-array is ignored with a
 * warning. A bad or duplicate entry is skipped with a warning. Never throws.
 */
export function parseSyntheticText(
  raw: unknown,
  warn: CliWarn,
  manifestPath: string,
): ManifestSyntheticText[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    warn("syntheticText:not_array", { code: "synthetic_text_not_array", manifestPath })
    return undefined
  }
  const out: ManifestSyntheticText[] = []
  const seen = new Set<string>()
  for (const [i, e] of (raw as unknown[]).entries()) {
    const at = `syntheticText[${i}]`
    if (!isObject(e)) {
      warn(`${at}:not_object`, { code: "synthetic_text_not_object", manifestPath, index: i })
      continue
    }
    const o = e as Record<string, unknown>
    if (!nonEmpty(o.id)) {
      warn(`${at}:id`, { code: "synthetic_text_id_invalid", manifestPath, index: i })
      continue
    }
    if (!nonEmpty(o.entry)) {
      warn(`${at}:entry`, { code: "synthetic_text_entry_invalid", manifestPath, index: i })
      continue
    }
    if (o.export != null && !nonEmpty(o.export)) {
      warn(`${at}:export`, { code: "synthetic_text_export_invalid", manifestPath, index: i })
      continue
    }
    if (seen.has(o.id)) {
      warn(`${at}:duplicate_id`, { code: "synthetic_text_duplicate_id", manifestPath, index: i })
      continue
    }
    seen.add(o.id)
    out.push({ id: o.id, entry: o.entry, ...(o.export ? { export: o.export as string } : {}) })
  }
  return out
}

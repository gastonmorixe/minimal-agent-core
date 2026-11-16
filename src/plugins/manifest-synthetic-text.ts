/**
 * `syntheticText` and `toolText` manifest parsers, split out of
 * `manifest.ts` to keep that file under the line limit. Shape checks only.
 *
 * @module plugins/manifest-synthetic-text
 */

import { isSyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"

import type { CliWarn } from "./manifest-cli.ts"
import { isObject } from "./manifest-helpers.ts"
import type { ManifestSyntheticText, ManifestToolText } from "./types.ts"

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0

/** The common fields of one provider entry. */
interface BaseEntry {
  id: string
  entry: string
  export?: string
}

/**
 * Check one string list: a non-empty array of unique strings that pass
 * `ok`. Returns the copy, or undefined when the list is bad.
 */
function parseNameList(v: unknown, ok: (s: unknown) => boolean): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  const items = v as unknown[]
  if (!items.every(ok)) return undefined
  if (new Set(items).size !== items.length) return undefined
  return [...(items as string[])]
}

/**
 * Walk a provider entry array. `extra` checks the key specific fields and
 * returns them, or undefined to skip the entry (it warns itself).
 */
function parseEntries<T extends BaseEntry, X extends object>(
  key: string,
  code: string,
  raw: unknown,
  warn: CliWarn,
  manifestPath: string,
  extra: (o: Record<string, unknown>, at: string, index: number) => X | undefined,
): T[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) {
    warn(`${key}:not_array`, { code: `${code}_not_array`, manifestPath })
    return undefined
  }
  const out: T[] = []
  const seen = new Set<string>()
  for (const [i, e] of (raw as unknown[]).entries()) {
    const at = `${key}[${i}]`
    if (!isObject(e)) {
      warn(`${at}:not_object`, { code: `${code}_not_object`, manifestPath, index: i })
      continue
    }
    const o = e as Record<string, unknown>
    if (!nonEmpty(o.id)) {
      warn(`${at}:id`, { code: `${code}_id_invalid`, manifestPath, index: i })
      continue
    }
    if (!nonEmpty(o.entry)) {
      warn(`${at}:entry`, { code: `${code}_entry_invalid`, manifestPath, index: i })
      continue
    }
    if (o.export != null && !nonEmpty(o.export)) {
      warn(`${at}:export`, { code: `${code}_export_invalid`, manifestPath, index: i })
      continue
    }
    const more = extra(o, at, i)
    if (more === undefined) continue
    if (seen.has(o.id)) {
      warn(`${at}:duplicate_id`, { code: `${code}_duplicate_id`, manifestPath, index: i })
      continue
    }
    seen.add(o.id)
    out.push({
      id: o.id,
      entry: o.entry,
      ...(o.export ? { export: o.export as string } : {}),
      ...more,
    } as unknown as T)
  }
  return out
}

/**
 * Parse the optional `syntheticText` array. A non-array is ignored with a
 * warning. A bad or duplicate entry is skipped with a warning. An optional
 * `kinds` list must hold unique known kinds. Never throws.
 */
export function parseSyntheticText(
  raw: unknown,
  warn: CliWarn,
  manifestPath: string,
): ManifestSyntheticText[] | undefined {
  return parseEntries<ManifestSyntheticText, { kinds?: string[] }>(
    "syntheticText",
    "synthetic_text",
    raw,
    warn,
    manifestPath,
    (o, at, index) => {
      if (o.kinds == null) return {}
      const kinds = parseNameList(o.kinds, isSyntheticKind)
      if (kinds === undefined) {
        warn(`${at}:kinds`, { code: "synthetic_text_kinds_invalid", manifestPath, index })
        return undefined
      }
      return { kinds }
    },
  )
}

/**
 * Parse the optional `toolText` array, the same way as `syntheticText`. The
 * `tools` list is required: unique non-empty tool names. Never throws.
 */
export function parseToolText(
  raw: unknown,
  warn: CliWarn,
  manifestPath: string,
): ManifestToolText[] | undefined {
  return parseEntries<ManifestToolText, { tools: string[] }>(
    "toolText",
    "tool_text",
    raw,
    warn,
    manifestPath,
    (o, at, index) => {
      const tools = parseNameList(o.tools, nonEmpty)
      if (tools === undefined) {
        warn(`${at}:tools`, { code: "tool_text_tools_invalid", manifestPath, index })
        return undefined
      }
      return { tools }
    },
  )
}

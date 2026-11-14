/**
 * `sideband` and `sidebandCodec` manifest parsers, split out of `manifest.ts`
 * to keep that file under the line limit. Shape checks only.
 *
 * @module plugins/manifest-sideband
 */

import type { CliWarn } from "./manifest-cli.ts"
import { isObject } from "./manifest-helpers.ts"
import type { ManifestSidebandCodec, ManifestSidebandKind } from "./types.ts"

const SIDEBAND_DIRECTIONS: readonly string[] = ["to-model", "from-model"]
const SIDEBAND_PLACEMENTS: readonly string[] = ["system", "turn", "tool-result", "inline"]
const SIDEBAND_BODIES: readonly string[] = ["none", "text", "raw"]
const SIDEBAND_TRUSTS: readonly string[] = ["harness", "untrusted"]

const SIDEBAND_ATTR_TYPES: readonly string[] = ["string", "int", "bool", "enum"]

/** Name the first bad field of one sideband entry, or undefined when it is valid. */
export function sidebandEntryFault(e: Record<string, unknown>): string | undefined {
  const oneOf = (key: string, allowed: readonly string[]) =>
    typeof e[key] === "string" && allowed.includes(e[key] as string)
  if (typeof e.kind !== "string" || e.kind.length === 0) return "kind"
  if (!oneOf("direction", SIDEBAND_DIRECTIONS)) return "direction"
  if (!oneOf("placement", SIDEBAND_PLACEMENTS)) return "placement"
  if (!oneOf("body", SIDEBAND_BODIES)) return "body"
  if (!oneOf("trust", SIDEBAND_TRUSTS)) return "trust"
  if (e.layout != null && !oneOf("layout", ["inline", "block"])) return "layout"
  if (!isObject(e.attrs)) return "attrs"
  for (const decl of Object.values(e.attrs)) {
    if (!isObject(decl) || !SIDEBAND_ATTR_TYPES.includes(decl.type as string)) return "attrs.type"
  }
  if (typeof e.summary !== "string") return "summary"
  if (
    e.legacy != null &&
    !(Array.isArray(e.legacy) && e.legacy.every((s) => typeof s === "string"))
  )
    return "legacy"
  if (e.legacyBodyEscaped != null && typeof e.legacyBodyEscaped !== "boolean")
    return "legacyBodyEscaped"
  if (e.example != null && !isObject(e.example)) return "example"
  return undefined
}

/**
 * Parse the optional `sideband` array. Shape only. The registry checks
 * the rules. A manifest `owner` is dropped (SB-REG-2). A bad entry is
 * skipped and reported as `sideband[i]:field` through `warn`. Only a
 * non-array top level throws.
 */
export function parseSidebandKinds(
  raw: unknown,
  err: (msg: string) => void,
  warn: CliWarn,
  manifestPath: string,
): ManifestSidebandKind[] | undefined {
  if (raw == null) return undefined
  if (!Array.isArray(raw)) err("sideband must be an array if present")
  const out: ManifestSidebandKind[] = []
  for (const [i, entry] of (raw as unknown[]).entries()) {
    const at = `sideband[${i}]`
    if (!isObject(entry)) {
      warn(`${at}:entry`, { code: "sideband_entry_not_object", manifestPath, index: i })
      continue
    }
    const e = entry as Record<string, unknown>
    const fault = sidebandEntryFault(e)
    if (fault) {
      warn(`${at}:${fault}`, {
        code: "sideband_entry_invalid",
        manifestPath,
        index: i,
        field: fault,
      })
      continue
    }
    if ("owner" in e) {
      warn(`${at}.owner is ignored`, { code: "sideband_owner_ignored", manifestPath, index: i })
    }
    const { owner: _owner, ...rest } = e
    out.push(rest as unknown as ManifestSidebandKind)
  }
  return out
}

/** Parse the optional `sidebandCodec` entry. */
export function parseSidebandCodec(
  raw: unknown,
  err: (msg: string) => void,
): ManifestSidebandCodec | undefined {
  if (raw == null) return undefined
  if (!isObject(raw)) err("sidebandCodec must be an object if present")
  const c = raw as Record<string, unknown>
  for (const key of ["id", "entry"]) {
    if (typeof c[key] !== "string" || (c[key] as string).length === 0) {
      err(`sidebandCodec.${key} must be a non-empty string`)
    }
  }
  return { id: c.id as string, entry: c.entry as string }
}

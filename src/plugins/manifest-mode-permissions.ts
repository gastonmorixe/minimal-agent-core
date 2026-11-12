/**
 * Mode `permissions` parser, split out of `manifest.ts` to keep that file
 * under the line limit. Shape checks only.
 *
 * @module plugins/manifest-mode-permissions
 */

import { isObject, ManifestError } from "./manifest-helpers.ts"
import type { ManifestMode } from "./types.ts"

/**
 * A mode `permissions` value has a bad shape. Carries no message text (R-API-13.5).
 *
 * The two shapes ModeManager reads are valid: a `ToolPermission[]` array
 * and the old `{ allow?: string[], deny?: string[] }` object.
 */
export class ModePermissionsInvalidError extends ManifestError {
  static readonly kind = "ModePermissionsInvalidError"
  declare readonly kind: "ModePermissionsInvalidError"
  /** Index of the mode in `modes`. */
  readonly modeIndex: number
  /** Old-shape key that holds the bad value, else `null`. */
  readonly key: "allow" | "deny" | null
  /** Index of the bad entry, or `null` when the whole value is bad. */
  readonly entryIndex: number | null
  constructor(
    manifestPath: string,
    modeIndex: number,
    key: "allow" | "deny" | null,
    entryIndex: number | null,
  ) {
    super("", manifestPath)
    this.name = new.target.kind
    Object.defineProperty(this, "kind", { value: new.target.kind, enumerable: true })
    this.modeIndex = modeIndex
    this.key = key
    this.entryIndex = entryIndex
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0

/**
 * Validate a mode `permissions` value. Accepts the 2 shapes ModeManager
 * reads (`toolPermissionsFromMode` in `modes/modes.ts`): a `ToolPermission[]`
 * array, or the old `{ allow?: string[], deny?: string[] }` object.
 *
 * @throws {@link ModePermissionsInvalidError} on any other shape.
 */
export function parseModePermissions(
  raw: unknown,
  modeIndex: number,
  manifestPath: string,
): ManifestMode["permissions"] {
  if (raw == null) return undefined
  const bad = (key: "allow" | "deny" | null, entryIndex: number | null): never => {
    throw new ModePermissionsInvalidError(manifestPath, modeIndex, key, entryIndex)
  }
  if (Array.isArray(raw)) {
    for (const [i, entry] of raw.entries()) {
      if (!isObject(entry)) bad(null, i)
      const rule = entry as Record<string, unknown>
      if (!isNonEmptyString(rule.tool)) bad(null, i)
      if (typeof rule.allow !== "boolean" && rule.allow !== "match") bad(null, i)
      if (rule.refusalHint != null && typeof rule.refusalHint !== "string") bad(null, i)
    }
    return raw as ManifestMode["permissions"]
  }
  if (!isObject(raw)) return bad(null, null)
  const obj = raw as Record<string, unknown>
  for (const key of ["allow", "deny"] as const) {
    const list = obj[key]
    if (list == null) continue
    if (!Array.isArray(list)) bad(key, null)
    for (const [i, t] of (list as unknown[]).entries()) {
      if (!isNonEmptyString(t)) bad(key, i)
    }
  }
  // The plugin-api type names only the array form. ModeManager also reads
  // the old object form (validated above), so it passes through unchanged.
  return raw as unknown as ManifestMode["permissions"]
}

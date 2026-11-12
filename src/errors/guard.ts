/**
 * Pure guard for `CoreErrorJson`. Never rebuilds a class instance.
 *
 * @module errors/guard
 */

import type { CoreErrorJson } from "./types.ts"

/** True when `v` has the `CoreErrorJson` shape: a string `kind` and an object `fields`. */
export function isCoreErrorJson(v: unknown): v is CoreErrorJson {
  if (typeof v !== "object" || v === null) return false
  const { kind, fields } = v as { kind?: unknown; fields?: unknown }
  return (
    typeof kind === "string" &&
    typeof fields === "object" &&
    fields !== null &&
    !Array.isArray(fields)
  )
}

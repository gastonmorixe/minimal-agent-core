/**
 * Resolve Glob tool arguments, including Cursor-shaped aliases.
 *
 * Canonical names are `pattern` and `path`. Models trained on Cursor's Glob
 * schema send `glob_pattern` and `target_directory` instead. Execute-time
 * schema is not checked, so a missing `pattern` used to reach `new Bun.Glob(undefined)`
 * and throw `Glob.constructor: first argument is not a string`.
 *
 * This module is the one seam for "which string did the model mean?". The
 * executor and the transcript header both read through it so an alias call
 * runs and renders the same way as the canonical form.
 *
 * @module tools/glob-input
 */

import { globArgNotStringResult, globMissingPatternResult } from "./PROMPTS.ts"

/** Canonical glob string, then the Cursor alias. First non-empty string wins. */
export const GLOB_PATTERN_KEYS = ["pattern", "glob_pattern"] as const

/** Canonical search directory, then the Cursor alias. First non-empty string wins. */
export const GLOB_PATH_KEYS = ["path", "target_directory"] as const

/**
 * Outcome of reading an aliased string field from a tool-input object.
 *
 * - `ok`: first non-empty string among the keys, in key order
 * - `missing`: none of the keys had a usable string (absent, null, or empty)
 * - `invalid`: a key was present with a non-string (and non-null) value
 */
export type AliasedString =
  | { status: "ok"; key: string; value: string }
  | { status: "missing" }
  | { status: "invalid"; key: string; got: string }

/**
 * JSON-ish type name for error copy. Distinguishes `null` and `array` from
 * the `typeof` bucket those would otherwise collapse into (`object`).
 *
 * @param value - The value whose type to name.
 * @returns A lowercase type label (`string`, `number`, `array`, `null`, ...).
 */
export function jsonTypeName(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

/**
 * Pick the first non-empty string among `keys` on `input`.
 *
 * Null and empty string are treated as absent so a blank canonical field can
 * still fall through to its alias. A non-string at a listed key is `invalid`
 * immediately (canonical-first), not skipped.
 *
 * @param input - Raw tool input object.
 * @param keys - Field names in precedence order (canonical first).
 * @returns Discriminated result: ok / missing / invalid.
 */
export function aliasedNonEmptyString(
  input: Record<string, unknown>,
  keys: readonly string[],
): AliasedString {
  for (const key of keys) {
    if (!Object.hasOwn(input, key)) continue
    const value = input[key]
    if (value == null) continue
    if (typeof value !== "string") {
      return { status: "invalid", key, got: jsonTypeName(value) }
    }
    if (value.length === 0) continue
    return { status: "ok", key, value }
  }
  return { status: "missing" }
}

/**
 * Resolve the glob pattern from `pattern` or alias `glob_pattern`.
 *
 * @param input - Raw Glob tool input.
 * @returns Aliased-string result for the pattern keys.
 */
export function globPatternFromInput(input: Record<string, unknown>): AliasedString {
  return aliasedNonEmptyString(input, GLOB_PATTERN_KEYS)
}

/**
 * Resolve the search directory from `path` or alias `target_directory`.
 *
 * Missing is a valid outcome: the executor defaults to the sticky Bash cwd.
 *
 * @param input - Raw Glob tool input.
 * @returns Aliased-string result for the path keys.
 */
export function globPathFromInput(input: Record<string, unknown>): AliasedString {
  return aliasedNonEmptyString(input, GLOB_PATH_KEYS)
}

/**
 * Pattern + search directory ready for `Bun.Glob`, or a model-facing error.
 *
 * @param input - Raw Glob tool input.
 * @param defaultPath - Sticky Bash cwd used when neither path alias is set.
 * @returns Ok with `pattern`/`searchPath`, or an error string from PROMPTS.ts.
 */
export function resolveGlobExecArgs(
  input: Record<string, unknown>,
  defaultPath: string,
): { ok: true; pattern: string; searchPath: string } | { ok: false; error: string } {
  const patternArg = globPatternFromInput(input)
  if (patternArg.status === "invalid") {
    return { ok: false, error: globArgNotStringResult(patternArg.key, patternArg.got) }
  }
  if (patternArg.status === "missing") {
    return { ok: false, error: globMissingPatternResult() }
  }
  const pathArg = globPathFromInput(input)
  if (pathArg.status === "invalid") {
    return { ok: false, error: globArgNotStringResult(pathArg.key, pathArg.got) }
  }
  return {
    ok: true,
    pattern: patternArg.value,
    searchPath: pathArg.status === "ok" ? pathArg.value : defaultPath,
  }
}

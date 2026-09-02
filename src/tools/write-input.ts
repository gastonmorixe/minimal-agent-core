/**
 * Resolve Write tool arguments, including Cursor-shaped aliases.
 *
 * Canonical names are `file_path` and `content`. Models trained on Cursor's
 * Write schema often send `contents` (plural) instead of `content`. Execute-time
 * schema is not checked, so a missing `content` used to reach
 * `Bun.write(path, undefined)` and throw
 * `Bun.write(pathOrFdOrBlob, blob) expects a Blob-y thing to write`.
 *
 * This module is the one seam for "which string did the model mean?". Empty
 * `content` is valid (write an empty file). Unlike Glob's pattern resolver,
 * blank strings do not fall through to the alias: the first present string
 * among the keys wins, empty included.
 *
 * @module tools/write-input
 */

import { type AliasedString, jsonTypeName } from "./glob-input.ts"
import {
  writeArgNotStringResult,
  writeMissingContentResult,
  writeMissingPathResult,
} from "./PROMPTS.ts"

/** Canonical body field, then the Cursor alias. First present string wins. */
export const WRITE_CONTENT_KEYS = ["content", "contents"] as const

/** Canonical path field. Kept as a list so future aliases share one resolver. */
export const WRITE_PATH_KEYS = ["file_path"] as const

/**
 * Pick the first present string among `keys` on `input`, including empty.
 *
 * Null is treated as absent. A non-string at a listed key is `invalid`
 * immediately (canonical-first), not skipped. Empty string is `ok` so Write
 * can create empty files.
 *
 * @param input - Raw tool input object.
 * @param keys - Field names in precedence order (canonical first).
 * @returns Discriminated result: ok / missing / invalid.
 */
export function aliasedStringAllowEmpty(
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
    return { status: "ok", key, value }
  }
  return { status: "missing" }
}

/**
 * Resolve the file body from `content` or alias `contents`.
 *
 * @param input - Raw Write tool input.
 * @returns Aliased-string result for the content keys.
 */
export function writeContentFromInput(input: Record<string, unknown>): AliasedString {
  return aliasedStringAllowEmpty(input, WRITE_CONTENT_KEYS)
}

/**
 * Resolve the destination path from `file_path`.
 *
 * @param input - Raw Write tool input.
 * @returns Aliased-string result for the path keys.
 */
export function writePathFromInput(input: Record<string, unknown>): AliasedString {
  return aliasedStringAllowEmpty(input, WRITE_PATH_KEYS)
}

/**
 * Path + body ready for `Bun.write`, or a model-facing error.
 *
 * @param input - Raw Write tool input.
 * @returns Ok with `filePath`/`content`, or an error string from PROMPTS.ts.
 */
export function resolveWriteExecArgs(
  input: Record<string, unknown>,
): { ok: true; filePath: string; content: string } | { ok: false; error: string } {
  const pathArg = writePathFromInput(input)
  if (pathArg.status === "invalid") {
    return { ok: false, error: writeArgNotStringResult(pathArg.key, pathArg.got) }
  }
  if (pathArg.status === "missing") {
    return { ok: false, error: writeMissingPathResult() }
  }

  const contentArg = writeContentFromInput(input)
  if (contentArg.status === "invalid") {
    return { ok: false, error: writeArgNotStringResult(contentArg.key, contentArg.got) }
  }
  if (contentArg.status === "missing") {
    return { ok: false, error: writeMissingContentResult() }
  }

  return {
    ok: true,
    filePath: pathArg.value,
    content: contentArg.value,
  }
}

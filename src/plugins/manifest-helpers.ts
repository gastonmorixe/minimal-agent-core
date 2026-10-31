/**
 * Shared manifest-validation primitives: the error type and the two
 * generic field checks every per-field parser in `manifest.ts` (and its
 * split-out siblings, like `manifest-host-mode.ts`) builds on. Split out
 * so those siblings don't import `manifest.ts` itself (which would create
 * a cycle: `manifest.ts` imports the per-field parser back).
 *
 * @module plugins/manifest-helpers
 */

import type { ManifestHandlerEntry } from "./types.ts"

/**
 * Thrown by `parseManifest` (and the per-field parsers it calls) when the
 * input does not conform.
 *
 * The `manifestPath` field is the absolute path the loader was trying to
 * parse, so error logs can point the user at the right file.
 */
export class ManifestError extends Error {
  readonly manifestPath: string
  constructor(message: string, manifestPath: string) {
    super(message)
    this.name = "ManifestError"
    this.manifestPath = manifestPath
  }
}

/** True for a plain JSON object (not `null`, not an array). */
export function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x)
}

/** Read a required non-empty string field, calling `err` (which throws) when it is missing or blank. */
export function requireString(
  obj: Record<string, unknown>,
  key: string,
  err: (msg: string) => void,
): string {
  if (typeof obj[key] !== "string" || !obj[key]) {
    err(`${key} is required and must be a non-empty string`)
  }
  return obj[key] as string
}

/** Validate a `{type: "module", path, export?}` or `{type: "subprocess", command}` handler entry. */
export function parseHandlerEntry(
  raw: unknown,
  at: string,
  manifestPath: string,
): ManifestHandlerEntry {
  const err = (msg: string) => {
    throw new ManifestError(`${at}.handler: ${msg}`, manifestPath)
  }

  if (!isObject(raw)) err("handler must be an object")
  const obj = raw as Record<string, unknown>

  if (obj.type === "module") {
    if (typeof obj.path !== "string" || !obj.path) err("path is required for module handler")
    if (obj.export != null && obj.export !== "default") {
      err(`only export="default" is supported (got: ${JSON.stringify(obj.export)})`)
    }
    return { type: "module", path: obj.path as string, export: "default" }
  }

  if (obj.type === "subprocess") {
    if (!Array.isArray(obj.command) || obj.command.length === 0) {
      err("command must be a non-empty array for subprocess handler")
    }
    for (const c of obj.command as unknown[]) {
      if (typeof c !== "string") err("command entries must be strings")
    }
    return { type: "subprocess", command: obj.command as string[] }
  }

  err(`unknown handler.type: ${JSON.stringify(obj.type)}`)
  throw new Error("unreachable")
}

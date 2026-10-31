/**
 * `hostModes[]` manifest validation, split out of `manifest.ts` to keep
 * that file under the architecture's line ratchet. Same shape and rules as
 * `commands[]`'s validator there: module handlers only, id uniqueness
 * within one package (cross-plugin collisions are first-wins at load
 * time, settled by the loader).
 *
 * @module plugins/manifest-host-mode
 */

import { isObject, ManifestError, parseHandlerEntry, requireString } from "./manifest-helpers.ts"
import type { ManifestHostMode } from "./types.ts"

const ID_RE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Validate a single `hostModes[i]` entry. `id` is matched against
 * `--host-mode <id>` later by the loader, so it is uniqueness-checked here
 * the same way `commands[].name` is. Handlers must be `module` type: the
 * handler owns raw stdio bytes, so a subprocess round-trip would defeat
 * the point.
 */
export function parseHostMode(
  raw: unknown,
  index: number,
  manifestPath: string,
  seenIds: Set<string>,
): ManifestHostMode {
  const at = `hostModes[${index}]`
  const err = (msg: string) => {
    throw new ManifestError(`${at}: ${msg}`, manifestPath)
  }
  if (!isObject(raw)) err("host mode must be an object")
  const obj = raw as Record<string, unknown>

  const id = requireString(obj, "id", err)
  if (!ID_RE.test(id)) err(`host mode id must match ${ID_RE} (got: ${JSON.stringify(id)})`)
  if (seenIds.has(id)) err(`duplicate host mode id: ${id}`)
  seenIds.add(id)

  const description = requireString(obj, "description", err)

  const entry = parseHandlerEntry(obj.entry, at, manifestPath)
  if (entry.type !== "module") {
    err('host mode entry must be type "module" (a subprocess cannot own stdio for this plugin)')
  }

  let permissions: string[] | undefined
  if (obj.permissions != null) {
    if (!Array.isArray(obj.permissions)) err("hostModes[].permissions must be an array if present")
    for (const p of obj.permissions as unknown[]) {
      if (typeof p !== "string" || p.length === 0) {
        err(`hostModes[].permissions entries must be non-empty strings (got: ${JSON.stringify(p)})`)
      }
    }
    permissions = obj.permissions as string[]
  }

  return permissions != null ? { id, description, entry, permissions } : { id, description, entry }
}

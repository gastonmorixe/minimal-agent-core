/**
 * `scripts` manifest parser, split out of `manifest.ts` to keep that file
 * under the line limit.
 *
 * `scripts` maps a script name to an entry path inside the package:
 * `{ "runner": "./bin/runner.ts" }`. The self-spawn id of a script is
 * `<manifest id>/<name>` (`plugin-api/utils/self-spawn`), and a compiled
 * build embeds every declared script for `<binary> __run <id>`.
 *
 * @module plugins/manifest-scripts
 */

import { isValidScriptId } from "@minimal-agent/core/plugin-api/utils/self-spawn"

import { isObject } from "./manifest-helpers.ts"
import { normalizePackagePath } from "./source.ts"

/**
 * Validate an optional `scripts` map. Returns a copy, or `undefined` when
 * the field is absent or empty. Calls `err` (which throws) when the field
 * is not an object, a name does not form a valid script id with the
 * manifest id, or a path is not a relative path inside the package.
 */
export function parseScripts(
  raw: unknown,
  manifestId: string,
  err: (msg: string) => void,
): Record<string, string> | undefined {
  if (raw == null) return undefined
  if (!isObject(raw)) err("scripts must be an object if present")
  const out: Record<string, string> = {}
  for (const [name, rel] of Object.entries(raw as Record<string, unknown>)) {
    if (!isValidScriptId(`${manifestId}/${name}`)) {
      err(`scripts: name ${JSON.stringify(name)} must match /^[a-z0-9][a-z0-9_-]*$/`)
    }
    if (typeof rel !== "string" || normalizePackagePath(rel) === null) {
      err(
        `scripts.${name} must be a relative path inside the package (got: ${JSON.stringify(rel)})`,
      )
    }
    out[name] = rel as string
  }
  return Object.keys(out).length > 0 ? out : undefined
}

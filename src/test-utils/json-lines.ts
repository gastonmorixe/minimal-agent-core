/**
 * Read a JSON-lines file in a test.
 *
 * @module test-utils/json-lines
 */

import { existsSync, readFileSync } from "node:fs"

/** The JSON lines of one file; `[]` when it is missing. */
export function jsonLines(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

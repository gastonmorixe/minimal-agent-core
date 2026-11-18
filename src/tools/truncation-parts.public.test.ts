/**
 * Guard: `truncation-parts.ts` is core-only. The frozen public surface
 * (`src/architecture/public-exports.json`) must not name its module path,
 * and must not name any of its symbols that `truncation.ts` did not
 * already export at a38c86b.
 *
 * The JSON shape today is `{ exports: string[] }` (package subpaths only,
 * no symbol names). The walk below collects every string value and every
 * object key at any depth, so the guard stays valid if the shape grows
 * (for example a per-subpath symbol list).
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import * as truncationParts from "./truncation-parts.ts"

/** The runtime export list of `truncation.ts` at a38c86b. */
const LEGACY_TRUNCATION_EXPORTS = new Set([
  "MAX_TOOL_OUTPUT_BYTES",
  "MAX_TOOL_OUTPUT_LINES",
  "MAX_TOOL_OUTPUT_LINE_CHARS",
  "MAX_TOOL_RAW_BYTES",
  "clampToolOutputLines",
  "clampToolRaw",
  "countLines",
  "shouldRedact",
  "truncateToolOutput",
])

const PUBLIC_EXPORTS_PATH = join(import.meta.dirname, "..", "architecture", "public-exports.json")
const PARTS_SOURCE_PATH = join(import.meta.dirname, "truncation-parts.ts")

const publicExports: unknown = JSON.parse(readFileSync(PUBLIC_EXPORTS_PATH, "utf8"))

/** Every string value and object key in the JSON, at any depth. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out)
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      collectStrings(item, out)
    }
  }
  return out
}

/** Type-only exports are erased at runtime: read them from the source text. */
function exportedTypeNames(source: string): string[] {
  const names: string[] = []
  for (const match of source.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1]
    if (name !== undefined) names.push(name)
  }
  return names
}

const runtimeNames = Object.keys(truncationParts)
const typeNames = exportedTypeNames(readFileSync(PARTS_SOURCE_PATH, "utf8"))
const coreOnlyNames = [...new Set([...runtimeNames, ...typeNames])].filter(
  (name) => !LEGACY_TRUNCATION_EXPORTS.has(name),
)
const jsonStrings = collectStrings(publicExports)

describe("truncation-parts stays out of the public surface", () => {
  it("reads a non-empty public-exports.json and a non-empty core-only list", () => {
    expect(jsonStrings.length).toBeGreaterThan(0)
    expect(runtimeNames).toContain("truncateToolOutputParts")
    expect(typeNames).toContain("TruncationFacts")
    expect(coreOnlyNames).toContain("truncateToolOutputParts")
    expect(coreOnlyNames).toContain("TRUNCATION_NOTICE_JOIN")
  })

  it("lists no truncation-parts module path", () => {
    const hits = jsonStrings.filter((s) => s.includes("truncation-parts"))
    expect(hits).toEqual([])
  })

  it("lists no core-only truncation-parts symbol name", () => {
    const listed = new Set(jsonStrings)
    const leaked = coreOnlyNames.filter((name) => listed.has(name))
    expect(leaked).toEqual([])
  })
})

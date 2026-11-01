/**
 * Pure scanning helpers for the forbidden-public-name rule in
 * `public-api.test.ts`.
 *
 * THE RULE (spec 2.7): core never exports `TransportFn`, `SendOptions`, or
 * `StreamedResponse` by name. These are the legacy transport contracts.
 * They stay internal to core. A host that needs the transport shape derives
 * it from `SessionOptions["sendFn"]`.
 *
 * `collectExportedNames` reads one entry file and returns every name it
 * exports, value or type. It follows `export * from` chains through relative
 * specifiers and `@minimal-agent/core/...` self-references. It reads named
 * re-exports (`export { a as b } from`), so an alias counts by its public
 * name. This is a line-start regex scan over comment-free source. It is not
 * a parser.
 *
 * @module architecture/public-name-scan
 */

import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

import { stripComments } from "./provider-scan.ts"

/** The names no public subpath may export (spec 2.7). */
export const FORBIDDEN_PUBLIC_NAMES: readonly string[] = [
  "TransportFn",
  "SendOptions",
  "StreamedResponse",
]

const CORE_PACKAGE_NAME = "@minimal-agent/core"

/** `export [declare] [default] [async] [abstract] <kind> Name`. */
const DECLARATION_RE =
  /^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm

/** `export [type] { a, type b, c as d } [from "x"]`. */
const NAMED_RE = /^\s*export\s+(?:type\s+)?\{([^}]*)\}/gm

/** `export [type] * as ns from "x"`. */
const NAMESPACE_RE = /^\s*export\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm

/** `export [type] * from "x"`. */
const STAR_RE = /^\s*export\s+(?:type\s+)?\*\s+from\s*["']([^"']+)["']/gm

/**
 * Resolve a re-export specifier to a file path. Returns null for a
 * specifier that leaves the package (`node:*`, `bun:*`, npm packages).
 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  if (specifier.startsWith(".")) return join(dirname(fromFile), specifier)
  if (specifier === CORE_PACKAGE_NAME || specifier.startsWith(`${CORE_PACKAGE_NAME}/`)) {
    return Bun.resolveSync(specifier, dirname(fromFile))
  }
  return null
}

/** The public names in one `{ ... }` export list. */
function namesInList(list: string): string[] {
  const out: string[] = []
  for (const raw of list.split(",")) {
    const spec = raw.trim().replace(/^type\s+/, "")
    if (spec === "") continue
    const parts = spec.split(/\s+as\s+/)
    const name = (parts[1] ?? parts[0] ?? "").trim()
    if (name !== "") out.push(name)
  }
  return out
}

/**
 * Every name the module at `file` exports, with `export *` chains followed.
 * `seen` stops a cycle.
 */
export function collectExportedNames(file: string, seen: Set<string> = new Set()): Set<string> {
  const names = new Set<string>()
  if (seen.has(file)) return names
  seen.add(file)
  const source = stripComments(readFileSync(file, "utf8"))
  for (const m of source.matchAll(DECLARATION_RE)) if (m[1]) names.add(m[1])
  for (const m of source.matchAll(NAMED_RE)) for (const n of namesInList(m[1] ?? "")) names.add(n)
  for (const m of source.matchAll(NAMESPACE_RE)) if (m[1]) names.add(m[1])
  for (const m of source.matchAll(STAR_RE)) {
    const target = resolveSpecifier(m[1] ?? "", file)
    if (target === null) continue
    for (const n of collectExportedNames(target, seen)) names.add(n)
  }
  return names
}

/** The forbidden names that `file` exports, sorted. */
export function forbiddenNamesIn(file: string): string[] {
  const names = collectExportedNames(file)
  return FORBIDDEN_PUBLIC_NAMES.filter((n) => names.has(n)).sort()
}

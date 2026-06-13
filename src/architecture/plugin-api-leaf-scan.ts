/**
 * Pure scanning helpers for the plugin-api LEAF architecture test
 * (`src/architecture.plugin-api-leaf.test.ts`).
 *
 * THE RULE: `@minimal-agent/plugin-api` is the shared contract LEAF. It is
 * the one artifact both the host (`src/`) and the plugins tree are allowed
 * to depend on, which only works if it depends on NEITHER of them. No file
 * under `plugin-api/` may import — static, `export ... from`, type-only, or
 * dynamic with a LITERAL specifier — anything that RESOLVES into the host
 * `src/` tree or the top-level `plugins/` tree. A relative reach-in like
 * `../../../src/agent.ts` (from `plugin-api/src/utils/x.ts`) is the exact
 * failure this guards against: it would make the package un-installable
 * from a plugin's own repo and create a dependency cycle.
 *
 * Bare specifiers (`node:*`, `bun:*`, npm packages, even a self-import of
 * `@minimal-agent/plugin-api/...`) never reach the host and are not
 * flagged — only RELATIVE specifiers that normalize into `src/` or
 * `plugins/` count.
 *
 * Resolution is path-aware and mirrors `core-plugin-import-scan.ts`: a
 * specifier is resolved against the importing file's directory (expressed
 * repo-root-relative, e.g. `plugin-api/src/utils`) and then tested against
 * the host trees. Split from the test so tooling can reuse the exact same
 * logic. The package is expected to stay at ZERO sites forever (it has no
 * baseline — a leaf never regresses).
 *
 * @module architecture/plugin-api-leaf-scan
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, posix, relative } from "node:path"

import { stripComments } from "./provider-scan.ts"

/** Repo-root-relative trees the leaf package must never reach into. */
export const DEFAULT_HOST_TREES: readonly string[] = ["src", "plugins"]

/** One host-tree import site inside a `plugin-api/` source file. */
export interface LeafImportSite {
  /** Path relative to the package root, e.g. `src/utils/term-width.ts`. */
  readonly file: string
  /** The literal import specifier, e.g. `../../../src/agent.ts`. */
  readonly specifier: string
  /** The specifier resolved against the file's dir, repo-root-relative. */
  readonly resolved: string
  /** True for `import type`/`export type` forms (still a violation). */
  readonly typeOnly: boolean
}

/**
 * Matches the import forms that carry a LITERAL specifier, across lines.
 * Same shape as `core-plugin-import-scan.ts`'s matcher: static
 * `import`/`export … from`, dynamic `import("…")`, side-effect
 * `import "…"`, CommonJS `require("…")`, and a no-substitution backtick
 * `import(`…`)`. Computed dynamic imports never match (no static literal
 * inside the parens), which keeps any future loader-style seam legal.
 * Group 1/3 capture the `type` keyword (static forms); the remaining
 * groups capture the specifier.
 */
const IMPORT_RE = new RegExp(
  [
    String.raw`\bimport\s+(type\s+)?[^"'=;]*?from\s*["']([^"']+)["']`,
    String.raw`\bexport\s+(type\s+)?[^"'=;]*?from\s*["']([^"']+)["']`,
    String.raw`\bimport\s*\(\s*["']([^"']+)["']\s*[),]`,
    String.raw`\bimport\s+["']([^"']+)["']`,
    String.raw`\brequire\s*\(\s*["']([^"']+)["']\s*\)`,
    "\\bimport\\s*\\(\\s*`([^`$]+)`\\s*[),]",
  ].join("|"),
  "g",
)

/** Recursively collect `.ts` files under a root, as root-relative paths. */
export function packageTsFilesUnder(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (name.endsWith(".ts")) out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Resolve a relative import specifier against the importing file's
 * directory, returning a path RELATIVE TO THE REPO ROOT. `pkgRootRel` is
 * the package's repo-root-relative location (e.g. `plugin-api`); `fileRel`
 * is the file's path within the package (e.g. `src/utils/term-width.ts`).
 */
export function resolveFromPackage(pkgRootRel: string, fileRel: string, specifier: string): string {
  const fromDir = posix.join(pkgRootRel, posix.dirname(fileRel))
  return posix.normalize(posix.join(fromDir, specifier))
}

/**
 * The leaf violation predicate: true iff a relative specifier, resolved
 * against `pkgRootRel/<fileRel>`'s directory, lands inside one of
 * `hostTrees` (repo-root-relative, default `["src", "plugins"]`).
 * Bare/`node:`/`bun:` specifiers never violate.
 */
export function reachesHostTree(
  pkgRootRel: string,
  fileRel: string,
  specifier: string,
  hostTrees: readonly string[] = DEFAULT_HOST_TREES,
): boolean {
  if (!specifier.startsWith(".")) return false
  const resolved = resolveFromPackage(pkgRootRel, fileRel, specifier)
  return hostTrees.some((root) => {
    const normalized = posix.normalize(root)
    return resolved === normalized || resolved.startsWith(`${normalized}/`)
  })
}

/**
 * Scan one package file's source text for import sites that resolve into a
 * host tree. Comments are stripped first; the regex then runs over the
 * WHOLE text so multi-line import clauses are matched.
 */
export function scanSourceForHostImports(
  source: string,
  pkgRootRel: string,
  fileRel: string,
  hostTrees: readonly string[] = DEFAULT_HOST_TREES,
): LeafImportSite[] {
  const code = stripComments(source)
  const out: LeafImportSite[] = []
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null = IMPORT_RE.exec(code)
  while (m !== null) {
    const specifier = m[2] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8]
    if (specifier !== undefined && reachesHostTree(pkgRootRel, fileRel, specifier, hostTrees)) {
      out.push({
        file: fileRel,
        specifier,
        resolved: resolveFromPackage(pkgRootRel, fileRel, specifier),
        typeOnly: m[1] !== undefined || m[3] !== undefined,
      })
    }
    m = IMPORT_RE.exec(code)
  }
  return out
}

/**
 * Walk every `.ts` file under the package (`pkgFsRoot` on disk, located at
 * `pkgRootRel` relative to the repo root) and return all import sites that
 * resolve into a host tree, sorted by file then specifier.
 */
export function scanPackageHostImports(
  pkgFsRoot: string,
  pkgRootRel: string,
  hostTrees: readonly string[] = DEFAULT_HOST_TREES,
): LeafImportSite[] {
  const sites: LeafImportSite[] = []
  for (const rel of packageTsFilesUnder(pkgFsRoot)) {
    const posixRel = rel.split("\\").join("/")
    const text = readFileSync(join(pkgFsRoot, rel), "utf8")
    sites.push(...scanSourceForHostImports(text, pkgRootRel, posixRel, hostTrees))
  }
  return sites.sort((a, b) =>
    a.file === b.file ? a.specifier.localeCompare(b.specifier) : a.file.localeCompare(b.file),
  )
}

/**
 * Pure scanning helpers for the core→host import architecture test
 * (`src/architecture/core-host-import-scan.test.ts`).
 *
 * THE RULE: core never imports the terminal host. The host (entry point,
 * REPL, TUI, input, terminal probes, CLI e2e tests) moved to
 * minimal-agent-cli in S34, and core deleted its copy. No file under `src/`
 * may import (static, `export ... from`, type-only, or dynamic with a
 * LITERAL specifier) anything that RESOLVES into one of the deleted host
 * folders ({@link DEFAULT_HOST_ROOTS}). There is no exception and no
 * baseline: the count is 0.
 *
 * This mirrors `core-plugin-import-scan.ts` (the core→plugin ratchet, I2).
 * Resolution is path-aware: `../host/x` from `src/ui/foo.ts` lands in the
 * top-level `src/host/` tree. The scanner counts SITES per file.
 *
 * @module architecture/core-host-import-scan
 */

import { readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { stripComments, tsFilesUnder } from "./provider-scan.ts"

/**
 * The host folders that S34 deleted from core, repo-root-relative. A core
 * import must never resolve into one of them, and they must not come back.
 */
export const DEFAULT_HOST_ROOTS: readonly string[] = [
  "src/host",
  "src/cli",
  "src/ui",
  "src/input",
  "src/terminal",
  "src/e2e",
]

/**
 * Files exempt from the repo scan: this scanner's own unit test and the S2
 * guard test must embed host-escaping specifiers as string fixtures (same category as the
 * core-plugin scanner's exemption of its own test).
 */
export const DEFAULT_EXEMPT: ReadonlySet<string> = new Set([
  "architecture/core-host-import-scan.test.ts",
  // The S2 guard test embeds one violation per fixture, by design.
  "architecture/core-boundary-guard.test.ts",
])

/** One host import site inside a core source file. */
export interface CoreHostImportSite {
  /** Path relative to the src root, e.g. `ui/compositor.ts`. */
  readonly file: string
  /** The literal import specifier, e.g. `../host/ui/compositor.ts`. */
  readonly specifier: string
  /** The specifier resolved against the file's dir, repo-root-relative. */
  readonly resolved: string
  /**
   * True when the site is `import type ... from` / `export type ... from`.
   * Type-only imports are STILL violations (core would not compile with the
   * host tree split out), reported separately because migration cost differs.
   */
  readonly typeOnly: boolean
}

/**
 * Matches the import forms carrying a LITERAL specifier across lines.
 * Identical in spirit to the core-plugin scanner's regex; see that module
 * for the per-alternative breakdown. Computed dynamic imports (the loader's
 * blessed seam) have no literal string inside the parens and never match.
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

/**
 * Resolve a relative import specifier against the importing file's directory,
 * returning a path RELATIVE TO THE REPO ROOT (the parent of `src/`).
 * Example: (`ui/compositor.ts`, `../host/ui/compositor.ts`) →
 * `src/host/ui/compositor.ts`.
 */
export function resolveFromSrc(fileRel: string, specifier: string): string {
  const fromDir = posix.join("src", posix.dirname(fileRel))
  return posix.normalize(posix.join(fromDir, specifier))
}

/**
 * The violation predicate: true iff a relative specifier, resolved against
 * `src/<fileRel>`'s directory, lands inside one of `hostRoots`. Bare /
 * node: / bun: specifiers never violate.
 */
export function resolvesToHostRoot(
  fileRel: string,
  specifier: string,
  hostRoots: readonly string[] = DEFAULT_HOST_ROOTS,
): boolean {
  if (!specifier.startsWith(".")) return false
  const resolved = resolveFromSrc(fileRel, specifier)
  return hostRoots.some((root) => {
    const normalized = posix.normalize(root)
    return resolved === normalized || resolved.startsWith(`${normalized}/`)
  })
}

/**
 * Scan one core file's source text for import sites that resolve into the
 * host tree. Comments are stripped first.
 */
export function scanSourceForHostImports(
  source: string,
  fileRel: string,
  hostRoots: readonly string[] = DEFAULT_HOST_ROOTS,
): CoreHostImportSite[] {
  const code = stripComments(source)
  const out: CoreHostImportSite[] = []
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null = IMPORT_RE.exec(code)
  while (m !== null) {
    const specifier = m[2] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8]
    if (specifier !== undefined && resolvesToHostRoot(fileRel, specifier, hostRoots)) {
      out.push({
        file: fileRel,
        specifier,
        resolved: resolveFromSrc(fileRel, specifier),
        typeOnly: m[1] !== undefined || m[3] !== undefined,
      })
    }
    m = IMPORT_RE.exec(code)
  }
  return out
}

/**
 * Walk every `.ts` file under `srcRoot` and return all import sites that
 * resolve into the host tree, sorted by file then specifier (deterministic
 * for stable output). `exclude` entries are skipped.
 */
export function scanCoreHostImports(
  srcRoot: string,
  hostRoots: readonly string[] = DEFAULT_HOST_ROOTS,
  exclude: ReadonlySet<string> = new Set(),
): CoreHostImportSite[] {
  const sites: CoreHostImportSite[] = []
  for (const rel of tsFilesUnder(srcRoot)) {
    if (exclude.has(rel)) continue
    const text = readFileSync(join(srcRoot, rel), "utf8")
    sites.push(...scanSourceForHostImports(text, rel, hostRoots))
  }
  return sites.sort((a, b) =>
    a.file === b.file ? a.specifier.localeCompare(b.specifier) : a.file.localeCompare(b.file),
  )
}

/** Fold sites into a per-file count map. */
export function countSitesByFile(sites: readonly CoreHostImportSite[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sites) {
    out.set(s.file, (out.get(s.file) ?? 0) + 1)
  }
  return out
}

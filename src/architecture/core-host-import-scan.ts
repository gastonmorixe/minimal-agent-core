/**
 * Pure scanning helpers for the core→host import architecture test
 * (`src/architecture/core-host-import-scan.test.ts`).
 *
 * THE RULE: core (`src/` minus `src/host/`) must never import the host
 * package. No file under `src/` may import — static, `export ... from`,
 * type-only, or dynamic with a LITERAL specifier — anything that RESOLVES
 * into the host tree (`src/host/` today; the roots are a parameter so the
 * future `../minimal-agent-host/` move is a one-line change).
 *
 * THE BLESSED EXCEPTIONS: two files are allowed to import host code, because
 * they ARE the host adapter seam:
 *   - `src/index.ts` — the CLI/TUI entrypoint that wires the host shell.
 *   - `src/host/**` — the host package itself (intra-host imports are fine).
 * Everything else in core depends on SDK ports, never on the host shell.
 *
 * This mirrors `core-plugin-import-scan.ts` (the core→plugin ratchet, I2).
 * Resolution is path-aware: `../host/x` from `src/ui/foo.ts` lands in the
 * top-level `src/host/` tree (a violation while the shim exists), and the
 * scanner counts SITES per file so adding an import to an already-violating
 * file trips the ratchet too.
 *
 * Regenerate the frozen baseline after an intentional cleanup (a shim
 * deleted, a core→host edge severed):
 *
 *   bun -e 'import("./src/architecture/core-host-import-scan.ts").then(m =\>
 *     console.log(m.renderBaseline(m.scanCoreHostImports("src",
 *       m.DEFAULT_HOST_ROOTS, m.DEFAULT_BLESSED, m.DEFAULT_EXEMPT))))'
 *
 * @module architecture/core-host-import-scan
 */

import { readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { stripComments, tsFilesUnder } from "./provider-scan.ts"

/**
 * Host trees a core import must never resolve into, repo-root-relative.
 * `src/host` today; add `../minimal-agent-host` when the package moves to a
 * sibling repo. Kept consistent with `DEFAULT_HOST_ROOTS` in
 * `core-plugin-import-scan.ts` (which uses the bare `host` segment for the
 * post-split layout); here we pin the in-repo `src/host` location.
 */
export const DEFAULT_HOST_ROOTS: readonly string[] = ["src/host"]

/**
 * Files allowed to import host code: the CLI adapter entrypoint and the host
 * package itself. Paths are relative to the src root. `src/host/**` is matched
 * by prefix, `src/index.ts` by exact path.
 */
export const DEFAULT_BLESSED: ReadonlySet<string> = new Set(["index.ts"])

/** Prefix (src-root-relative) under which all files are blessed: the host pkg. */
export const BLESSED_PREFIX = "host/"

/**
 * Files exempt from the repo scan: this scanner's own unit test must embed
 * host-escaping specifiers as string fixtures (same category as the
 * core-plugin scanner's exemption of its own test).
 */
export const DEFAULT_EXEMPT: ReadonlySet<string> = new Set([
  "architecture/core-host-import-scan.test.ts",
])

/** One host import site inside a core (`src/` minus `src/host/`) source file. */
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

/** True iff `fileRel` (src-root-relative) is allowed to import host code. */
export function isBlessed(
  fileRel: string,
  blessed: ReadonlySet<string> = DEFAULT_BLESSED,
): boolean {
  return blessed.has(fileRel) || fileRel.startsWith(BLESSED_PREFIX)
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
 * host tree. Blessed files (the host package itself, the CLI entrypoint)
 * yield nothing. Comments are stripped first.
 */
export function scanSourceForHostImports(
  source: string,
  fileRel: string,
  hostRoots: readonly string[] = DEFAULT_HOST_ROOTS,
  blessed: ReadonlySet<string> = DEFAULT_BLESSED,
): CoreHostImportSite[] {
  if (isBlessed(fileRel, blessed)) return []
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
 * for baselines). Blessed files and `exclude` entries are skipped.
 */
export function scanCoreHostImports(
  srcRoot: string,
  hostRoots: readonly string[] = DEFAULT_HOST_ROOTS,
  blessed: ReadonlySet<string> = DEFAULT_BLESSED,
  exclude: ReadonlySet<string> = new Set(),
): CoreHostImportSite[] {
  const sites: CoreHostImportSite[] = []
  for (const rel of tsFilesUnder(srcRoot)) {
    if (exclude.has(rel)) continue
    const text = readFileSync(join(srcRoot, rel), "utf8")
    sites.push(...scanSourceForHostImports(text, rel, hostRoots, blessed))
  }
  return sites.sort((a, b) =>
    a.file === b.file ? a.specifier.localeCompare(b.specifier) : a.file.localeCompare(b.file),
  )
}

/**
 * Fold sites into a per-file count map — the ratchet's unit of account.
 * Counting sites (not just files) means ADDING an import to an
 * already-violating file trips the ratchet too.
 */
export function countSitesByFile(sites: readonly CoreHostImportSite[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sites) {
    out.set(s.file, (out.get(s.file) ?? 0) + 1)
  }
  return out
}

/** Render a count map as the TS source of a frozen baseline literal. */
export function renderBaseline(sites: readonly CoreHostImportSite[]): string {
  const counts = countSitesByFile(sites)
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, n]) => `  ["${file}", ${n}],`)
  return `const BASELINE = new Map<string, number>([\n${lines.join("\n")}\n])`
}

/**
 * Pure scanning helpers for the core→plugin import architecture test
 * (`src/architecture.core-plugin-imports.test.ts`) — invariant I2.
 *
 * THE RULE: core (`src/`) never imports plugins. No file under `src/` may
 * import — static, `export ... from`, type-only, or dynamic with a LITERAL
 * specifier — anything that RESOLVES into a top-level plugins tree
 * (`plugins/` today, `../minimal-agent-plugins/` after the split; the roots
 * are a parameter). Resolution is path-aware: `../plugins/x` from
 * `src/headers.ts` lands in the top-level `plugins/` tree (violation),
 * while `../plugins/types.ts` from `src/llm/provider.ts` resolves to
 * `src/plugins/types.ts` (loader infrastructure, core-internal, legal).
 *
 * THE BLESSED SEAM: the plugin loader's runtime discovery uses dynamic
 * `import(abs)` where `abs` is COMPUTED from manifest discovery. Computed
 * (non-literal) dynamic imports are intentionally NOT flagged — only
 * literal specifiers count.
 *
 * Split from the test so tooling (baseline regeneration, lint integration)
 * can reuse the exact same logic. Regenerate the baseline after intentional
 * cleanups:
 *
 *   bun -e 'import("./src/architecture/core-plugin-import-scan.ts").then(m =\>
 *     console.log(m.renderBaseline(m.scanCorePluginImports("src",
 *       m.DEFAULT_PLUGIN_ROOTS, m.DEFAULT_EXEMPT))))'
 *
 * @module architecture/core-plugin-import-scan
 */

import { readFileSync } from "node:fs"
import { join, posix } from "node:path"

import { stripComments, tsFilesUnder } from "./provider-scan.ts"

/** Plugin trees a core import must never resolve into (repo-root-relative). */
export const DEFAULT_PLUGIN_ROOTS: readonly string[] = ["plugins"]

/**
 * Host trees a core import must never resolve into (repo-root-relative).
 * The host/ package is the CLI/TUI shell; core must not depend on it.
 */
export const DEFAULT_HOST_ROOTS: readonly string[] = ["host"]

/**
 * Files exempt from the repo scan: this scanner's own unit test must embed
 * plugin-escaping specifiers as string fixtures (same category as the
 * provider test naming provider tokens).
 */
export const DEFAULT_EXEMPT: ReadonlySet<string> = new Set([
  "architecture/core-plugin-import-scan.test.ts",
  "architecture/architecture.plugin-api-leaf.test.ts",
])

/** One plugins/ import site inside a core (`src/`) source file. */
export interface CorePluginImportSite {
  /** Path relative to the src root, e.g. `headers.ts` or `agent/foo.ts`. */
  readonly file: string
  /** The literal import specifier, e.g. `../plugins/tasks/lib/parse.ts`. */
  readonly specifier: string
  /** The specifier resolved against the file's dir, repo-root-relative. */
  readonly resolved: string
  /**
   * True when the site is `import type ... from` / `export type ... from`.
   * Type-only imports are STILL violations (core would not compile with the
   * plugins tree moved to its own repo), but the split is reported because
   * the migration cost differs.
   */
  readonly typeOnly: boolean
}

/**
 * Matches the import forms that carry a LITERAL specifier, across lines
 * (multi-line import clauses included). Alternatives and groups:
 *
 *   1. `import [type] … from "spec"`   → g1 = `type` kw, g2 = spec
 *   2. `export [type] … from "spec"`   → g3 = `type` kw, g4 = spec
 *   3. `import("spec")` / `import("spec", …)` — dynamic with a string
 *      LITERAL first argument only      → g5 = spec
 *   4. `import "spec"` (side-effect)    → g6 = spec
 *   5. `require("spec")` — CommonJS with a string LITERAL only argument
 *      (bun supports `require` in .ts; review m1)   → g7 = spec
 *   6. backtick form `import(NO-SUBSTITUTION-template)` — a template
 *      literal with no dollar-brace substitution is a fully static
 *      specifier at runtime (review m2)              → g8 = spec
 *
 * The clause body class `[^"'=;]` cannot cross a `=` or `;`, which stops
 * the lazy matcher from bleeding across statement boundaries (e.g. an
 * `export type Foo = …` alias must not absorb a following import and
 * mis-classify it as type-only). Computed dynamic imports — `import(abs)`,
 * concatenations, template literals WITH dollar-brace substitutions — have
 * no static string literal directly inside the parens and never match
 * alternatives 3/5/6: that is the loader's blessed seam. Alternative 6's
 * content class excludes the dollar sign entirely, so any substitution
 * disqualifies the match (it also skips rare paths containing a literal
 * dollar sign, which do not occur in this repo's plugin trees).
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
 * Resolve a relative import specifier against the importing file's
 * directory, returning a normalized path RELATIVE TO THE REPO ROOT (the
 * parent of `src/`). Example: (`headers.ts`, `../plugins/x.ts`) →
 * `plugins/x.ts`; (`llm/provider.ts`, `../plugins/types.ts`) →
 * `src/plugins/types.ts`.
 */
export function resolveFromSrc(fileRel: string, specifier: string): string {
  const fromDir = posix.join("src", posix.dirname(fileRel))
  return posix.normalize(posix.join(fromDir, specifier))
}

/**
 * The I2 violation predicate: true iff a relative specifier, resolved
 * against `src/<fileRel>`'s directory, lands inside one of `pluginRoots`
 * (repo-root-relative trees, default `["plugins"]`). Bare/node:/bun:
 * specifiers never violate.
 */
export function resolvesToPluginRoot(
  fileRel: string,
  specifier: string,
  pluginRoots: readonly string[] = DEFAULT_PLUGIN_ROOTS,
): boolean {
  if (!specifier.startsWith(".")) return false
  const resolved = resolveFromSrc(fileRel, specifier)
  return pluginRoots.some((root) => {
    const normalized = posix.normalize(root)
    return resolved === normalized || resolved.startsWith(`${normalized}/`)
  })
}

/**
 * Scan one core file's source text for import sites that resolve into a
 * plugins tree. Comments are stripped first; the regex then runs over the
 * WHOLE text so multi-line import clauses are matched.
 */
export function scanSourceForPluginImports(
  source: string,
  fileRel: string,
  pluginRoots: readonly string[] = DEFAULT_PLUGIN_ROOTS,
): CorePluginImportSite[] {
  const code = stripComments(source)
  const out: CorePluginImportSite[] = []
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null = IMPORT_RE.exec(code)
  while (m !== null) {
    const specifier = m[2] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8]
    if (specifier !== undefined && resolvesToPluginRoot(fileRel, specifier, pluginRoots)) {
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
 * resolve into a plugins tree, sorted by file then specifier
 * (deterministic for baselines).
 */
export function scanCorePluginImports(
  srcRoot: string,
  pluginRoots: readonly string[] = DEFAULT_PLUGIN_ROOTS,
  exclude: ReadonlySet<string> = new Set(),
): CorePluginImportSite[] {
  const sites: CorePluginImportSite[] = []
  for (const rel of tsFilesUnder(srcRoot)) {
    if (exclude.has(rel)) continue
    const text = readFileSync(join(srcRoot, rel), "utf8")
    sites.push(...scanSourceForPluginImports(text, rel, pluginRoots))
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
export function countSitesByFile(sites: readonly CorePluginImportSite[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sites) {
    out.set(s.file, (out.get(s.file) ?? 0) + 1)
  }
  return out
}

/** Render a count map as the TS source of a frozen baseline literal. */
export function renderBaseline(sites: readonly CorePluginImportSite[]): string {
  const counts = countSitesByFile(sites)
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, n]) => `  ["${file}", ${n}],`)
  return `const BASELINE = new Map<string, number>([\n${lines.join("\n")}\n])`
}

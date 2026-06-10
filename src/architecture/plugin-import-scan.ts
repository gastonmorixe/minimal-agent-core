/**
 * Pure scanning helpers for the plugin-decoupling architecture test
 * (`src/architecture.plugin-decoupling.test.ts`).
 *
 * THE RULE: a plugin must be able to live in its own repo. It may NOT
 * import host code (`src/...`) — not even type-only. The host hands every
 * capability a plugin needs through its handler context (`ctx`, `ctx.host`,
 * env vars); a plugin re-declares the slice it consumes as a LOCAL
 * structural interface and TypeScript's structural typing does the rest.
 *
 * This module finds the import sites that violate that rule so the test
 * can ratchet them down to zero. Split from the test so tooling (baseline
 * regeneration, lint integration) can reuse the exact same logic.
 *
 * Regenerate the baseline after intentional cleanups:
 *
 *   bun -e 'import("./src/architecture/plugin-import-scan.ts").then(m =>
 *     console.log(m.renderBaseline(m.scanPluginSrcImports("plugins"))))'
 *
 * @module architecture/plugin-import-scan
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { stripComments } from "./provider-scan.ts"

/** One `src/` import site inside a plugin source file. */
export interface PluginImportSite {
  /** Path relative to the plugins root, e.g. `session-info/lib/gather.ts`. */
  readonly file: string
  /** The literal import specifier, e.g. `../../../src/session-tokens.ts`. */
  readonly specifier: string
  /**
   * True when the site is `import type ... from` / `export type ... from`.
   * Type-only imports are STILL violations (a plugin in its own repo can't
   * resolve them), but the split is reported because the migration cost
   * differs: type-only sites become local structural interfaces; runtime
   * sites need a host capability or context seam.
   */
  readonly typeOnly: boolean
}

/**
 * Matches static `import`/`export ... from "<spec>"` and dynamic
 * `import("<spec>")` forms after comments are stripped. Group 1 = the
 * `type` keyword when present (static forms only), group 2/3 = specifier.
 */
const IMPORT_RE =
  /(?:\bimport\s+(type\s+)?[^"']*?from\s*|\bexport\s+(?:type\s+)?[^"']*?from\s*|\bimport\s*\(\s*)["']([^"']+)["']/g

const TYPE_EXPORT_RE = /\bexport\s+type\s+[^"']*?from\s*["']([^"']+)["']/

/** True when a relative specifier escapes the plugins tree into `src/`. */
export function isSrcImport(specifier: string): boolean {
  if (!specifier.startsWith(".")) return false
  // Normalize: any `../`+ prefix followed by `src/` reaches host code.
  return /^(\.\.\/)+src\//.test(specifier)
}

/** Recursively collect .ts files under a root, as root-relative paths. */
export function pluginTsFilesUnder(root: string): string[] {
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

/** Scan one file's source text for `src/` import sites. */
export function scanSourceForSrcImports(source: string, file: string): PluginImportSite[] {
  const code = stripComments(source)
  const out: PluginImportSite[] = []
  for (const line of code.split("\n")) {
    IMPORT_RE.lastIndex = 0
    let m: RegExpExecArray | null = IMPORT_RE.exec(line)
    while (m !== null) {
      const specifier = m[2]
      if (isSrcImport(specifier)) {
        const typeOnly = m[1] !== undefined || TYPE_EXPORT_RE.test(line)
        out.push({ file, specifier, typeOnly })
      }
      m = IMPORT_RE.exec(line)
    }
  }
  return out
}

/**
 * Walk every `.ts` file under `pluginsRoot` and return all `src/` import
 * sites, sorted by file then specifier (deterministic for baselines).
 */
export function scanPluginSrcImports(pluginsRoot: string): PluginImportSite[] {
  const sites: PluginImportSite[] = []
  for (const rel of pluginTsFilesUnder(pluginsRoot)) {
    const text = readFileSync(join(pluginsRoot, rel), "utf8")
    sites.push(...scanSourceForSrcImports(text, rel))
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
export function countByFile(sites: readonly PluginImportSite[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of sites) {
    out.set(s.file, (out.get(s.file) ?? 0) + 1)
  }
  return out
}

/** Render a count map as the TS source of a frozen baseline literal. */
export function renderBaseline(sites: readonly PluginImportSite[]): string {
  const counts = countByFile(sites)
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, n]) => `  ["${file}", ${n}],`)
  return `const BASELINE = new Map<string, number>([\n${lines.join("\n")}\n])`
}

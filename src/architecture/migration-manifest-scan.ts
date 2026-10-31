/**
 * Pure helpers for the migration manifest test
 * (`src/architecture/migration-manifest.test.ts`, spec S7).
 *
 * THE MANIFEST: `migration-manifest.json` has one row per file in the areas
 * that leave or change in the core/CLI split ({@link MANIFEST_AREAS}). Each
 * row says where the file goes:
 *   - `core-engine`: it stays in core. `target` is its core path.
 *   - `cli`: it moves to minimal-agent-cli. `target` is its CLI path.
 *   - `delete`: it is removed. `target` is null.
 * A row path that ends in `/` is a folder row. It covers every file under
 * that folder that has no file row of its own (used for the `src/ui/` shims).
 *
 * CLI file rows also list `imports`: the core files the file imports today,
 * repo-relative and sorted. These are the core modules the CLI needs from
 * the package exports map (S11). The test recomputes them, so the list stays
 * true. After an import change in a CLI-bound file, refresh it with:
 *
 *   bun -e 'import("./src/architecture/migration-manifest-scan.ts").then(m =\>
 *     m.writeRefreshedManifest("."))' && bun run format
 *
 * A new file in an area needs a row written by hand: the dest and target are
 * a decision, so the refresh never adds rows.
 *
 * @module architecture/migration-manifest-scan
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, posix } from "node:path"

import { stripComments } from "./provider-scan.ts"

/** Where a file goes in the split. */
export type ManifestDest = "core-engine" | "cli" | "delete"

/** One manifest row. */
export interface ManifestRow {
  /** Repo-relative path. A trailing `/` makes it a folder row. */
  readonly path: string
  /** Where the file goes. */
  readonly dest: ManifestDest
  /** Core path (`core-engine`), `minimal-agent-cli/...` path (`cli`), or null (`delete`). */
  readonly target: string | null
  /** A part of the file that goes elsewhere, or the spec that moves it. */
  readonly note?: string
  /** CLI file rows only: core files this file imports, repo-relative, sorted. */
  readonly imports?: readonly string[]
}

/** The manifest file shape. */
export interface Manifest {
  /** One-line description for readers of the JSON file. */
  readonly about: string
  /** Rows sorted by path. */
  readonly rows: readonly ManifestRow[]
}

/** What the manifest check found. Every list is empty when the manifest is current. */
export interface ManifestProblems {
  /** Files in an area with no row. */
  readonly missingRows: string[]
  /** Rows that name a path that does not exist. */
  readonly missingFiles: string[]
  /** Rows with an invalid shape (dest, target, imports, order, area). */
  readonly badRows: string[]
  /** CLI rows whose `imports` differ from the scan. */
  readonly staleImports: string[]
}

/**
 * The areas S7 covers, repo-relative. A trailing `/` is a folder (every file
 * under it). The abort-bus and log-stderr tests move with their subjects (S34).
 */
export const MANIFEST_AREAS: readonly string[] = [
  "src/host/",
  "src/ui/",
  "src/input/",
  "src/terminal/",
  "src/cli/",
  "src/modes/",
  "src/plugins/host/",
  "src/e2e/",
  "src/index.ts",
  "src/bus/abort-bus.ts",
  "src/bus/abort-bus.test.ts",
  "src/bus/abort-quit-fsm.ts",
  "src/bus/abort-quit-keystroke.test.ts",
  "src/logging/log-stderr.ts",
  "src/logging/log-stderr.test.ts",
  "src/infra/safe-stdout.ts",
  "src/test-utils/fixtures/paste-pty-driver.ts",
  "src/test-utils/fixtures/quit-confirm-tmux-driver.ts",
]

/** Repo-relative path of the manifest data file. */
export const MANIFEST_PATH = "src/architecture/migration-manifest.json"

/** The package name core imports itself by. */
const CORE_PACKAGE = "@minimal-agent/core"

/** Roots that hold core files (anything a CLI file can import from core). */
const CORE_ROOTS: readonly string[] = ["src/", "plugin-api/"]

/**
 * Import forms with a literal specifier, across lines: static import,
 * `export ... from`, literal dynamic import, side-effect import, `require`,
 * and a template-literal dynamic import with no `${`. Same forms as the
 * other import scanners in this folder.
 */
const IMPORT_RE = new RegExp(
  [
    String.raw`\bimport\s+(?:type\s+)?[^"'=;]*?from\s*["']([^"']+)["']`,
    String.raw`\bexport\s+(?:type\s+)?[^"'=;]*?from\s*["']([^"']+)["']`,
    String.raw`\bimport\s*\(\s*["']([^"']+)["']\s*[),]`,
    String.raw`\bimport\s+["']([^"']+)["']`,
    String.raw`\brequire\s*\(\s*["']([^"']+)["']\s*\)`,
    "\\bimport\\s*\\(\\s*`([^`$]+)`\\s*[),]",
  ].join("|"),
  "g",
)

/** Read and parse the manifest under `repoRoot`. */
export function loadManifest(repoRoot: string, rel: string = MANIFEST_PATH): Manifest {
  return JSON.parse(readFileSync(join(repoRoot, rel), "utf8")) as Manifest
}

/** Read the package `exports` map under `repoRoot`. */
export function loadExportsMap(repoRoot: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    exports?: Record<string, string>
  }
  return pkg.exports ?? {}
}

/** Every file under each area, repo-relative and sorted. Missing areas yield nothing. */
export function areaFiles(repoRoot: string, areas: readonly string[] = MANIFEST_AREAS): string[] {
  const out = new Set<string>()
  const walk = (rel: string): void => {
    const full = join(repoRoot, rel)
    if (statSync(full).isDirectory()) {
      for (const name of readdirSync(full)) walk(posix.join(rel, name))
    } else {
      out.add(rel)
    }
  }
  for (const area of areas) {
    const rel = area.endsWith("/") ? area.slice(0, -1) : area
    if (existsSync(join(repoRoot, rel))) walk(rel)
  }
  return [...out].sort()
}

/** The row that covers `file`: its own file row, else the deepest folder row above it. */
export function rowFor(file: string, rows: readonly ManifestRow[]): ManifestRow | undefined {
  let folder: ManifestRow | undefined
  for (const row of rows) {
    if (row.path === file) return row
    if (row.path.endsWith("/") && file.startsWith(row.path)) {
      if (folder === undefined || row.path.length > folder.path.length) folder = row
    }
  }
  return folder
}

/**
 * Resolve one import specifier from `file` to a repo-relative path. Relative
 * specifiers resolve against the file's folder. `@minimal-agent/core` and its
 * subpaths resolve through the exports map. Other bare specifiers (`node:*`,
 * `bun:*`, packages) return null.
 */
export function resolveSpecifier(
  file: string,
  specifier: string,
  exportsMap: Readonly<Record<string, string>>,
): string | null {
  if (specifier.startsWith(".")) {
    return posix.normalize(posix.join(posix.dirname(file), specifier))
  }
  if (specifier === CORE_PACKAGE || specifier.startsWith(`${CORE_PACKAGE}/`)) {
    const key = `.${specifier.slice(CORE_PACKAGE.length)}`
    const target = exportsMap[key]
    return target === undefined ? null : posix.normalize(target)
  }
  return null
}

/** Repo-relative paths that `source` (the text of `file`) imports, sorted and unique. */
export function importedPaths(
  source: string,
  file: string,
  exportsMap: Readonly<Record<string, string>>,
): string[] {
  const code = stripComments(source)
  const out = new Set<string>()
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null = IMPORT_RE.exec(code)
  while (m !== null) {
    const specifier = m.slice(1).find((g) => g !== undefined)
    if (specifier !== undefined) {
      const resolved = resolveSpecifier(file, specifier, exportsMap)
      if (resolved !== null) out.add(resolved)
    }
    m = IMPORT_RE.exec(code)
  }
  return [...out].sort()
}

/**
 * The core files `file` imports: imported paths under a core root whose own
 * row (if any) keeps them in core. Imports of other CLI-bound or deleted files
 * are not core imports.
 */
export function coreImportsOf(
  repoRoot: string,
  file: string,
  rows: readonly ManifestRow[],
  exportsMap: Readonly<Record<string, string>>,
): string[] {
  const source = readFileSync(join(repoRoot, file), "utf8")
  return importedPaths(source, file, exportsMap).filter((dep) => {
    if (dep === file || !CORE_ROOTS.some((root) => dep.startsWith(root))) return false
    const row = rowFor(dep, rows)
    return row === undefined || row.dest === "core-engine"
  })
}

/** True for a row that should carry an `imports` list: a CLI row for one `.ts` file. */
function wantsImports(row: ManifestRow): boolean {
  return row.dest === "cli" && !row.path.endsWith("/") && row.path.endsWith(".ts")
}

/** True when `path` lies inside one of `areas`. */
function inAreas(path: string, areas: readonly string[]): boolean {
  return areas.some((area) => (area.endsWith("/") ? path.startsWith(area) : path === area))
}

/** Shape problems for one row, as readable lines. */
function rowShapeProblems(row: ManifestRow, areas: readonly string[]): string[] {
  const out: string[] = []
  const at = `${row.path}:`
  if (!inAreas(row.path, areas)) out.push(`${at} not in a manifest area`)
  if (row.dest === "delete") {
    if (row.target !== null) out.push(`${at} a delete row must have target null`)
  } else if (row.dest === "cli") {
    if (typeof row.target !== "string" || !row.target.startsWith("minimal-agent-cli/")) {
      out.push(`${at} a cli row must target a minimal-agent-cli/ path`)
    }
  } else if (row.dest === "core-engine") {
    if (typeof row.target !== "string" || !CORE_ROOTS.some((r) => row.target?.startsWith(r))) {
      out.push(`${at} a core-engine row must target a src/ or plugin-api/ path`)
    }
  } else {
    out.push(`${at} dest must be core-engine, cli, or delete`)
  }
  if (!wantsImports(row) && row.imports !== undefined) {
    out.push(`${at} only cli file rows list imports`)
  }
  return out
}

/**
 * Check `manifest` against the tree under `repoRoot`. A current manifest
 * returns four empty lists.
 */
export function checkManifest(
  repoRoot: string,
  manifest: Manifest,
  exportsMap: Readonly<Record<string, string>>,
  areas: readonly string[] = MANIFEST_AREAS,
): ManifestProblems {
  const rows = manifest.rows
  const missingRows = areaFiles(repoRoot, areas).filter((f) => rowFor(f, rows) === undefined)
  const missingFiles: string[] = []
  const badRows: string[] = []
  const staleImports: string[] = []
  for (const [i, row] of rows.entries()) {
    const prev = rows[i - 1]
    if (prev !== undefined && prev.path >= row.path) {
      badRows.push(`${row.path}: rows must be sorted by path with no duplicates`)
    }
    badRows.push(...rowShapeProblems(row, areas))
    const rel = row.path.endsWith("/") ? row.path.slice(0, -1) : row.path
    if (!existsSync(join(repoRoot, rel))) {
      missingFiles.push(row.path)
      continue
    }
    if (!wantsImports(row)) continue
    const actual = coreImportsOf(repoRoot, row.path, rows, exportsMap)
    if (JSON.stringify(actual) !== JSON.stringify(row.imports ?? [])) {
      staleImports.push(row.path)
    }
  }
  return { missingRows, missingFiles, badRows, staleImports }
}

/**
 * Return `manifest` with every CLI file row's `imports` recomputed from the
 * tree. Rows, dests, targets, and notes are kept as they are.
 */
export function refreshImports(
  repoRoot: string,
  manifest: Manifest,
  exportsMap: Readonly<Record<string, string>>,
): Manifest {
  const rows = manifest.rows.map((row): ManifestRow => {
    const base: ManifestRow = {
      path: row.path,
      dest: row.dest,
      target: row.target,
      ...(row.note === undefined ? {} : { note: row.note }),
    }
    if (!wantsImports(row) || !existsSync(join(repoRoot, row.path))) return base
    return { ...base, imports: coreImportsOf(repoRoot, row.path, manifest.rows, exportsMap) }
  })
  return { ...manifest, rows }
}

/** Rewrite the manifest under `repoRoot` with refreshed imports. Run `bun run format` after. */
export function writeRefreshedManifest(repoRoot: string): void {
  const refreshed = refreshImports(repoRoot, loadManifest(repoRoot), loadExportsMap(repoRoot))
  writeFileSync(join(repoRoot, MANIFEST_PATH), `${JSON.stringify(refreshed, null, 2)}\n`)
}

/**
 * The public closure walk for `src/architecture/public-closure.test.ts`
 * (spec S32).
 *
 * THE WALK: start at every target in the package `exports` map (except
 * `./package.json`) and follow every edge to a core file: static imports,
 * `export ... from`, dynamic `import()`, `require()`, type-only imports, and
 * type-position `import("x").T`. Relative specifiers resolve against the
 * file. `@minimal-agent/core/...` self-imports resolve through the exports
 * map. Other packages and builtins are not core and are not followed.
 *
 * THE RULES, for each file reached:
 *   - `cliFile`: it is under `src/cli`, `src/host`, `src/ui`, `src/terminal`,
 *     or `src/input`, or the migration manifest sends it to the CLI.
 *   - `stdio`: it uses `process.stdin`, `process.stdout`, `process.stderr`,
 *     `Bun.stdin` / `Bun.stdout` / `Bun.stderr`, or `console` output.
 *   - `ansi`: a string, template, or regex literal holds an ESC character.
 *
 * The scan is the SDK boundary scanner's TypeScript AST pass, so comments
 * and plain strings never count as code.
 *
 * THE BASELINE ({@link PUBLIC_CLOSURE_BASELINE}) lists the files that break
 * a rule today. It only shrinks until S44 empties it. Regenerate the counts
 * after a cleanup with (then copy the reasons over):
 *
 *   bun -e 'import("./src/architecture/public-closure-scan.ts").then(m =\>
 *     console.log(m.renderClosureBaseline(m.walkPublicClosure("."))))'
 *
 * @module architecture/public-closure-scan
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join, posix } from "node:path"

import { coreSourceFiles, inAreas, isCliBound } from "./direct-write-scan.ts"
import {
  loadExportsMap,
  loadManifest,
  type ManifestRow,
  resolveSpecifier,
} from "./migration-manifest-scan.ts"
import { type SdkScanResult, scanSourcesWithTypeScript } from "./sdk-port-boundaries-scan.ts"

/** The package name core imports itself by. */
const CORE_PACKAGE = "@minimal-agent/core"

/** Folders the public closure may not reach (S32 rule 1). */
export const CLOSURE_FORBIDDEN_FOLDERS: readonly string[] = [
  "src/cli/",
  "src/host/",
  "src/ui/",
  "src/terminal/",
  "src/input/",
]

/** Rule findings for one reached file. A file with none is clean. */
export interface ClosureFinding {
  /** In a forbidden folder, or CLI-bound per the manifest. */
  readonly cliFile: boolean
  /** Number of stdio uses (process / Bun streams, console output). */
  readonly stdio: number
  /** Number of literals that hold an ESC character. */
  readonly ansi: number
}

/** A baseline entry: the findings a file may still have, and why. */
export interface ClosureBaselineEntry extends ClosureFinding {
  /** Why the file is still reached, and the spec that fixes it. */
  readonly reason: string
}

/** The public closure baseline, frozen at the 2026-10-31 walk. Counts only go down. */
export const PUBLIC_CLOSURE_BASELINE: ReadonlyMap<string, ClosureBaselineEntry> = new Map<
  string,
  ClosureBaselineEntry
>([
  [
    "plugin-api/src/utils/ansi.ts",
    {
      cliFile: false,
      stdio: 0,
      ansi: 48,
      reason:
        "exported TUI helper; real sibling plugins (schedule, memory, quota-status, " +
        "diagnostics) import it directly for tool-handler output, not just cosmetics, " +
        "so it stays pending a fix to those plugins or to the loader's all-or-nothing " +
        "handler resolution (S33 session report)",
    },
  ],
  [
    "plugin-api/src/utils/palette.ts",
    {
      cliFile: false,
      stdio: 0,
      ansi: 22,
      reason: "exported TUI helper; same real-plugin-dependency reason as ansi.ts above",
    },
  ],
  [
    "plugin-api/src/utils/term-width.ts",
    {
      cliFile: false,
      stdio: 0,
      ansi: 9,
      reason: "exported TUI helper; same real-plugin-dependency reason as ansi.ts above",
    },
  ],
])

/** The result of one walk. */
export interface PublicClosure {
  /** Entry files, repo-relative and sorted. */
  readonly entries: readonly string[]
  /** Every reached file (entries included), repo-relative and sorted. */
  readonly reached: readonly string[]
  /** Files with at least one finding, sorted by path. */
  readonly findings: ReadonlyMap<string, ClosureFinding>
  /** For each reached non-entry file, the file whose edge first reached it. */
  readonly via: ReadonlyMap<string, string>
  /** Core edges that resolve to no file, as `file: specifier`. */
  readonly unresolved: readonly string[]
}

/** Inputs for {@link walkPublicClosure}. Defaults read the repo under `repoRoot`. */
export interface ClosureWalkOptions {
  readonly exportsMap?: Readonly<Record<string, string>>
  readonly rows?: readonly ManifestRow[]
}

/** True for a stdio use token from the AST scan. */
export function isStdioToken(token: string): boolean {
  return (
    /^process\.std(?:in|out|err)$/u.test(token) ||
    /^Bun\.std(?:in|out|err)$/u.test(token) ||
    token.startsWith("console.")
  )
}

/** The rule findings for one scanned file. */
export function findingFor(
  file: string,
  result: SdkScanResult | undefined,
  rows: readonly ManifestRow[],
): ClosureFinding {
  return {
    cliFile: inAreas(file, CLOSURE_FORBIDDEN_FOLDERS) || isCliBound(file, rows),
    stdio: result?.ambientEscapes.filter((site) => isStdioToken(site.token)).length ?? 0,
    ansi: result?.escapeLiterals.length ?? 0,
  }
}

/** True when a finding breaks at least one rule. */
export function hasFinding(finding: ClosureFinding): boolean {
  return finding.cliFile || finding.stdio > 0 || finding.ansi > 0
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

/**
 * Resolve one edge from `file` to a repo-relative core path. Returns null for
 * an edge that leaves core (builtins, other packages), and `undefined` for a
 * core edge that resolves to no file.
 */
export function resolveCoreEdge(
  repoRoot: string,
  file: string,
  specifier: string,
  exportsMap: Readonly<Record<string, string>>,
): string | null | undefined {
  const relative = specifier.startsWith(".")
  const self = specifier === CORE_PACKAGE || specifier.startsWith(`${CORE_PACKAGE}/`)
  if (!relative && !self) return null
  const base = resolveSpecifier(file, specifier, exportsMap)
  if (base === null) return undefined
  const candidates = [base, `${base}.ts`, `${base}/index.ts`]
  if (base.endsWith(".js")) candidates.push(`${base.slice(0, -3)}.ts`)
  return candidates.find((c) => isFile(join(repoRoot, c)))
}

/** Walk the closure of the public entries under `repoRoot`. */
export function walkPublicClosure(
  repoRoot: string,
  options: ClosureWalkOptions = {},
): PublicClosure {
  const exportsMap = options.exportsMap ?? loadExportsMap(repoRoot)
  const rows = options.rows ?? loadManifest(repoRoot).rows
  const scans = new Map<string, SdkScanResult>()
  const scan = (files: readonly string[]): void => {
    const todo = files.filter((f) => f.endsWith(".ts") && !scans.has(f))
    if (todo.length === 0) return
    const entries = todo.map((file) => ({
      file,
      source: readFileSync(join(repoRoot, file), "utf8"),
    }))
    for (const [i, result] of scanSourcesWithTypeScript(entries).entries()) {
      const file = todo[i]
      if (file !== undefined) scans.set(file, result)
    }
  }
  // One AST pass over all core source up front. Files outside it (rare)
  // are scanned per layer below.
  scan(coreSourceFiles(repoRoot))

  const entries = [
    ...new Set(
      Object.entries(exportsMap)
        .filter(([key]) => key !== "./package.json")
        .map(([, target]) => posix.normalize(target)),
    ),
  ].sort()
  const seen = new Set<string>(entries)
  const via = new Map<string, string>()
  const unresolved: string[] = []
  let frontier = entries.filter((f) => isFile(join(repoRoot, f)))
  for (const missing of entries.filter((f) => !isFile(join(repoRoot, f)))) {
    unresolved.push(`package.json exports: ${missing}`)
  }
  while (frontier.length > 0) {
    scan(frontier)
    const next: string[] = []
    for (const file of frontier) {
      const result = scans.get(file)
      if (result === undefined) continue
      for (const site of [...result.imports, ...result.typeImports]) {
        const target = resolveCoreEdge(repoRoot, file, site.specifier, exportsMap)
        if (target === null) continue
        if (target === undefined) {
          unresolved.push(`${file}: ${site.specifier}`)
          continue
        }
        if (seen.has(target)) continue
        seen.add(target)
        via.set(target, file)
        next.push(target)
      }
    }
    frontier = next
  }

  const reached = [...seen].sort()
  const findings = new Map<string, ClosureFinding>()
  for (const file of reached) {
    const finding = findingFor(file, scans.get(file), rows)
    if (hasFinding(finding)) findings.set(file, finding)
  }
  return { entries, reached, findings, via, unresolved: [...new Set(unresolved)].sort() }
}

/** The import chain from an entry to `file`, entry first. */
export function chainTo(closure: PublicClosure, file: string): string[] {
  const chain = [file]
  for (let at = closure.via.get(file); at !== undefined; at = closure.via.get(at)) {
    chain.unshift(at)
  }
  return chain
}

/** Render `closure.findings` as the source of a baseline map, for regeneration. */
export function renderClosureBaseline(closure: PublicClosure): string {
  return [...closure.findings]
    .map(
      ([file, f]) =>
        `  ["${file}", { cliFile: ${f.cliFile}, stdio: ${f.stdio}, ansi: ${f.ansi}, reason: "" }],`,
    )
    .join("\n")
}

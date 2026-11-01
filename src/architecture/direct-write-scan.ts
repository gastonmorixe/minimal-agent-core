/**
 * Scope and scan for the direct-write ratchet
 * (`src/architecture/no-direct-writes.test.ts`, spec S25).
 *
 * THE RULE: engine code never writes to the terminal itself. It reports
 * through the diagnostic bus (`src/bus/diagnostic-bus.ts`) and lets the host
 * decide where text goes. A direct write is:
 *   - a `console.<output method>` call (`log`, `error`, `warn`, ...),
 *   - `process.stdout.write` or `process.stderr.write`,
 *   - any use of `Bun.stdout` or `Bun.stderr`.
 * Reading `process.stdout.columns` is not a write (S24 owns width reads), and
 * neither is handing a stream object on. The public closure test (S32) flags
 * every stdio use that the public entries reach.
 *
 * SCOPE: every non-test core source file except dev tooling and test
 * helpers (`src/architecture/`, `src/test-utils/`). The terminal host and
 * its writes moved to minimal-agent-cli in S34, so the scope has no other
 * exception and the rule has no allow list.
 *
 * The scan is the SDK boundary scanner's TypeScript AST pass, so comments,
 * strings, and shadowed globals never count.
 *
 * @module architecture/direct-write-scan
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { tsFilesUnder } from "./provider-scan.ts"
import {
  type ScanEntry,
  type SdkScanResult,
  scanSourcesWithTypeScript,
} from "./sdk-port-boundaries-scan.ts"

/** Repo-relative roots that hold core source. */
export const CORE_SOURCE_ROOTS: readonly string[] = ["src", "plugin-api/src"]

/** Dev tooling and test helpers: not engine code. */
export const DEV_TOOLING: readonly string[] = ["src/architecture/", "src/test-utils/"]

/** One direct write. */
export interface DirectWrite {
  /** Repo-relative path. */
  readonly file: string
  readonly line: number
  /** `console.error`, `process.stderr.write`, `Bun.stdout`, ... */
  readonly token: string
}

/** True when `path` is inside one of `areas` (a trailing `/` is a folder). */
export function inAreas(path: string, areas: readonly string[]): boolean {
  return areas.some((area) => (area.endsWith("/") ? path.startsWith(area) : path === area))
}

/** Every non-test `.ts` file under the core roots, repo-relative and sorted. */
export function coreSourceFiles(repoRoot: string): string[] {
  const out: string[] = []
  for (const root of CORE_SOURCE_ROOTS) {
    if (!existsSync(join(repoRoot, root))) continue
    for (const rel of tsFilesUnder(join(repoRoot, root))) {
      const file = `${root}/${rel.split("\\").join("/")}`
      if (!file.endsWith(".test.ts")) out.push(file)
    }
  }
  return out.sort()
}

/** The files the direct-write rule covers (see the module doc). */
export function directWriteScope(repoRoot: string): string[] {
  return coreSourceFiles(repoRoot).filter((file) => !inAreas(file, DEV_TOOLING))
}

/** The direct writes in one scan result. */
export function directWritesIn(result: SdkScanResult): DirectWrite[] {
  const out: DirectWrite[] = []
  for (const site of result.ambientEscapes) {
    const stream = site.token === "process.stdout" || site.token === "process.stderr"
    if (stream && site.member === "write") {
      out.push({ file: site.file, line: site.line, token: `${site.token}.write` })
    } else if (
      site.token.startsWith("console.") ||
      site.token === "Bun.stdout" ||
      site.token === "Bun.stderr"
    ) {
      out.push({ file: site.file, line: site.line, token: site.token })
    }
  }
  return out
}

/** Scan `files` (repo-relative) in one AST pass and return every direct write. */
export function scanDirectWrites(repoRoot: string, files: readonly string[]): DirectWrite[] {
  const entries: ScanEntry[] = files.map((file) => ({
    file,
    source: readFileSync(join(repoRoot, file), "utf8"),
  }))
  return scanSourcesWithTypeScript(entries).flatMap(directWritesIn)
}

/**
 * Global diagnostic call-site inventory and its scanner (spec S20). The
 * ratchet lives in `src/architecture/diag-call-sites.test.ts`.
 *
 * THE RULE: every call to one of the global `diag.<severity>(...)` helpers
 * (`src/bus/diagnostic-bus.ts`) in an ENGINE file is listed in
 * {@link DIAG_CALL_SITE_INVENTORY} with its call-site count. "Engine" means:
 * not a test file, and not a file the migration manifest (`S7`,
 * `migration-manifest.json`) sends to `cli` or `delete`. A file with no
 * manifest row is engine by default — only the terminal-host areas
 * (`src/host/`, `src/ui/`, `src/cli/`, …) have rows at all.
 *
 * The list only shrinks, and reaches 0 in phase 8 (S44):
 *
 *   - A file with more calls than its entry (or a new file with any) FAILS.
 *   - A file with fewer calls than its entry (or none) FAILS too: lower or
 *     remove the entry, so the migration cannot regress.
 *
 * A call site moves by switching from the module-level `diag` import
 * (`src/bus/diagnostic-bus.ts`) to an injected `Diagnostics` handle
 * (`src/diagnostics/hub.ts`, S20): a constructor parameter / function
 * argument for a component built once, or a per-call field (next to
 * `signal`) for shared infrastructure that serves many sessions. See
 * `AgentCore`, `canonicalAttemptFn`, `withRetry`, `withAuthRefresh`, and
 * `NetworkClient` for worked examples of each shape. Until a site moves, it
 * stays correct (the global helpers forward to the runtime hub with no
 * session id), just less specific.
 *
 * Test code (`*.test.ts` and `src/test-utils/`) is not scanned: a test
 * asserting on the global bus is expected, not a site to move.
 *
 * Regenerate the counts after a migration with:
 *
 *   bun -e 'import("./src/architecture/diag-call-sites.ts").then(m =\>
 *     console.log(m.scanDiagCallSites(".")))'
 *
 * @module architecture/diag-call-sites
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { loadManifest, type ManifestRow, rowFor } from "./migration-manifest-scan.ts"
import { stripComments, tsFilesUnder } from "./provider-scan.ts"

/** Repo-relative roots that hold core source. */
export const DIAG_SCAN_ROOTS: readonly string[] = ["src", "plugin-api/src"]

/** One `diag.<severity>(` call. Comment text does not match. */
const DIAG_CALL_RE = /\bdiag\.(?:emergency|alert|critical|error|warn|notice|info|debug)\s*\(/g

/** True for test code, which the ratchet does not cover. */
export function isTestCode(repoRel: string): boolean {
  return repoRel.endsWith(".test.ts") || repoRel.startsWith("src/test-utils/")
}

/**
 * True for an engine file: not a file the migration manifest sends to `cli`
 * or `delete`. A file with no row (most of `src/`) is engine.
 */
export function isEngineFile(repoRel: string, rows: readonly ManifestRow[]): boolean {
  const row = rowFor(repoRel, rows)
  return row === undefined || row.dest === "core-engine"
}

/** Count `diag.<severity>(` call sites in `source`, with comments stripped. */
export function countDiagCalls(source: string): number {
  return stripComments(source).match(DIAG_CALL_RE)?.length ?? 0
}

/**
 * Scan the non-test engine `.ts` files under `roots` (relative to
 * `repoRoot`) and return repo-relative path to call count, for files with
 * at least one.
 */
export function scanDiagCallSites(
  repoRoot: string,
  roots: readonly string[] = DIAG_SCAN_ROOTS,
): Map<string, number> {
  const rows = loadManifest(repoRoot).rows
  const out = new Map<string, number>()
  for (const root of roots) {
    for (const rel of tsFilesUnder(join(repoRoot, root))) {
      const repoRel = `${root}/${rel.split("\\").join("/")}`
      if (isTestCode(repoRel) || !isEngineFile(repoRel, rows)) continue
      const n = countDiagCalls(readFileSync(join(repoRoot, repoRel), "utf8"))
      if (n > 0) out.set(repoRel, n)
    }
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)))
}

/**
 * The inventory, frozen at the 2026-10-31 scan (S20), rebased onto S25's
 * `process.stdout`/`stderr` → diagnostic-bus conversion. Counts only go
 * down, reaching 0 at S44.
 */
export const DIAG_CALL_SITE_INVENTORY: ReadonlyMap<string, number> = new Map<string, number>([
  ["src/auth/oauth-login.ts", 1],
  ["src/binaries/provision.ts", 3],
  ["src/cache/cache.ts", 1],
  ["src/config/config.ts", 1],
  ["src/llm/preflight.ts", 1],
  ["src/llm/provider-plugin.ts", 1],
  ["src/llm/transport/debug.ts", 1],
  ["src/logging/net-dbg.ts", 1],
  ["src/media/ingest.ts", 3],
  ["src/media/paste-intercept.ts", 1],
  ["src/modes/modes.ts", 1],
  ["src/network/client.ts", 1],
  ["src/plugins/event-bus.ts", 1],
  ["src/plugins/hooks/hook-bus.ts", 1],
  ["src/plugins/hooks/hooks.ts", 1],
  ["src/plugins/loader.ts", 1],
  ["src/plugins/loader/commands.ts", 1],
  ["src/plugins/loader/discovery.ts", 5],
  ["src/plugins/manifest.ts", 1],
  ["src/session/session-restore.ts", 1],
])

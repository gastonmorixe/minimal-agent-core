/**
 * Architecture fitness function: global `diag.*` call sites in engine files
 * only shrink (spec S20). See `./diag-call-sites.ts` for the rule and how a
 * site moves.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  countDiagCalls,
  DIAG_CALL_SITE_INVENTORY,
  isEngineFile,
  isTestCode,
  scanDiagCallSites,
} from "./diag-call-sites.ts"
import { loadManifest } from "./migration-manifest-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")

describe("countDiagCalls", () => {
  it("counts diag.<severity>( call sites", () => {
    const source = [
      'diag.warn("a", "b")',
      "diag.error('c', 'd', {e: 1})",
      'diag\n  .info("multiline-source-but-one-line-call", "x")',
    ].join("\n")
    expect(countDiagCalls(source)).toBe(2)
  })

  it("ignores comments and non-matching identifiers", () => {
    const source = [
      '// diag.warn("a", "b")',
      "/* diag.error('c', 'd') */",
      'myDiag.warn("not the global helper")',
      'diagnostics.warn("an injected handle, not the global helper")',
    ].join("\n")
    expect(countDiagCalls(source)).toBe(0)
  })
})

describe("isTestCode", () => {
  it("treats test files and src/test-utils as test code", () => {
    expect(isTestCode("src/llm/run.test.ts")).toBe(true)
    expect(isTestCode("src/test-utils/fixtures/foo.ts")).toBe(true)
    expect(isTestCode("src/llm/run.ts")).toBe(false)
  })
})

describe("isEngineFile", () => {
  const rows = loadManifest(REPO_ROOT).rows

  it("treats a file with no manifest row as engine", () => {
    expect(isEngineFile("src/llm/run.ts", rows)).toBe(true)
  })

  it("excludes a file the manifest sends to cli or delete", () => {
    const cliRow = rows.find((r) => r.dest === "cli")
    const deleteRow = rows.find((r) => r.dest === "delete")
    expect(cliRow).toBeDefined()
    expect(deleteRow).toBeDefined()
    if (cliRow) expect(isEngineFile(cliRow.path, rows)).toBe(false)
    if (deleteRow) expect(isEngineFile(deleteRow.path, rows)).toBe(false)
  })

  it("includes a file the manifest explicitly keeps in core", () => {
    const coreRow = rows.find((r) => r.dest === "core-engine" && !r.path.endsWith("/"))
    expect(coreRow).toBeDefined()
    if (coreRow) expect(isEngineFile(coreRow.path, rows)).toBe(true)
  })
})

describe("global diag call-site ratchet (S20)", () => {
  const actual = scanDiagCallSites(REPO_ROOT)

  it("no engine file has diag calls beyond its inventory entry", () => {
    const regressions: string[] = []
    for (const [file, n] of actual) {
      const allowed = DIAG_CALL_SITE_INVENTORY.get(file) ?? 0
      if (n > allowed) regressions.push(`  ${file}: ${n} diag call(s), inventory ${allowed}`)
    }
    expect(
      regressions,
      regressions.length > 0
        ? "New global diag.* call sites in engine code. Move the call to an\n" +
            "injected Diagnostics handle instead (src/diagnostics/hub.ts) — a\n" +
            "constructor/function parameter for a component built once, or a\n" +
            "per-call field (next to `signal`) for shared infrastructure. See\n" +
            "./diag-call-sites.ts for worked examples.\n" +
            regressions.join("\n")
        : "",
    ).toEqual([])
  })

  it("the inventory has no stale entries (moved sites lower the list)", () => {
    const stale: string[] = []
    for (const [file, allowed] of DIAG_CALL_SITE_INVENTORY) {
      const n = actual.get(file) ?? 0
      if (n < allowed) stale.push(`  ${file}: inventory ${allowed}, actual ${n}`)
    }
    expect(
      stale,
      stale.length > 0
        ? "Diag call-site inventory has stale entries. Lower or remove them\n" +
            "so the migration cannot regress:\n" +
            stale.join("\n")
        : "",
    ).toEqual([])
  })

  it("every inventoried file is still an engine file (no CLI-bound regression)", () => {
    const rows = loadManifest(REPO_ROOT).rows
    const misplaced = [...DIAG_CALL_SITE_INVENTORY.keys()].filter((f) => !isEngineFile(f, rows))
    expect(misplaced).toEqual([])
  })
})

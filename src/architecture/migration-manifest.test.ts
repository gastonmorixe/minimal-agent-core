/**
 * Architecture fitness function: the migration manifest (spec S7).
 *
 * THE RULE: every file in the areas that leave or change in the core/CLI
 * split has a row in `migration-manifest.json` that says where it goes
 * (`core-engine`, `cli`, or `delete`) and its target path. A row may not
 * name a missing file. CLI rows list the core files they import, and that
 * list must match the tree, because it is the input for the exports map
 * (S11) and the group move (S34).
 *
 * Fixing a failure:
 *   - A new file in an area: add its row by hand (the dest is a decision).
 *   - A removed or renamed file: delete or rename its row.
 *   - Stale imports: run the refresh one-liner in
 *     `migration-manifest-scan.ts`, then `bun run format`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import {
  areaFiles,
  checkManifest,
  coreImportsOf,
  importedPaths,
  loadExportsMap,
  loadManifest,
  type Manifest,
  type ManifestRow,
  refreshImports,
  resolveSpecifier,
  rowFor,
} from "./migration-manifest-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const EXPORTS = {
  "./sdk/events": "./src/sdk/events.ts",
  "./plugin-api": "./plugin-api/src/index.ts",
}

describe("resolveSpecifier", () => {
  it("resolves relative specifiers against the file's folder", () => {
    expect(resolveSpecifier("src/host/repl.ts", "../llm/messages.ts", EXPORTS)).toBe(
      "src/llm/messages.ts",
    )
    expect(resolveSpecifier("src/host/ui/a.ts", "./b.ts", EXPORTS)).toBe("src/host/ui/b.ts")
  })

  it("resolves the core package name through the exports map", () => {
    expect(resolveSpecifier("src/host/a.ts", "@minimal-agent/core/sdk/events", EXPORTS)).toBe(
      "src/sdk/events.ts",
    )
    expect(resolveSpecifier("src/host/a.ts", "@minimal-agent/core/plugin-api", EXPORTS)).toBe(
      "plugin-api/src/index.ts",
    )
  })

  it("ignores builtins, other packages, and unknown core subpaths", () => {
    expect(resolveSpecifier("src/host/a.ts", "node:fs", EXPORTS)).toBeNull()
    expect(resolveSpecifier("src/host/a.ts", "bun:test", EXPORTS)).toBeNull()
    expect(resolveSpecifier("src/host/a.ts", "@minimal-agent/core-x", EXPORTS)).toBeNull()
    expect(resolveSpecifier("src/host/a.ts", "@minimal-agent/core/nope", EXPORTS)).toBeNull()
  })
})

describe("importedPaths", () => {
  it("finds static, type, re-export, dynamic, side-effect, and multi-line imports", () => {
    const source = [
      `import { a } from "../llm/a.ts"`,
      `import type { B } from "../llm/b.ts"`,
      `export * from "./c.ts"`,
      `const d = await import("../llm/d.ts")`,
      `import "../llm/e.ts"`,
      `import {`,
      `  f,`,
      `} from "../llm/f.ts"`,
      `import { g } from "@minimal-agent/core/sdk/events"`,
      `import { h } from "node:path"`,
    ].join("\n")
    expect(importedPaths(source, "src/host/x.ts", EXPORTS)).toEqual([
      "src/host/c.ts",
      "src/llm/a.ts",
      "src/llm/b.ts",
      "src/llm/d.ts",
      "src/llm/e.ts",
      "src/llm/f.ts",
      "src/sdk/events.ts",
    ])
  })

  it("ignores imports inside comments and computed dynamic imports", () => {
    const source = `// import { a } from "../llm/a.ts"\n/* import "../llm/b.ts" */\nawait import(p)\n`
    expect(importedPaths(source, "src/host/x.ts", EXPORTS)).toEqual([])
  })
})

describe("rowFor", () => {
  const rows: ManifestRow[] = [
    { path: "src/ui/", dest: "delete", target: null },
    { path: "src/ui/real.ts", dest: "cli", target: "minimal-agent-cli/src/ui/real.ts" },
  ]

  it("prefers a file row over the folder row above it", () => {
    expect(rowFor("src/ui/real.ts", rows)?.dest).toBe("cli")
    expect(rowFor("src/ui/shim.ts", rows)?.dest).toBe("delete")
    expect(rowFor("src/llm/a.ts", rows)).toBeUndefined()
  })
})

describe("checkManifest (fixture tree)", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-manifest-"))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const write = (rel: string, text: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write("src/host/repl.ts", `import { m } from "../llm/m.ts"\nimport { s } from "./ui/s.ts"\n`)
  write("src/host/ui/s.ts", `import { k } from "../../modes/k.ts"\n`)
  write("src/host/adapter.ts", `export const a = 1\n`)
  write("src/modes/k.ts", `export const k = 1\n`)
  write("src/ui/shim.ts", `export const shim = 1\n`)
  write("src/llm/m.ts", `export const m = 1\n`)
  const areas = ["src/host/", "src/modes/", "src/ui/"]

  const good: Manifest = {
    about: "fixture",
    rows: [
      { path: "src/host/adapter.ts", dest: "core-engine", target: "src/loops/adapter.ts" },
      {
        path: "src/host/repl.ts",
        dest: "cli",
        target: "minimal-agent-cli/src/repl.ts",
        imports: ["src/llm/m.ts"],
      },
      {
        path: "src/host/ui/s.ts",
        dest: "cli",
        target: "minimal-agent-cli/src/ui/s.ts",
        imports: ["src/modes/k.ts"],
      },
      { path: "src/modes/k.ts", dest: "core-engine", target: "src/modes/k.ts" },
      { path: "src/ui/", dest: "delete", target: null },
    ],
  }

  it("walks every area file", () => {
    expect(areaFiles(root, areas)).toEqual([
      "src/host/adapter.ts",
      "src/host/repl.ts",
      "src/host/ui/s.ts",
      "src/modes/k.ts",
      "src/ui/shim.ts",
    ])
  })

  it("counts only core imports for a CLI row (not other CLI or deleted files)", () => {
    expect(coreImportsOf(root, "src/host/repl.ts", good.rows, EXPORTS)).toEqual(["src/llm/m.ts"])
  })

  it("passes a current manifest", () => {
    expect(checkManifest(root, good, EXPORTS, areas)).toEqual({
      missingRows: [],
      missingFiles: [],
      badRows: [],
      staleImports: [],
    })
  })

  it("flags a file with no row", () => {
    const rows = good.rows.filter((r) => r.path !== "src/modes/k.ts")
    expect(checkManifest(root, { ...good, rows }, EXPORTS, areas).missingRows).toEqual([
      "src/modes/k.ts",
    ])
  })

  it("flags a row that names a missing file", () => {
    const rows = [...good.rows, { path: "src/ui/zzz.ts", dest: "delete", target: null } as const]
    expect(checkManifest(root, { ...good, rows }, EXPORTS, areas).missingFiles).toEqual([
      "src/ui/zzz.ts",
    ])
  })

  it("flags bad dests, targets, imports, order, and paths outside the areas", () => {
    const rows: ManifestRow[] = [
      { path: "src/host/adapter.ts", dest: "cli", target: "src/x.ts" },
      { path: "src/host/repl.ts", dest: "core-engine", target: "x.ts", imports: [] },
      { path: "src/host/repl.ts", dest: "delete", target: "src/x.ts" },
      { path: "src/llm/m.ts", dest: "core-engine", target: "src/llm/m.ts" },
    ]
    expect(checkManifest(root, { ...good, rows }, EXPORTS, areas).badRows).toEqual([
      "src/host/adapter.ts: a cli row must target a minimal-agent-cli/ path",
      "src/host/repl.ts: a core-engine row must target a src/ or plugin-api/ path",
      "src/host/repl.ts: only cli file rows list imports",
      "src/host/repl.ts: rows must be sorted by path with no duplicates",
      "src/host/repl.ts: a delete row must have target null",
      "src/llm/m.ts: not in a manifest area",
    ])
  })

  it("flags stale imports, and the refresh fixes them", () => {
    const rows = good.rows.map((r) => (r.path === "src/host/repl.ts" ? { ...r, imports: [] } : r))
    const stale = { ...good, rows }
    expect(checkManifest(root, stale, EXPORTS, areas).staleImports).toEqual(["src/host/repl.ts"])
    expect(refreshImports(root, stale, EXPORTS)).toEqual(good)
  })
})

describe("migration manifest (repo invariant)", () => {
  const manifest = loadManifest(REPO_ROOT)
  const problems = checkManifest(REPO_ROOT, manifest, loadExportsMap(REPO_ROOT))

  it("every file in a manifest area has a row", () => {
    expect(
      problems.missingRows,
      "Add a row for each file to src/architecture/migration-manifest.json:\n" +
        "dest core-engine, cli, or delete, plus the target path.",
    ).toEqual([])
  })

  it("no row names a missing file", () => {
    expect(problems.missingFiles, "Remove or rename these manifest rows.").toEqual([])
  })

  it("every row is well formed", () => {
    expect(problems.badRows).toEqual([])
  })

  it("CLI rows list the core files they import", () => {
    expect(
      problems.staleImports,
      "These CLI rows have stale imports. Run the refresh one-liner in\n" +
        "src/architecture/migration-manifest-scan.ts, then bun run format.",
    ).toEqual([])
  })
})

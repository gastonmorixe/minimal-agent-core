/**
 * Architecture fitness function: the public package contract of
 * `@minimal-agent/core`.
 *
 * THE RULE: hosts (minimal-agent-cli, minimal-agent-web) and plugins install
 * core from git and import it ONLY through the `exports` map in
 * `package.json`. Three things keep that install working:
 *
 * 1. The package has no runtime dependencies at all. A `workspace:` or
 *    `catalog:` reference in an installable dependency field cannot resolve
 *    outside this checkout, so a git install of core would fail.
 * 2. Every export target exists and resolves by package name. Core itself
 *    imports plugin-api through the same self-reference
 *    (`@minimal-agent/core/plugin-api/...`) that consumers use.
 * 3. The export list is frozen in `public-exports.json`. Adding or removing a
 *    public subpath is a contract change, so it must update that file in the
 *    same commit.
 *
 * Spec 2.7 adds one more rule. No public subpath exports `TransportFn`,
 * `SendOptions`, or `StreamedResponse`, as a value or as a type. The scan
 * follows `export *` chains (see `public-name-scan.ts`).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { FORBIDDEN_PUBLIC_NAMES, forbiddenNamesIn } from "./public-name-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")

interface PackageJson {
  name?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  exports?: Record<string, string>
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as PackageJson

/**
 * The frozen public surface, in `package.json` order. It lives in a JSON
 * fixture because some plugin-api subpaths are named after a provider wire
 * format, and core `.ts` code must not carry provider tokens.
 */
const PUBLIC_EXPORTS = (
  JSON.parse(readFileSync(join(import.meta.dirname, "public-exports.json"), "utf8")) as {
    exports: string[]
  }
).exports

const exportsMap = pkg.exports ?? {}

describe("architecture: @minimal-agent/core public package contract", () => {
  it("is named @minimal-agent/core", () => {
    expect(pkg.name).toBe("@minimal-agent/core")
  })

  it("has no runtime dependencies", () => {
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.peerDependencies).toBeUndefined()
    expect(pkg.optionalDependencies).toBeUndefined()
  })

  it("exports exactly the frozen public subpaths", () => {
    expect(Object.keys(exportsMap)).toEqual([...PUBLIC_EXPORTS])
  })

  it("exports no terminal presentation subpath (S29, S41)", () => {
    // These render terminal text (tool-header time, banner quota row, ANSI
    // and palette helpers). The CLI owns them. Core must not grow them back.
    const presentation = [
      "./host/tool-time",
      "./host/quota-summary",
      "./plugin-api/utils/ansi",
      "./plugin-api/utils/palette",
      "./plugin-api/utils/unified-diff",
      "./host/queue-restore",
      "./host/truncate-hint",
    ]
    expect(presentation.filter((p) => p in exportsMap)).toEqual([])
  })

  it("points every export at an existing file inside src/sdk, src/host-public, or plugin-api/src", () => {
    // src/host-public widened in (S34 exports-gap closure): the new ./host/*
    // (and, as other S34 agents land, ./host-kit/* / ./testing/*) subpaths
    // are thin `export *` forwarding barrels — the real implementation stays
    // at its current, non-public-root path (e.g. src/auth/, src/llm/). This
    // keeps the frozen-export-list rule intact while letting those modules
    // resolve from a path this rule accepts, without moving the real files.
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath === "./package.json") continue
      expect(target, subpath).toMatch(/^\.\/(src\/sdk|src\/host-public|plugin-api\/src)\/.+\.ts$/)
      expect(existsSync(join(REPO_ROOT, target)), `${subpath} -> ${target}`).toBe(true)
    }
  })

  it("keeps every plugin-api export inside plugin-api/src", () => {
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (!subpath.startsWith("./plugin-api")) continue
      expect(target.startsWith("./plugin-api/src/"), `${subpath} -> ${target}`).toBe(true)
    }
  })

  it("resolves every export by package name", () => {
    for (const [subpath, target] of Object.entries(exportsMap)) {
      const specifier = `@minimal-agent/core${subpath.slice(1)}`
      expect(Bun.resolveSync(specifier, REPO_ROOT), specifier).toBe(join(REPO_ROOT, target))
    }
  })

  it("exports no forbidden legacy transport name from any public subpath (spec 2.7)", () => {
    const offenders: string[] = []
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath === "./package.json") continue
      for (const name of forbiddenNamesIn(join(REPO_ROOT, target)))
        offenders.push(`${subpath}: ${name}`)
    }
    expect(offenders).toEqual([])
  })

  it("finds a forbidden name through an export * chain, an alias, and a type list", () => {
    const dir = mkdtempSync(join(tmpdir(), "public-name-scan-"))
    try {
      writeFileSync(
        join(dir, "leaf.ts"),
        "export interface SendOptions { a: 1 }\nexport type Other = 1\n",
      )
      writeFileSync(join(dir, "mid.ts"), 'export * from "./leaf.ts"\n')
      writeFileSync(join(dir, "alias.ts"), 'export { Other as TransportFn } from "./leaf.ts"\n')
      writeFileSync(
        join(dir, "list.ts"),
        'export type {\n  Other,\n  StreamedResponse,\n} from "./x.ts"\n',
      )
      writeFileSync(
        join(dir, "clean.ts"),
        '// export type TransportFn = 1\nexport type { Other } from "./leaf.ts"\n',
      )
      expect(forbiddenNamesIn(join(dir, "mid.ts"))).toEqual(["SendOptions"])
      expect(forbiddenNamesIn(join(dir, "alias.ts"))).toEqual(["TransportFn"])
      expect(forbiddenNamesIn(join(dir, "list.ts"))).toEqual(["StreamedResponse"])
      expect(forbiddenNamesIn(join(dir, "clean.ts"))).toEqual([])
      expect(FORBIDDEN_PUBLIC_NAMES).toEqual(["TransportFn", "SendOptions", "StreamedResponse"])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

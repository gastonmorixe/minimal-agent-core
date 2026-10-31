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
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

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

  it("points every export at an existing file inside src/sdk or plugin-api/src", () => {
    for (const [subpath, target] of Object.entries(exportsMap)) {
      if (subpath === "./package.json") continue
      expect(target, subpath).toMatch(/^\.\/(src\/sdk|plugin-api\/src)\/.+\.ts$/)
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
})

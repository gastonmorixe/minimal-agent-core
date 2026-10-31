/**
 * Architecture fitness function: `@minimal-agent/core/plugin-api` is a LEAF.
 *
 * THE RULE (Wave D-0): the shared contract package is the one artifact both
 * the host (`src/`) and the plugins tree may depend on. That only works if
 * the package itself depends on NEITHER — it imports nothing that resolves
 * into `src/` or the top-level `plugins/` tree, not even type-only. A
 * relative reach-in from `plugin-api/src/...` into the host would make the
 * package un-installable from a plugin's own repo (the Wave-G split) and
 * create a dependency cycle. Bare specifiers (`node:*`, `bun:*`, npm
 * packages, a self-import of `@minimal-agent/core/plugin-api/...`) are fine —
 * they never reach the host. A self-import of any other `@minimal-agent/core`
 * subpath (for example `@minimal-agent/core/sdk/events`) resolves into `src/`
 * through the package exports map, so it fails like a relative reach-in.
 *
 * NO BASELINE: unlike the I2/I3 ratchets this starts at zero and stays at
 * zero. A leaf has no legacy debt to ratchet down; any host import is an
 * instant FAIL.
 *
 * Scanner internals live in `src/architecture/plugin-api-leaf-scan.ts`.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  type LeafImportSite,
  reachesHostTree,
  scanPackageHostImports,
  scanSourceForHostImports,
} from "./plugin-api-leaf-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const PKG_FS_ROOT = join(REPO_ROOT, "plugin-api")
const PKG_ROOT_REL = "plugin-api"

describe("architecture: plugin-api is a leaf (imports neither src/ nor plugins/)", () => {
  it("flags a forbidden src/ reach-in (scanner red-first proof)", () => {
    // A scratch fixture string standing in for a hypothetical bad file at
    // plugin-api/src/utils/term-width.ts that reaches back into the host.
    const bad = `import { c } from "../../../src/agent.ts"\nexport const x = c`
    const sites = scanSourceForHostImports(bad, PKG_ROOT_REL, "src/utils/term-width.ts")
    expect(sites.map((s: LeafImportSite) => s.resolved)).toEqual(["src/agent.ts"])
  })

  it("flags a forbidden plugins/ reach-in (scanner red-first proof)", () => {
    // From plugin-api/src/index.ts, `../../plugins/x.ts` normalizes to the
    // top-level plugins tree (the package sits one dir deeper than src/).
    // Neutral plugin name on purpose — keeps this file I1-clean (no
    // provider token in code) so it needs no provider-scan exemption.
    const bad = `export type { T } from "../../plugins/some-plugin/adapter.ts"`
    const sites = scanSourceForHostImports(bad, PKG_ROOT_REL, "src/index.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0]?.resolved).toBe("plugins/some-plugin/adapter.ts")
    expect(sites[0]?.typeOnly).toBe(true)
  })

  it("flags a self-import of a core subpath outside plugin-api", () => {
    const bad = `import type { AgentEvent } from "@minimal-agent/core/sdk/events"`
    const sites = scanSourceForHostImports(bad, PKG_ROOT_REL, "src/index.ts")
    expect(sites).toHaveLength(1)
    expect(sites[0]?.resolved).toBe("@minimal-agent/core/sdk/events")
    expect(sites[0]?.typeOnly).toBe(true)
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "@minimal-agent/core")).toBe(true)
    // A look-alike package name is not the core package.
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "@minimal-agent/core-extra/x")).toBe(false)
  })

  it("does NOT flag bare specifiers or plugin-api self-imports", () => {
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "node:fs")).toBe(false)
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "bun:test")).toBe(false)
    expect(
      reachesHostTree(PKG_ROOT_REL, "src/index.ts", "@minimal-agent/core/plugin-api/utils/jsonc"),
    ).toBe(false)
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "@minimal-agent/core/plugin-api")).toBe(
      false,
    )
    // A relative import that stays INSIDE the package is legal.
    expect(reachesHostTree(PKG_ROOT_REL, "src/index.ts", "./utils/term-width.ts")).toBe(false)
  })

  it("the real plugin-api package has ZERO host imports", () => {
    const sites = scanPackageHostImports(PKG_FS_ROOT, PKG_ROOT_REL)
    expect(
      sites.map((s) => `${s.file} -> ${s.specifier} (resolves ${s.resolved})`),
      `plugin-api reached into the host tree. The leaf contract package must import ` +
        `nothing from src/ or plugins/ so it stays installable from a plugin's own repo:\n  ` +
        sites.map((s) => `${s.file} -> ${s.specifier}`).join("\n  "),
    ).toEqual([])
  })
})

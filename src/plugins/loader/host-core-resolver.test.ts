import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  exportedSpecifiers,
  foreignCoreCopyFilter,
  installHostCoreResolver,
} from "./host-core-resolver.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../..")

describe("installHostCoreResolver", () => {
  it("finds the running core package and serves every exports key", () => {
    const resolver = installHostCoreResolver()
    expect(resolver.root).toBe(REPO_ROOT)
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, string>
    }
    // A pattern key would be skipped. This fails if one is added, so the
    // resolver is extended in the same change.
    expect(resolver.specifiers).toEqual(
      Object.keys(pkg.exports).map((key) => `@minimal-agent/core${key.slice(1)}`),
    )
  })

  it("installs once per process", () => {
    expect(installHostCoreResolver()).toBe(installHostCoreResolver())
  })

  it("serves JSON exports with the usual default export", async () => {
    installHostCoreResolver()
    const pkg = (await import("@minimal-agent/core/package.json")) as {
      default: { name: string }
    }
    expect(pkg.default.name).toBe("@minimal-agent/core")
  })
})

describe("exportedSpecifiers", () => {
  it("maps each subpath key to a bare specifier and skips pattern keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-exports-"))
    try {
      const pkgPath = join(dir, "package.json")
      writeFileSync(
        pkgPath,
        JSON.stringify({
          exports: { ".": "./a.ts", "./x": "./x.ts", "./y/*": "./y/*.ts", "./package.json": "./p" },
        }),
      )
      expect(exportedSpecifiers(pkgPath)).toEqual([
        "@minimal-agent/core",
        "@minimal-agent/core/x",
        "@minimal-agent/core/package.json",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("foreignCoreCopyFilter", () => {
  const filter = foreignCoreCopyFilter("/app/node_modules/@minimal-agent/core")

  it("matches files of another core copy", () => {
    expect(filter.test("/p/node_modules/@minimal-agent/core/plugin-api/src/index.ts")).toBe(true)
    expect(filter.test("/app/plugins/x/node_modules/@minimal-agent/core/a.ts")).toBe(true)
    expect(filter.test(String.raw`C:\p\node_modules\@minimal-agent\core\a.ts`)).toBe(true)
  })

  it("does not match the host's own files or other packages", () => {
    expect(filter.test("/app/node_modules/@minimal-agent/core/src/a.ts")).toBe(false)
    expect(filter.test("/p/node_modules/@minimal-agent/core-extra/a.ts")).toBe(false)
    expect(filter.test("/p/src/a.ts")).toBe(false)
  })

  it("escapes regex characters in the host root", () => {
    const special = foreignCoreCopyFilter("/a+b (1)/node_modules/@minimal-agent/core")
    expect(special.test("/a+b (1)/node_modules/@minimal-agent/core/a.ts")).toBe(false)
    expect(special.test("/aab 1/node_modules/@minimal-agent/core/a.ts")).toBe(true)
  })
})

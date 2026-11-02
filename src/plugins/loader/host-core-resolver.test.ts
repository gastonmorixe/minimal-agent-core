import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "bun:test"

import * as hostErrors from "@minimal-agent/core/plugin-api/llm/errors"

import * as relativeErrors from "../../../plugin-api/src/llm/errors.ts"

import { HOST_CORE_MODULES } from "./host-core-modules.ts"
import {
  HOST_CORE_MODULES_PATH,
  hostCoreModuleEntries,
  renderHostCoreModules,
} from "./host-core-modules-render.ts"
import {
  asModuleExports,
  foreignCoreCopyFilter,
  installHostCoreResolver,
  isStandaloneExecutable,
} from "./host-core-resolver.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../..")

function packageExports(): Record<string, unknown> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    exports: Record<string, unknown>
  }
  return pkg.exports
}

describe("installHostCoreResolver", () => {
  it("finds the running core package and serves every exports key", () => {
    const resolver = installHostCoreResolver()
    expect(resolver.root).toBe(REPO_ROOT)
    expect(resolver.specifiers).toEqual(
      Object.keys(packageExports()).map((key) => `@minimal-agent/core${key.slice(1)}`),
    )
  })

  it("is not a compiled binary under bun test", () => {
    expect(isStandaloneExecutable()).toBe(false)
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

describe("HOST_CORE_MODULES", () => {
  it("matches the exports map (run `bun run gen:host-core-modules` when this fails)", () => {
    const committed = readFileSync(join(REPO_ROOT, HOST_CORE_MODULES_PATH), "utf8")
    expect(committed).toBe(renderHostCoreModules(packageExports()))
  })

  it("loads the host's own module instance", () => {
    // Compare with a relative import. A bare import of the specifier can be
    // the resolver's virtual module (a different namespace object over the
    // same values) when another test file installed the resolver first.
    const load = HOST_CORE_MODULES["@minimal-agent/core/plugin-api/llm/errors"]
    expect(load).toBeDefined()
    expect(load?.()).toBe(relativeErrors)
    expect(hostErrors.ProviderError).toBe(relativeErrors.ProviderError)
  })

  it("loads every export target synchronously (no top-level await in a public module)", () => {
    for (const [specifier, load] of Object.entries(HOST_CORE_MODULES)) {
      // A module with top-level await makes require() throw, so the loader
      // must return. The JSON export may come back as a namespace or a plain
      // object, depending on whether something imported it before;
      // asModuleExports handles both.
      // A type-only module (e.g. sdk/messages) has no runtime exports.
      const exports = asModuleExports(load())
      if (specifier.endsWith("/package.json")) {
        expect((exports.default as { name?: unknown }).name, specifier).toBe("@minimal-agent/core")
      }
    }
  })

  it("serves a core subpath to require() from a plugin file", () => {
    installHostCoreResolver()
    const viaRequire = require("@minimal-agent/core/plugin-api/llm/errors") as typeof relativeErrors
    expect(viaRequire.ProviderError).toBe(relativeErrors.ProviderError)
  })
})

describe("hostCoreModuleEntries", () => {
  it("maps each key to a bare specifier and a path from the generated file", () => {
    expect(hostCoreModuleEntries({ ".": "./src/a.ts", "./x": "./plugin-api/src/x.ts" })).toEqual([
      { specifier: "@minimal-agent/core", importPath: "../../../src/a.ts" },
      { specifier: "@minimal-agent/core/x", importPath: "../../../plugin-api/src/x.ts" },
    ])
  })

  it("refuses pattern keys and non-path targets", () => {
    expect(() => hostCoreModuleEntries({ "./y/*": "./y/*.ts" })).toThrow(/exact subpath/)
    expect(() => hostCoreModuleEntries({ "./c": { import: "./c.ts" } })).toThrow(/"\.\/" path/)
  })
})

describe("asModuleExports", () => {
  it("passes a module namespace through", async () => {
    expect(asModuleExports(hostErrors)).toBe(hostErrors as Record<string, unknown>)
  })

  it("wraps a plain value as default plus named keys", () => {
    const value = { a: 1 }
    expect(asModuleExports(value)).toEqual({ a: 1, default: value })
    expect(asModuleExports("x")).toEqual({ default: "x" })
  })

  it("keeps the real default of a compiled binary's ES module object", () => {
    // Shape of `require()` of an ES module inside `bun build --compile`: a
    // plain object with a non-enumerable `__esModule: true` marker.
    function hello(): string {
      return "hi"
    }
    const mod = { default: hello, named: 1 }
    Object.defineProperty(mod, "__esModule", { value: true, enumerable: false })
    expect(asModuleExports(mod)).toEqual({ default: hello, named: 1 })
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

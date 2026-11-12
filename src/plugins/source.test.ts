import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { parseManifest } from "./manifest.ts"
import {
  clearEmbeddedPlugins,
  diskPluginPackage,
  type EmbeddedPluginTable,
  embeddedPluginPackages,
  findEmbeddedScript,
  hasEmbeddedPlugins,
  materializeEmbedded,
  normalizePackagePath,
  pluginPackageFor,
  pruneEmbeddedCache,
  registerEmbeddedPlugins,
} from "./source.ts"

let scratch: string

beforeEach(() => {
  scratch = join(tmpdir(), `ma-source-${process.pid}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(scratch, { recursive: true })
})

afterEach(() => {
  clearEmbeddedPlugins()
  rmSync(scratch, { recursive: true, force: true })
})

/** A table with one package; `gather.sh` points at a file outside any package. */
function table(buildId = "build-1"): EmbeddedPluginTable {
  const asset = join(scratch, "assets", "gather-x1.sh")
  mkdirSync(join(scratch, "assets"), { recursive: true })
  writeFileSync(asset, "#!/bin/sh\necho gathered\n")
  return {
    buildId,
    packages: {
      "ma-x-plugin": {
        texts: {
          "manifest.json": JSON.stringify({ id: "ma-x", scripts: { run: "./bin/run.ts" } }),
          "PROMPT.md": "# X\nbody",
        },
        modules: {
          "handlers/a.ts": () => Promise.resolve({ default: () => "a" }),
          "bin/run.ts": () => Promise.resolve({ main: () => 0 }),
        },
        files: { "gather.sh": asset },
      },
    },
  }
}

describe("normalizePackagePath", () => {
  it("strips ./ and collapses inner ..", () => {
    expect(normalizePackagePath("./handlers/a.ts")).toBe("handlers/a.ts")
    expect(normalizePackagePath("handlers/../lib/b.ts")).toBe("lib/b.ts")
    expect(normalizePackagePath("PROMPT.md")).toBe("PROMPT.md")
  })

  it("rejects absolute, escaping, empty, and odd paths", () => {
    for (const bad of ["", "/abs.ts", "../x.ts", "a/../../x", ".", "a\\b.ts", "dir/", "a\0b"]) {
      expect(normalizePackagePath(bad)).toBeNull()
    }
  })
})

describe("disk PluginPackage", () => {
  it("reads, checks, imports, and resolves files like the old loader code", async () => {
    const dir = join(scratch, "ma-d-plugin")
    mkdirSync(join(dir, "handlers"), { recursive: true })
    writeFileSync(join(dir, "PROMPT.md"), "hello")
    writeFileSync(join(dir, "handlers", "h.ts"), "export default () => 42\n")
    const pkg = diskPluginPackage(dir, "user")
    expect(pkg.kind).toBe("disk")
    expect(pkg.root).toBe("user")
    expect(pkg.name).toBe("ma-d-plugin")
    expect(pkg.readText("./PROMPT.md")).toBe("hello")
    expect(pkg.readText("./missing.md")).toBeNull()
    expect(pkg.hasFile("./handlers/h.ts")).toBe(true)
    expect(pkg.hasFile("./nope.ts")).toBe(false)
    expect(pkg.resolve("./handlers/h.ts")).toBe(join(dir, "handlers", "h.ts"))
    expect(pkg.resolve("/abs/x")).toBe("/abs/x")
    expect(pkg.execPath("./gather.sh")).toBe(join(dir, "gather.sh"))
    const mod = (await pkg.importModule("./handlers/h.ts")) as { default: () => number }
    expect(mod.default()).toBe(42)
  })

  it("materializeEmbedded passes a disk package through and writes nothing", () => {
    const dir = join(scratch, "ma-d-plugin")
    const pkg = diskPluginPackage(dir)
    expect(materializeEmbedded(pkg, "./gather.sh")).toBe(join(dir, "gather.sh"))
    expect(existsSync(dir)).toBe(false)
  })

  it("pluginPackageFor gives a disk package when no table is registered", () => {
    expect(hasEmbeddedPlugins()).toBe(false)
    expect(pluginPackageFor("/some/dir").kind).toBe("disk")
    expect(embeddedPluginPackages()).toEqual([])
  })
})

describe("embedded PluginPackage", () => {
  it("serves texts, modules, and files from the table", async () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    if (!pkg) throw new Error("no package")
    expect(pkg.kind).toBe("embedded")
    expect(pkg.root).toBe("embedded")
    expect(pkg.name).toBe("ma-x-plugin")
    expect(pkg.dir).toBe(join(scratch, "cache", "build-1", "ma-x-plugin"))
    expect(pkg.readText("./PROMPT.md")).toBe("# X\nbody")
    expect(pkg.readText("gather.sh")).toContain("gathered")
    expect(pkg.readText("./nope.md")).toBeNull()
    expect(pkg.readText("../escape.md")).toBeNull()
    expect(pkg.hasFile("./handlers/a.ts")).toBe(true)
    expect(pkg.hasFile("./handlers/zzz.ts")).toBe(false)
    expect(pkg.resolve("./handlers/a.ts")).toBe(join(pkg.dir, "handlers", "a.ts"))
    const mod = (await pkg.importModule("./handlers/a.ts")) as { default: () => string }
    expect(mod.default()).toBe("a")
    await expect(pkg.importModule("./handlers/zzz.ts")).rejects.toThrow("embedded module not found")
    // Nothing on disk until a file is run.
    expect(existsSync(pkg.dir)).toBe(false)
    expect(pluginPackageFor(pkg.dir)).toBe(pkg)
  })

  it("does not treat inherited properties as table entries", () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    expect(pkg?.hasFile("constructor")).toBe(false)
    expect(pkg?.readText("toString")).toBeNull()
  })

  it("rejects a malformed table", () => {
    const bad = (t: unknown) => () => registerEmbeddedPlugins(t as EmbeddedPluginTable)
    expect(bad({ buildId: "../x", packages: {} })).toThrow(TypeError)
    expect(
      bad({ buildId: "b", packages: { "../p": { texts: {}, modules: {}, files: {} } } }),
    ).toThrow(TypeError)
    expect(
      bad({ buildId: "b", packages: { p: { texts: { "./m.json": "" }, modules: {}, files: {} } } }),
    ).toThrow("normalized")
    expect(
      bad({ buildId: "b", packages: { p: { texts: {}, modules: { "a.ts": "x" }, files: {} } } }),
    ).toThrow("function")
    expect(hasEmbeddedPlugins()).toBe(false)
  })
})

describe("materializeEmbedded", () => {
  it("extracts once with the exec bit and reuses the file", () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    if (!pkg) throw new Error("no package")
    const first = pkg.execPath("./gather.sh")
    expect(first).toBe(join(pkg.dir, "gather.sh"))
    expect(readFileSync(first, "utf-8")).toContain("gathered")
    expect(statSync(first).mode & 0o777).toBe(0o755)
    const before = statSync(first).mtimeMs
    const second = materializeEmbedded(pkg, "gather.sh")
    expect(second).toBe(first)
    expect(statSync(second).mtimeMs).toBe(before)
  })

  it("runs the extracted file", async () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    const path = pkg?.execPath("gather.sh") ?? ""
    const proc = Bun.spawn([path], { stdout: "pipe" })
    expect((await new Response(proc.stdout).text()).trim()).toBe("gathered")
    expect(await proc.exited).toBe(0)
  })

  it("rewrites a file whose mode or size changed", () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    if (!pkg) throw new Error("no package")
    const path = materializeEmbedded(pkg, "gather.sh")
    writeFileSync(path, "x", { mode: 0o644 })
    materializeEmbedded(pkg, "gather.sh")
    expect(readFileSync(path, "utf-8")).toContain("gathered")
    expect(statSync(path).mode & 0o777).toBe(0o755)
  })

  it("throws for a file the package does not hold", () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const [pkg] = embeddedPluginPackages()
    if (!pkg) throw new Error("no package")
    expect(() => materializeEmbedded(pkg, "nope.sh")).toThrow("embedded file not found")
    expect(() => materializeEmbedded(pkg, "../x")).toThrow("embedded file not found")
  })

  it("puts a new buildId in a new dir and prunes old builds", () => {
    const cacheRoot = join(scratch, "cache")
    registerEmbeddedPlugins(table("build-1"), { cacheRoot })
    const old = embeddedPluginPackages()[0]?.execPath("gather.sh") ?? ""
    registerEmbeddedPlugins(table("build-2"), { cacheRoot })
    const now = embeddedPluginPackages()[0]?.execPath("gather.sh") ?? ""
    expect(now).not.toBe(old)
    expect(now).toContain(join("build-2", "ma-x-plugin"))
    expect(pruneEmbeddedCache()).toEqual([join(cacheRoot, "build-1")])
    expect(existsSync(old)).toBe(false)
    expect(existsSync(now)).toBe(true)
  })
})

describe("findEmbeddedScript", () => {
  it("finds a declared script by <manifest id>/<name> and nothing else", async () => {
    registerEmbeddedPlugins(table(), { cacheRoot: join(scratch, "cache") })
    const thunk = findEmbeddedScript("ma-x/run")
    if (!thunk) throw new Error("script not found")
    expect(((await thunk()) as { main: () => number }).main()).toBe(0)
    expect(findEmbeddedScript("ma-x/nope")).toBeUndefined()
    expect(findEmbeddedScript("ma-y/run")).toBeUndefined()
    expect(findEmbeddedScript("../etc/passwd")).toBeUndefined()
    expect(findEmbeddedScript("/tmp/x.ts")).toBeUndefined()
  })
})

describe("manifest scripts", () => {
  const base = { id: "ma-bg", name: "bg", version: "0.1.0", description: "d" }

  it("keeps a valid scripts map", () => {
    const m = parseManifest({ ...base, scripts: { runner: "./bin/runner.ts" } }, "/m.json")
    expect(m.scripts).toEqual({ runner: "./bin/runner.ts" })
  })

  it("omits an absent or empty map", () => {
    expect(parseManifest(base, "/m.json").scripts).toBeUndefined()
    expect(parseManifest({ ...base, scripts: {} }, "/m.json").scripts).toBeUndefined()
  })

  it("rejects bad shapes, names, and paths", () => {
    const bad = (scripts: unknown) => () => parseManifest({ ...base, scripts }, "/m.json")
    expect(bad([])).toThrow("scripts must be an object")
    expect(bad("x")).toThrow("scripts must be an object")
    expect(bad({ "Bad.Name": "./a.ts" })).toThrow("name")
    expect(bad({ "a/b": "./a.ts" })).toThrow("name")
    expect(bad({ runner: 1 })).toThrow("relative path")
    expect(bad({ runner: "/abs/a.ts" })).toThrow("relative path")
    expect(bad({ runner: "../a.ts" })).toThrow("relative path")
  })
})

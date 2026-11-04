/**
 * SPEC-HELP M-5: the CLI catalog returns `cli` and host-mode help data,
 * applies the loader's platform and `hostMode:stdio` gates, and never
 * imports a handler module.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { buildPluginCliCatalog, type CatalogOverridesInput } from "./catalog.ts"

const FIXTURES = join(import.meta.dir, "catalog-fixtures", "plugins")
const IMPORTED_FLAG = "__maCatalogFixtureImported"

function noOverrides(): CatalogOverridesInput {
  return { config: { forceDisabled: new Set(), forceEnabled: new Set() } }
}

function build(
  overrides: CatalogOverridesInput = noOverrides(),
  platform: "macos" | "linux" | "windows" | "all" = "linux",
) {
  const warnings: string[] = []
  const rows = buildPluginCliCatalog({ embedded: [FIXTURES] }, overrides, {
    effectivePlatform: platform,
    warn: (msg) => warnings.push(msg),
  })
  return { rows, warnings }
}

function row(rows: ReturnType<typeof build>["rows"], id: string) {
  const found = rows.find((r) => r.pluginId === id)
  if (!found) throw new Error(`no catalog row for ${id}`)
  return found
}

describe("buildPluginCliCatalog", () => {
  test("returns the cli block and host-mode help of an enabled plugin", () => {
    const { rows } = build()
    const ok = row(rows, "ma-help-ok")
    expect(ok.root).toBe("embedded")
    expect(ok.effectiveOn).toBe(true)
    expect(ok.note).toBe("")
    expect(ok.cli?.contractVersion).toBe(1)
    expect(ok.cli?.commands?.[0]?.name).toBe("okcmd")
    expect(ok.cli?.commands?.[0]?.args).toEqual([
      { name: "target", summary: "Target name", required: true },
    ])
    expect(ok.cli?.helpSections?.[0]?.title).toBe("OK NOTES")
    expect(ok.hostModes).toEqual([
      {
        id: "okmode",
        description: "Ok host mode",
        args: [{ name: "port", summary: "Port number" }],
        examples: [{ argv: "--host-mode okmode 8080", summary: "Serve on 8080" }],
      },
    ])
  })

  test("rows are sorted by plugin id and JSON-safe", () => {
    const { rows } = build()
    expect(rows.map((r) => r.pluginId)).toEqual([
      "ma-help-badcli",
      "ma-help-macos",
      "ma-help-nostdio",
      "ma-help-ok",
    ])
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows)
  })

  test("platform gate: a whitelisted-out plugin stays listed, off, note platform", () => {
    const { rows } = build(noOverrides(), "linux")
    const mac = row(rows, "ma-help-macos")
    expect(mac.effectiveOn).toBe(false)
    expect(mac.note).toBe("platform")
    expect(mac.cli?.commands?.[0]?.name).toBe("maccmd")
    expect(mac.hostModes.map((h) => h.id)).toEqual(["macmode"])
  })

  test("platform gate: the matching platform and the all bypass keep it on", () => {
    expect(row(build(noOverrides(), "macos").rows, "ma-help-macos").effectiveOn).toBe(true)
    expect(row(build(noOverrides(), "all").rows, "ma-help-macos").effectiveOn).toBe(true)
  })

  test("platform gate: a force-enable does not revive a gated plugin (loader parity)", () => {
    const overrides: CatalogOverridesInput = {
      config: { forceDisabled: new Set(), forceEnabled: new Set(["ma-help-macos"]) },
      cliArgs: ["--enable-plugin", "ma-help-macos"],
    }
    const mac = row(build(overrides, "windows").rows, "ma-help-macos")
    expect(mac.effectiveOn).toBe(false)
    expect(mac.note).toBe("platform")
  })

  test("an override disable keeps its own note before the platform gate", () => {
    const overrides: CatalogOverridesInput = {
      ...noOverrides(),
      env: { disable: "ma-help-macos" },
    }
    const mac = row(build(overrides, "linux").rows, "ma-help-macos")
    expect(mac.effectiveOn).toBe(false)
    expect(mac.note).toBe("env")
  })

  test("permission gate: host modes without hostMode:stdio are disabled, not removed", () => {
    const { rows } = build()
    const nostdio = row(rows, "ma-help-nostdio")
    expect(nostdio.effectiveOn).toBe(true)
    expect(nostdio.hostModes).toEqual([
      { id: "nostdiomode", description: "Host mode the loader skips", disabled: "permission" },
    ])
    expect(row(rows, "ma-help-ok").hostModes[0]?.disabled).toBeUndefined()
  })

  test("parseCli and host-mode diagnostics go to the warn sink", () => {
    const { rows, warnings } = build()
    const bad = row(rows, "ma-help-badcli")
    expect(bad.effectiveOn).toBe(true)
    expect(bad.cli).toBeUndefined()
    expect(bad.hostModes).toEqual([
      { id: "badexmode", description: "Host mode with a bad example" },
    ])
    expect(warnings.some((w) => /cli block dropped .*unknown contract version 99/.test(w))).toBe(
      true,
    )
    expect(warnings.some((w) => /hostModes\[0\]\.examples dropped/.test(w))).toBe(true)
  })

  test("never imports a handler module: fixture handlers throw on import", async () => {
    delete (globalThis as Record<string, unknown>)[IMPORTED_FLAG]
    const { rows } = build(noOverrides(), "all")
    expect(rows).toHaveLength(4)
    expect(rows.every((r) => r.effectiveOn)).toBe(true)
    // A fire-and-forget `import()` would set the flag on a later tick.
    // Let pending microtasks and macrotasks run before the check.
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect((globalThis as Record<string, unknown>)[IMPORTED_FLAG]).toBeUndefined()
  })

  test("structured cli input: a disable list turns the plugin off with note cli", () => {
    const overrides: CatalogOverridesInput = { ...noOverrides(), cli: { disable: ["ma-help-ok"] } }
    const ok = row(build(overrides).rows, "ma-help-ok")
    expect(ok.effectiveOn).toBe(false)
    expect(ok.note).toBe("cli")
  })

  test("structured cli input: an enable list sets note cli and keeps the plugin on", () => {
    const overrides: CatalogOverridesInput = { ...noOverrides(), cli: { enable: ["ma-help-ok"] } }
    const ok = row(build(overrides).rows, "ma-help-ok")
    expect(ok.effectiveOn).toBe(true)
    expect(ok.note).toBe("cli")
  })

  test("structured cli input wins over cliArgs (cliArgs is ignored)", () => {
    const overrides: CatalogOverridesInput = {
      ...noOverrides(),
      cliArgs: ["--disable-plugin", "ma-help-nostdio"],
      cli: { disable: ["ma-help-ok"] },
    }
    const { rows } = build(overrides)
    expect(row(rows, "ma-help-ok").effectiveOn).toBe(false)
    expect(row(rows, "ma-help-nostdio").effectiveOn).toBe(true)
    expect(row(rows, "ma-help-nostdio").note).toBe("")
  })

  test("structured cli disable beats an env enable (CLI layer is last)", () => {
    const overrides: CatalogOverridesInput = {
      ...noOverrides(),
      env: { enable: "ma-help-ok" },
      cli: { disable: ["ma-help-ok"] },
    }
    const ok = row(build(overrides).rows, "ma-help-ok")
    expect(ok.effectiveOn).toBe(false)
    expect(ok.note).toBe("cli")
  })

  test("the fixture handler does throw when imported (guards the proof above)", async () => {
    const path = join(FIXTURES, "ma-help-ok", "throws.ts")
    await expect(import(path)).rejects.toThrow("catalog fixture handler was imported")
    delete (globalThis as Record<string, unknown>)[IMPORTED_FLAG]
  })
})

describe("buildPluginCliCatalog with invalid manifests", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-catalog-cli-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writeRaw(root: string, name: string, text: string): string {
    const pkg = join(dir, root, name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "manifest.json"), text)
    return join(dir, root)
  }

  function writePlugin(root: string, name: string, manifest: Record<string, unknown>): string {
    return writeRaw(root, name, JSON.stringify(manifest))
  }

  const valid = { id: "dup", name: "Dup", version: "0.1.0", description: "Valid copy" }

  test("an invalid manifest is listed off with note invalid", () => {
    const root = writePlugin("emb", "broken", { id: "broken", name: "Broken" })
    const warnings: string[] = []
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), {
      warn: (m) => warnings.push(m),
    })
    expect(rows).toEqual([
      { pluginId: "broken", root: "embedded", effectiveOn: false, note: "invalid", hostModes: [] },
    ])
    expect(warnings.some((w) => /catalog marks plugin "broken" invalid/.test(w))).toBe(true)
  })

  test("an invalid higher-root copy does not shadow a valid lower-root copy (loader parity)", () => {
    const project = writePlugin("proj", "dup", { id: "dup" })
    const embedded = writePlugin("emb", "dup", valid)
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        warn: () => {},
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.root).toBe("embedded")
    expect(rows[0]?.effectiveOn).toBe(true)
  })

  test("a valid higher-root copy wins over a lower-root copy", () => {
    const project = writePlugin("proj", "dup", { ...valid, description: "Project copy" })
    const embedded = writePlugin("emb", "dup", valid)
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        warn: () => {},
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.root).toBe("project")
  })

  test("a manifest-disabled higher-root copy reserves its id (loader parity)", () => {
    const project = writePlugin("proj", "dup", { ...valid, enabled: false })
    const embedded = writePlugin("emb", "dup", valid)
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        warn: () => {},
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.root).toBe("project")
    expect(rows[0]?.effectiveOn).toBe(false)
    expect(rows[0]?.note).toBe("manifest")
  })

  test("a platform-gated higher-root copy reserves its id (loader parity)", () => {
    const project = writePlugin("proj", "dup", { ...valid, platforms: ["macos"] })
    const embedded = writePlugin("emb", "dup", valid)
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        effectivePlatform: "linux",
        warn: () => {},
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.root).toBe("project")
    expect(rows[0]?.effectiveOn).toBe(false)
    expect(rows[0]?.note).toBe("platform")
  })

  test("manifest opt-out plus a platform gate gives note manifest", () => {
    const root = writePlugin("emb", "dup", { ...valid, enabled: false, platforms: ["macos"] })
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), {
      effectivePlatform: "linux",
      warn: () => {},
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.effectiveOn).toBe(false)
    expect(rows[0]?.note).toBe("manifest")
  })

  test("a manifest that is not valid JSON is not listed (loader parity)", () => {
    const root = writeRaw("emb", "garbage", "{ not json")
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), { warn: () => {} })
    expect(rows).toEqual([])
  })

  test("a non-JSON higher-root copy does not shadow a valid lower-root copy", () => {
    const project = writeRaw("proj", "dup", "{ not json")
    const embedded = writePlugin("emb", "dup", valid)
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        warn: () => {},
      },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.root).toBe("embedded")
    expect(rows[0]?.effectiveOn).toBe(true)
  })
})

describe("buildPluginCliCatalog host-mode id collisions", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-catalog-hm-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write a plugin that declares one host mode with the given id. */
  function writeHostModePlugin(
    root: string,
    name: string,
    id: string,
    hostModeId: string,
    extra: Record<string, unknown> = {},
  ): string {
    const pkg = join(dir, root, name)
    mkdirSync(pkg, { recursive: true })
    writeFileSync(
      join(pkg, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "0.1.0",
        description: `${id} fixture`,
        permissions: ["hostMode:stdio"],
        headless: {
          hostModes: [
            {
              id: hostModeId,
              description: `${id} host mode`,
              entry: { type: "module", path: "./missing.ts" },
            },
          ],
        },
        ...extra,
      }),
    )
    return join(dir, root)
  }

  function hostModeOf(rows: ReturnType<typeof buildPluginCliCatalog>, id: string) {
    return rows.find((r) => r.pluginId === id)?.hostModes[0]
  }

  test("same root: the first package dir name wins, not the first plugin id", () => {
    // Loader order is dir name ("a-dir" first). Sorted output order is
    // plugin id ("aa-second" first). The loader keeps "zz-first".
    writeHostModePlugin("emb", "a-dir", "zz-first", "shared")
    const root = writeHostModePlugin("emb", "b-dir", "aa-second", "shared")
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), { warn: () => {} })
    expect(rows.map((r) => r.pluginId)).toEqual(["aa-second", "zz-first"])
    expect(hostModeOf(rows, "zz-first")?.disabled).toBeUndefined()
    expect(hostModeOf(rows, "aa-second")?.disabled).toBe("collision")
  })

  test("across roots: the higher-precedence root wins", () => {
    const project = writeHostModePlugin("proj", "z-dir", "zz-project", "shared")
    const embedded = writeHostModePlugin("emb", "a-dir", "aa-embedded", "shared")
    const rows = buildPluginCliCatalog(
      { project: [project], embedded: [embedded] },
      noOverrides(),
      {
        warn: () => {},
      },
    )
    expect(hostModeOf(rows, "zz-project")?.disabled).toBeUndefined()
    expect(hostModeOf(rows, "aa-embedded")?.disabled).toBe("collision")
  })

  test("an off plugin does not claim the id", () => {
    writeHostModePlugin("emb", "a-dir", "zz-first", "shared", { enabled: false })
    const root = writeHostModePlugin("emb", "b-dir", "aa-second", "shared")
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), { warn: () => {} })
    expect(hostModeOf(rows, "aa-second")?.disabled).toBeUndefined()
  })

  test("a host mode without hostMode:stdio does not claim the id", () => {
    writeHostModePlugin("emb", "a-dir", "zz-first", "shared", { permissions: [] })
    const root = writeHostModePlugin("emb", "b-dir", "aa-second", "shared")
    const rows = buildPluginCliCatalog({ embedded: [root] }, noOverrides(), { warn: () => {} })
    expect(hostModeOf(rows, "zz-first")?.disabled).toBe("permission")
    expect(hostModeOf(rows, "aa-second")?.disabled).toBeUndefined()
  })
})

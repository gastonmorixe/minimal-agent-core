/**
 * Loader integration: a plugin from a registered embedded table loads with
 * no package files on disk, and a disk copy of the same id wins.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { registerDiscoveredProviders } from "../llm/provider-discovery.ts"
import { clearProviderPlugins, listProviderPlugins } from "../llm/provider-plugin.ts"
import { SIDEBAND_FIXTURE_PLUGIN_ID, withSidebandCodec } from "../test-utils/sideband-fixture.ts"

import { buildPluginCatalog } from "./catalog.ts"
import { loadPluginCliCommand } from "./cli-command-loader.ts"
import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import {
  clearEmbeddedPlugins,
  type EmbeddedPluginTable,
  registerEmbeddedPlugins,
} from "./source.ts"

const CORE_TOOLS = new Set(["Bash", "Read"])

let scratch: string
let cacheRoot: string

beforeEach(() => {
  scratch = join(tmpdir(), `ma-embedded-${process.pid}-${Math.random().toString(36).slice(2)}`)
  cacheRoot = join(scratch, "cache")
  mkdirSync(scratch, { recursive: true })
})

afterEach(() => {
  clearEmbeddedPlugins()
  clearProviderPlugins()
  rmSync(scratch, { recursive: true, force: true })
})

/** One embedded package with a tool, a slash command, a module fragment, a probe, and a CLI command. */
function fakeTable(promptBody = "# Emb\n\nEMBEDDED_PROMPT"): EmbeddedPluginTable {
  const probe = join(scratch, "bunfs", "probe-abc.sh")
  mkdirSync(join(scratch, "bunfs"), { recursive: true })
  writeFileSync(probe, '#!/bin/sh\necho "PROBE_RAN in $TUI_PLUGIN_DIR"\n')
  const manifest = {
    id: "ma-emb",
    name: "Emb",
    version: "0.1.0",
    description: "embedded fixture",
    scripts: { runner: "./bin/runner.ts" },
    cli: {
      contractVersion: 1,
      commands: [{ name: "go", summary: "Go", handler: { type: "module", path: "./cli/go.ts" } }],
    },
    headless: {
      tools: [
        {
          id: "echo",
          interactive: false,
          trigger: {
            type: "tool",
            tool: {
              name: "emb_echo",
              explicitName: true,
              description: "echo",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "module", path: "./handlers/echo.ts" },
        },
      ],
      commands: [{ name: "emb", summary: "emb", handler: { type: "module", path: "./cmd.ts" } }],
      promptFragments: [
        { id: "frag", handler: { type: "module", path: "./frag.ts" } },
        { id: "probe", handler: { type: "subprocess", command: ["./probe.sh"] } },
      ],
    },
  }
  return {
    buildId: "test-build",
    packages: {
      "ma-emb-plugin": {
        texts: { "manifest.json": JSON.stringify(manifest), "PROMPT.md": promptBody },
        modules: {
          "handlers/echo.ts": async () => ({
            default: (ctx: { packageDir: string }) => ({
              kind: "tool_result",
              content: `EMBEDDED_ECHO dir=${ctx.packageDir}`,
            }),
          }),
          "cmd.ts": async () => ({ default: () => ({ kind: "notice", lines: ["EMB_CMD"] }) }),
          "frag.ts": async () => ({ default: () => "EMBEDDED_FRAGMENT" }),
          "cli/go.ts": async () => ({ default: () => 0 }),
          "bin/runner.ts": async () => ({ main: () => 0 }),
        },
        files: { "probe.sh": probe },
      },
      "ma-llm-emb-plugin": {
        texts: {
          "provider.json": JSON.stringify({ id: "emb", entry: "./index.ts", export: "plugin" }),
        },
        modules: {
          "index.ts": async () => ({ plugin: { id: "emb", register: () => {} } }),
        },
        files: {},
      },
    },
  }
}

/** The loaded packages without the sideband codec fixture (design step 7). */
const withoutFixture = <T extends { id: string }>(pkgs: readonly T[]): T[] =>
  pkgs.filter((p) => p.id !== SIDEBAND_FIXTURE_PLUGIN_ID)

describe("embedded plugin table", () => {
  it("loads a plugin with no files on disk for it", async () => {
    registerEmbeddedPlugins(fakeTable(), { cacheRoot })
    const pkgDir = join(cacheRoot, "test-build", "ma-emb-plugin")
    const logs: string[] = []
    const loader = await PluginLoader.load(
      withSidebandCodec({
        roots: { project: [join(scratch, "no-project")] },
        coreToolNames: CORE_TOOLS,
        logger: (m) => logs.push(m),
        allowBareCore: true,
      }),
    )
    if (loader.loadedPackages().length === 0) throw new Error(logs.join("\n"))
    expect(withoutFixture(loader.loadedPackages())).toEqual([
      { id: "ma-emb", packageDir: pkgDir, capabilities: [], permissions: [], sidebandKinds: [] },
    ])
    expect(loader.hasTool("emb_echo")).toBe(true)

    const result = await loader.dispatch(
      { type: "tool", name: "emb_echo", input: {}, tool_use_id: "t1" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe(`EMBEDDED_ECHO dir=${pkgDir}`)

    expect(await loader.dispatchCommand("/emb")).toMatchObject({
      kind: "notice",
      lines: ["EMB_CMD"],
    })

    const blocks = await loader.getPromptBlocksAsync()
    const text = `${blocks.afterInstructions ?? ""}${blocks.sessionContext ?? ""}`
    expect(text).toContain("EMBEDDED_PROMPT")
    expect(text).toContain("EMBEDDED_FRAGMENT")
    // The probe ran from the extracted copy, with TUI_PLUGIN_DIR set to it.
    expect(text).toContain(`PROBE_RAN in ${pkgDir}`)
    expect(existsSync(join(pkgDir, "probe.sh"))).toBe(true)
    // Only the run file was written: no manifest, no module.
    expect(existsSync(join(pkgDir, "manifest.json"))).toBe(false)
    expect(logs.filter((l) => l.includes("ma-emb"))).toEqual([])
  })

  it("a user-tier copy of the same id shadows the embedded one", async () => {
    registerEmbeddedPlugins(fakeTable(), { cacheRoot })
    const userRoot = join(scratch, "user")
    writePackage(
      userRoot,
      "ma-emb-plugin",
      {
        id: "ma-emb",
        name: "Emb",
        version: "0.2.0",
        description: "user copy",
      },
      { "PROMPT.md": "# Emb\n\nUSER_PROMPT" },
      "",
    )
    const logs: string[] = []
    const loader = await PluginLoader.load(
      withSidebandCodec({
        roots: { user: [userRoot] },
        coreToolNames: CORE_TOOLS,
        logger: (m) => logs.push(m),
        allowBareCore: true,
      }),
    )
    if (loader.loadedPackages().length === 0) throw new Error(logs.join("\n"))
    expect(withoutFixture(loader.loadedPackages())).toEqual([
      {
        id: "ma-emb",
        packageDir: join(userRoot, "ma-emb-plugin"),
        capabilities: [],
        permissions: [],
        sidebandKinds: [],
      },
    ])
    expect(loader.hasTool("emb_echo")).toBe(false)
    const blocks = await loader.getPromptBlocksAsync()
    const text = `${blocks.afterInstructions ?? ""}${blocks.sessionContext ?? ""}`
    expect(text).toContain("USER_PROMPT")
    expect(text).not.toContain("EMBEDDED_PROMPT")
    expect(logs.some((l) => l.includes('package id "ma-emb" already loaded'))).toBe(true)
  })

  it("keeps the enabled gate: a config disable skips the embedded plugin", async () => {
    registerEmbeddedPlugins(fakeTable(), { cacheRoot })
    const loader = await PluginLoader.load({
      coreToolNames: CORE_TOOLS,
      logger: () => {},
      disabledPluginIds: new Set(["ma-emb"]),
      allowBareCore: true,
    })
    expect(loader.loadedPackages()).toEqual([])
  })

  it("keeps the platform gate", async () => {
    const t = fakeTable()
    const entry = t.packages["ma-emb-plugin"]
    if (!entry) throw new Error("fixture")
    const m = JSON.parse(entry.texts["manifest.json"] ?? "{}") as Record<string, unknown>
    const other = process.platform === "darwin" ? "linux" : "macos"
    const gated: EmbeddedPluginTable = {
      ...t,
      packages: {
        "ma-emb-plugin": {
          ...entry,
          texts: { ...entry.texts, "manifest.json": JSON.stringify({ ...m, platforms: [other] }) },
        },
      },
    }
    registerEmbeddedPlugins(gated, { cacheRoot })
    const loader = await PluginLoader.load({
      coreToolNames: CORE_TOOLS,
      logger: () => {},
      allowBareCore: true,
    })
    expect(loader.loadedPackages()).toEqual([])
  })

  it("loads nothing extra when no table is registered", async () => {
    const loader = await PluginLoader.load({
      coreToolNames: CORE_TOOLS,
      logger: () => {},
      allowBareCore: true,
    })
    expect(loader.loadedPackages()).toEqual([])
  })

  it("lists embedded plugins in the catalog and loads an embedded CLI command", async () => {
    registerEmbeddedPlugins(fakeTable(), { cacheRoot })
    const overrides = {
      config: { forceDisabled: new Set<string>(), forceEnabled: new Set<string>() },
    }
    const rows = buildPluginCatalog({}, overrides)
    expect(rows.map((r) => [r.id, r.root])).toEqual([["ma-emb", "embedded"]])
    const loaded = await loadPluginCliCommand({
      pluginId: "ma-emb",
      path: ["go"],
      roots: {},
      overrides,
      effectivePlatform: "all",
    })
    if (!loaded.ok) throw new Error(loaded.message)
    expect(typeof loaded.handler).toBe("function")
    expect(loaded.entryAbsolute).toBe(
      join(cacheRoot, "test-build", "ma-emb-plugin", "cli", "go.ts"),
    )
  })

  it("registers embedded provider plugins after every disk root", async () => {
    registerEmbeddedPlugins(fakeTable(), { cacheRoot })
    const providerRoot = join(scratch, "providers")
    mkdirSync(join(providerRoot, "ma-llm-emb-plugin"), { recursive: true })
    writeFileSync(
      join(providerRoot, "ma-llm-emb-plugin", "provider.json"),
      JSON.stringify({ id: "emb", entry: "./index.ts", export: "plugin" }),
    )
    writeFileSync(
      join(providerRoot, "ma-llm-emb-plugin", "index.ts"),
      'export const plugin = { id: "emb", displayName: "disk", register() {} }\n',
    )
    expect(await registerDiscoveredProviders([providerRoot])).toEqual(["emb"])
    expect(listProviderPlugins().map((p) => (p as { displayName?: string }).displayName)).toEqual([
      "disk",
    ])
    clearProviderPlugins()
    expect(await registerDiscoveredProviders([])).toEqual(["emb"])
  })
})

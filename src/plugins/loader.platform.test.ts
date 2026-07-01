import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import {
  CORE_TOOLS,
  HOME,
  PROJECT,
  ROOT,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const NOPE_PROJECT = join(ROOT, "nope-project")

/** Write a single-tool plugin into HOME with a plugin-level platform whitelist. */
function platformPkg(id: string, toolName: string, platforms: string[]): void {
  const m = toolManifest(id, toolName, "./h.ts")
  m.platforms = platforms
  writePackage(HOME, id, m, { "h.ts": TOOL_HANDLER_BODY })
}

describe("PluginLoader platform gating", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
  })

  afterEach(() => {
    rmSync(join(HOME, "plugins"), { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("skips a whole plugin when the effective platform is excluded", async () => {
    platformPkg("maconly", "mac_tool", ["macos"])
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: NOPE_PROJECT,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
      effectivePlatform: "linux",
    })
    expect(loader.hasTool("mac_tool")).toBe(false)
    expect(logs.some((l) => l.includes("maconly") && l.includes("not available"))).toBe(true)
  })

  it("loads a plugin when the effective platform is listed", async () => {
    platformPkg("maconly", "mac_tool", ["macos"])
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: NOPE_PROJECT,
      coreToolNames: CORE_TOOLS,
      effectivePlatform: "macos",
    })
    expect(loader.hasTool("mac_tool")).toBe(true)
  })

  it("the `all` bypass loads a plugin regardless of whitelist", async () => {
    platformPkg("maconly", "mac_tool", ["macos"])
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: NOPE_PROJECT,
      coreToolNames: CORE_TOOLS,
      effectivePlatform: "all",
    })
    expect(loader.hasTool("mac_tool")).toBe(true)
  })

  it("drops a single tool whose own whitelist excludes the platform, keeping siblings", async () => {
    const m = toolManifest("multi", "shared_tool", "./h.ts")
    // Add a second tool gated to macos only.
    m.tuis!.push({
      id: "mac_only",
      trigger: {
        type: "tool",
        tool: {
          name: "mac_tool",
          description: "Tool mac_tool",
          input_schema: { type: "object", properties: {} },
          explicitName: true,
        },
      },
      handler: { type: "module", path: "./h.ts", export: "default" },
      interactive: false,
      platforms: ["macos"],
    })
    writePackage(HOME, "multi", m, { "h.ts": TOOL_HANDLER_BODY })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: NOPE_PROJECT,
      coreToolNames: CORE_TOOLS,
      effectivePlatform: "linux",
    })
    expect(loader.hasTool("shared_tool")).toBe(true)
    expect(loader.hasTool("mac_tool")).toBe(false)
  })

  it("loads a plugin with no whitelist on any platform", async () => {
    writePackage(HOME, "anyplat", toolManifest("anyplat", "any_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: NOPE_PROJECT,
      coreToolNames: CORE_TOOLS,
      effectivePlatform: "windows",
    })
    expect(loader.hasTool("any_tool")).toBe(true)
  })
})

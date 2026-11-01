/**
 * The manifest split, end to end through {@link PluginLoader.load} (S31).
 *
 * - A headless tool with `icon` loads, core ignores `icon`, and the loader
 *   logs one warning.
 * - Core ignores a `ui` block: no error, no tool, nothing from it reaches a
 *   loaded plugin.
 * - A legacy flat manifest still loads until S41.
 */

import { rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { CORE_TOOLS, ROOT, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const SPLIT_ROOT = join(ROOT, "manifest-split")
const HANDLER = { "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" });` }

/** One tool handler entry with the given extra fields. */
function tool(name: string, extra: Record<string, unknown> = {}) {
  return {
    id: name.toLowerCase(),
    trigger: {
      type: "tool",
      tool: {
        name,
        description: name,
        input_schema: { type: "object", properties: {} },
        explicitName: true,
      },
    },
    handler: { type: "module", path: "./h.ts", export: "default" },
    interactive: false,
    ...extra,
  }
}

const IDENTITY = { version: "0.1.0", description: "test" }

/** Load the packages under SPLIT_ROOT and capture the loader log. */
async function load() {
  const logs: string[] = []
  const loader = await PluginLoader.load({
    roots: { home: [join(SPLIT_ROOT, "plugins")] },
    coreToolNames: CORE_TOOLS,
    logger: (m) => logs.push(m),
  })
  return { loader, logs }
}

describe("manifest split (S31)", () => {
  afterEach(() => {
    rmSync(SPLIT_ROOT, { recursive: true, force: true })
  })

  it("a headless tool with icon loads, ignores icon, and logs one warning", async () => {
    writePackage(
      SPLIT_ROOT,
      "split-icon",
      {
        id: "split-icon",
        name: "split-icon",
        ...IDENTITY,
        headless: {
          tools: [
            tool("SplitA", { icon: "⤓", color: "sky" }),
            tool("SplitB", { headerKey: "url" }),
          ],
        },
      },
      HANDLER,
    )
    const { loader, logs } = await load()
    expect(loader.hasTool("SplitA")).toBe(true)
    expect(loader.hasTool("SplitB")).toBe(true)
    const def = loader.getExtraTools().find((t) => t.name === "SplitA")
    expect(def).not.toHaveProperty("icon")
    expect(def).not.toHaveProperty("color")
    const warnings = logs.filter(
      (l) => l.includes("split-icon") && l.includes("icon/color/headerKey"),
    )
    expect(warnings.length).toBe(1)
  })

  it("ignores a ui block", async () => {
    writePackage(
      SPLIT_ROOT,
      "split-ui",
      {
        id: "split-ui",
        name: "split-ui",
        ...IDENTITY,
        headless: { tools: [tool("SplitUi")] },
        ui: {
          liveAreaSlots: [{ id: "x", handler: { type: "module", path: "./missing.ts" } }],
          tools: { SplitUi: { icon: "»" } },
        },
      },
      HANDLER,
    )
    const { loader, logs } = await load()
    expect(loader.hasTool("SplitUi")).toBe(true)
    expect(logs).toEqual([])
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["split-ui"])
    expect(loader).not.toHaveProperty("getLiveAreaSlots")
  })

  it("a ui-only plugin loads with no dead-weight warning", async () => {
    writePackage(SPLIT_ROOT, "split-ui-only", {
      id: "split-ui-only",
      name: "split-ui-only",
      ...IDENTITY,
      ui: { liveAreaSlots: [] },
    })
    const { loader, logs } = await load()
    expect(loader.loadedPluginIds()).toEqual(["split-ui-only"])
    expect(logs).toEqual([])
  })

  it("a legacy flat manifest still loads, with one warning for its UI fields", async () => {
    writePackage(
      SPLIT_ROOT,
      "flat-legacy",
      {
        id: "flat-legacy",
        name: "flat-legacy",
        ...IDENTITY,
        tuis: [tool("FlatTool", { icon: "⤓", color: "sky", headerKey: "url" })],
        liveAreaSlots: [{ id: "s", handler: { type: "module", path: "./missing.ts" } }],
      },
      HANDLER,
    )
    const { loader, logs } = await load()
    expect(loader.hasTool("FlatTool")).toBe(true)
    const warnings = logs.filter((l) => l.includes("flat-legacy") && l.includes("legacy UI fields"))
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain("liveAreaSlots")
    expect(warnings[0]).toContain("icon/color/headerKey")
  })
})

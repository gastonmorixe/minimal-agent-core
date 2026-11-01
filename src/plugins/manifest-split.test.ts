/**
 * The manifest split, end to end through {@link PluginLoader.load} (S31).
 *
 * - A headless tool with `icon`, `color`, or `headerKey` is rejected with a
 *   clear error (S41), and the plugin does not load.
 * - Core ignores a `ui` block: no error, no tool, nothing from it reaches a
 *   loaded plugin.
 * - A flat (pre-S31) manifest is rejected with a clear error (S41).
 */

import { rmSync, writeFileSync } from "node:fs"
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

  it("rejects a headless tool with icon, color, or headerKey (S41)", async () => {
    writePackage(
      SPLIT_ROOT,
      "split-icon",
      {
        id: "split-icon",
        name: "split-icon",
        ...IDENTITY,
        headless: { tools: [tool("SplitA", { icon: "⤓", color: "sky", headerKey: "url" })] },
      },
      HANDLER,
    )
    const { loader, logs } = await load()
    expect(loader.hasTool("SplitA")).toBe(false)
    const errors = logs.filter(
      (l) => l.includes("split-icon") && l.includes("icon, color, headerKey are not tool fields"),
    )
    expect(errors.length).toBe(1)
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

  it("rejects a flat manifest with a clear error (S41)", async () => {
    const flat = {
      id: "flat-legacy",
      name: "flat-legacy",
      ...IDENTITY,
      tuis: [tool("FlatTool")],
      liveAreaSlots: [{ id: "s", handler: { type: "module", path: "./missing.ts" } }],
    }
    const dir = writePackage(SPLIT_ROOT, "flat-legacy", {}, HANDLER)
    // Raw write: `writePackage` would split the flat fixture.
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(flat))
    const { loader, logs } = await load()
    expect(loader.hasTool("FlatTool")).toBe(false)
    const errors = logs.filter(
      (l) => l.includes("flat-legacy") && l.includes("flat manifest keys are not supported"),
    )
    expect(errors.length).toBe(1)
    expect(errors[0]).toContain("tuis, liveAreaSlots")
  })
})

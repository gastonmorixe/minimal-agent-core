/**
 * Tests for the legacy cosmetic tool-presentation field tolerance (S29/S31):
 * {@link warnLegacyToolPresentationFields} (pure), and an end-to-end check
 * that a manifest which still sets `icon` / `color` / `headerKey` on a
 * `tuis[]` handler loads cleanly through {@link PluginLoader.load} — with
 * exactly one warning, and with those fields absent from the tool
 * definition the loader hands back.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it } from "bun:test"

import { CORE_TOOLS, ROOT, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import { warnLegacyToolPresentationFields } from "./manifest-legacy.ts"

describe("warnLegacyToolPresentationFields", () => {
  it("no-ops when tuis is absent or not an array", () => {
    const logs: string[] = []
    warnLegacyToolPresentationFields({}, "p", (m) => logs.push(m))
    warnLegacyToolPresentationFields({ tuis: "nope" }, "p", (m) => logs.push(m))
    warnLegacyToolPresentationFields(null, "p", (m) => logs.push(m))
    expect(logs).toEqual([])
  })

  it("no-ops when no handler sets icon/color/headerKey", () => {
    const logs: string[] = []
    warnLegacyToolPresentationFields({ tuis: [{ id: "a" }, { id: "b" }] }, "p", (m) => logs.push(m))
    expect(logs).toEqual([])
  })

  it("logs exactly one warning when a handler sets icon, color, or headerKey", () => {
    const logs: string[] = []
    warnLegacyToolPresentationFields(
      { tuis: [{ id: "a" }, { id: "b", icon: "»" }, { id: "c", color: "sky" }] },
      "my-plugin",
      (m) => logs.push(m),
    )
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("my-plugin")
    expect(logs[0]).toContain("icon/color/headerKey")
  })
})

const LEGACY_ROOT = join(ROOT, "manifest-legacy-home")

describe("PluginLoader — legacy cosmetic tool fields on a tuis[] handler", () => {
  beforeAll(() => {
    rmSync(LEGACY_ROOT, { recursive: true, force: true })
    mkdirSync(LEGACY_ROOT, { recursive: true })
  })

  afterEach(() => {
    rmSync(join(LEGACY_ROOT, "plugins"), { recursive: true, force: true })
  })

  it("loads without error, warns once, and drops the fields from the tool definition", async () => {
    writePackage(
      LEGACY_ROOT,
      "legacy-fetch",
      {
        id: "legacy-fetch",
        name: "legacy-fetch",
        version: "0.1.0",
        description: "test",
        tuis: [
          {
            id: "fetch",
            trigger: {
              type: "tool",
              tool: {
                name: "LegacyFetch",
                description: "fetch",
                input_schema: { type: "object", properties: {} },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
            icon: "⤓",
            color: "sky",
            headerKey: "url",
          },
        ],
      },
      { "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" });` },
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: LEGACY_ROOT,
      roots: { project: [join(ROOT, "manifest-legacy-nope", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("LegacyFetch")).toBe(true)
    const tool = loader.getExtraTools().find((t) => t.name === "LegacyFetch")
    expect(tool).toBeDefined()
    expect(tool).not.toHaveProperty("icon")
    expect(tool).not.toHaveProperty("color")
    expect(tool).not.toHaveProperty("headerKey")
    expect(logs.some((l) => l.includes("legacy-fetch") && l.includes("icon/color/headerKey"))).toBe(
      true,
    )
  })
})

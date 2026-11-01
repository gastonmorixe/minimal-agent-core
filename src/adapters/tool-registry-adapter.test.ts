/**
 * Unit tests for {@link ToolRegistryAdapter}: core built-ins + plugin tools,
 * and the now-always-empty presentation map (S29/S31).
 */

import { describe, expect, it } from "bun:test"

import type { PluginLoader } from "../plugins/loader.ts"
import { TOOL_DEFINITIONS } from "../tools/tools.ts"

import { ToolRegistryAdapter } from "./tool-registry-adapter.ts"

/** A loader stub advertising plugin tools + aliases. */
function loaderStub(opts: {
  extraTools?: Array<{
    name: string
    description: string
    input_schema: Record<string, unknown>
    icon?: string
    color?: string
    headerKey?: string
  }>
  aliases?: Map<string, string>
}): PluginLoader {
  const stub = {
    getExtraTools: () => opts.extraTools ?? [],
    getToolAliases: () => opts.aliases ?? new Map<string, string>(),
    hasTool: () => false,
  }
  return stub as unknown as PluginLoader
}

describe("ToolRegistryAdapter", () => {
  it("with no loader lists exactly the core TOOL_DEFINITIONS", () => {
    const reg = new ToolRegistryAdapter(null)
    expect(reg.list()).toEqual(TOOL_DEFINITIONS)
  })

  it("merges core tools first, then plugin tools in loader order", () => {
    const loader = loaderStub({
      extraTools: [
        { name: "Widget", description: "w", input_schema: {} },
        { name: "Gadget", description: "g", input_schema: {} },
      ],
    })
    const reg = new ToolRegistryAdapter(loader)
    const names = reg.list().map((t) => t.name)
    // Core names come first (byte-identical prefix), plugin names appended.
    const coreNames = TOOL_DEFINITIONS.map((t) => t.name)
    expect(names.slice(0, coreNames.length)).toEqual(coreNames)
    expect(names.slice(coreNames.length)).toEqual(["Widget", "Gadget"])
  })

  it("presentation() is always empty (S29/S31: no source for icon/color/headerKey anymore)", () => {
    const loader = loaderStub({
      extraTools: [
        // Even a legacy loader that still hands back cosmetic fields on its
        // tool objects gets no presentation slot: the adapter no longer
        // reads them. The CLI's own static map (S41) replaces this.
        { name: "Fancy", description: "f", input_schema: {}, icon: "⤓", color: "sky" },
        { name: "Plain", description: "p", input_schema: {} },
      ],
      aliases: new Map([["Nickname", "Fancy"]]),
    })
    const reg = new ToolRegistryAdapter(loader)
    const pres = reg.presentation()
    expect(pres.size).toBe(0)
    expect(pres.has("Fancy")).toBe(false)
    expect(pres.has("Nickname")).toBe(false)
  })
})

/**
 * Unit tests for {@link ToolRegistryAdapter}: core built-ins + plugin tools,
 * presentation map, and alias mirroring.
 */

import { describe, expect, it } from "bun:test"

import type { PluginLoader } from "../../plugins/loader.ts"
import { TOOL_DEFINITIONS } from "../../tools/tools.ts"

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

  it("builds a presentation slot only for tools with cosmetic fields", () => {
    const loader = loaderStub({
      extraTools: [
        { name: "Fancy", description: "f", input_schema: {}, icon: "⤓", color: "sky" },
        { name: "Plain", description: "p", input_schema: {} },
      ],
    })
    const reg = new ToolRegistryAdapter(loader)
    const pres = reg.presentation()
    expect(pres.get("Fancy")).toEqual({ icon: "⤓", color: "sky", headerKey: undefined })
    expect(pres.has("Plain")).toBe(false)
  })

  it("mirrors canonical presentation into alias slots", () => {
    const loader = loaderStub({
      extraTools: [
        { name: "WebSearch", description: "s", input_schema: {}, icon: "🔍", color: "amber" },
      ],
      aliases: new Map([["Search", "WebSearch"]]),
    })
    const reg = new ToolRegistryAdapter(loader)
    const pres = reg.presentation()
    // The alias "Search" gets the canonical WebSearch presentation.
    expect(pres.get("Search")).toEqual(pres.get("WebSearch"))
    // ...but the alias is NOT advertised as a tool.
    expect(reg.list().some((t) => t.name === "Search")).toBe(false)
  })

  it("does not overwrite an existing presentation slot when mirroring aliases", () => {
    const loader = loaderStub({
      extraTools: [
        { name: "Canonical", description: "c", input_schema: {}, icon: "A" },
        { name: "Alias", description: "a", input_schema: {}, icon: "B" },
      ],
      aliases: new Map([["Alias", "Canonical"]]),
    })
    const reg = new ToolRegistryAdapter(loader)
    // "Alias" already has its own real presentation; the alias mirror must not clobber it.
    expect(reg.presentation().get("Alias")).toEqual({
      icon: "B",
      color: undefined,
      headerKey: undefined,
    })
  })
})

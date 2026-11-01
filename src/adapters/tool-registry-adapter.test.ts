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

  it("has no presentation() method (S29: the CLI owns tool presentation)", () => {
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
    expect("presentation" in reg).toBe(false)
    // The cosmetic fields a legacy loader hands back are not read.
    expect(reg.list().map((t) => t.name)).toContain("Fancy")
  })
})

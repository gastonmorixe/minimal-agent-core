import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
} from "./index.ts"
import {
  discoverProviderPlugins,
  findProviderPluginDirs,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { activateProviderPlugins, clearProviderPlugins } from "./provider-plugin.ts"

// Repo `plugins/` dir, relative to this file (src/llm/).
const PLUGINS_DIR = join(import.meta.dir, "../../plugins")

describe("provider discovery", () => {
  it("finds the llm-* provider descriptors via provider.json", () => {
    const ids = findProviderPluginDirs(PLUGINS_DIR).map((d) => d.descriptor.id)
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai"]))
  })

  it("dynamically imports each declared ProviderPlugin", async () => {
    const plugins = await discoverProviderPlugins(PLUGINS_DIR)
    const ids = plugins.map((p) => p.id)
    expect(ids).toContain("anthropic")
    expect(ids).toContain("openai")
    for (const p of plugins) {
      expect(typeof p.register).toBe("function")
      expect(typeof p.shortCode).toBe("string")
    }
  })

  it("registers + activates discovered providers into the canonical registries", async () => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()

    const ids = await registerDiscoveredProviders(PLUGINS_DIR)
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai"]))
    activateProviderPlugins()

    expect(resolveProvider("anthropic").id).toBe("anthropic")
    expect(resolveProvider("openai").id).toBe("openai")
    expect(resolveModel("claude-opus-4-8").providerId).toBe("anthropic")
    expect(resolveModel("gpt-5.5").providerId).toBe("openai")

    clearProviderPlugins()
  })

  it("returns empty for a non-existent dir", () => {
    expect(findProviderPluginDirs(join(import.meta.dir, "does-not-exist"))).toEqual([])
  })
})

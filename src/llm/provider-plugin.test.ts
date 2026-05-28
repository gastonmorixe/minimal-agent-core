import { afterEach, describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
} from "./index.ts"
import {
  activateProviderPlugins,
  clearProviderPlugins,
  findProviderPlugin,
  listProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
} from "./provider-plugin.ts"
import { activateBuiltinProviders } from "./providers/index.ts"

describe("provider-plugin registry", () => {
  afterEach(() => {
    clearProviderPlugins()
  })

  it("registers, lists, finds, and activates plugins", () => {
    clearProviderPlugins()
    let activated = 0
    const fake: ProviderPlugin = {
      id: "fake",
      displayName: "Fake",
      shortCode: "fk",
      register() {
        activated++
      },
    }
    registerProviderPlugin(fake)
    expect(listProviderPlugins().map((p) => p.id)).toContain("fake")
    expect(findProviderPlugin("fake")?.displayName).toBe("Fake")
    expect(activateProviderPlugins()).toContain("fake")
    expect(activated).toBe(1)
  })

  it("de-dupes by id", () => {
    clearProviderPlugins()
    const make = (displayName: string): ProviderPlugin => ({
      id: "dup",
      displayName,
      shortCode: "d",
      register() {},
    })
    registerProviderPlugin(make("first"))
    registerProviderPlugin(make("second"))
    expect(listProviderPlugins()).toHaveLength(1)
    expect(findProviderPlugin("dup")?.displayName).toBe("second")
  })
})

describe("activateBuiltinProviders", () => {
  it("registers Anthropic + OpenAI into the canonical registries", () => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()

    const ids = activateBuiltinProviders()
    expect(ids).toEqual(expect.arrayContaining(["anthropic", "openai"]))
    expect(resolveProvider("anthropic").id).toBe("anthropic")
    expect(resolveProvider("openai").id).toBe("openai")
    expect(resolveModel("claude-opus-4-8").providerId).toBe("anthropic")
    expect(resolveModel("gpt-5.5").providerId).toBe("openai")

    clearProviderPlugins()
  })
})

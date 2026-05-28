import { afterEach, describe, expect, it } from "bun:test"

import {
  activateProviderPlugins,
  clearProviderPlugins,
  findProviderPlugin,
  listProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
} from "./provider-plugin.ts"

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

import { afterEach, describe, expect, it } from "bun:test"

import {
  activateProviderPlugins,
  clearProviderPlugins,
  findProviderPlugin,
  listProviderPlugins,
  type ProviderPlugin,
  type ProviderStartupContext,
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

  it("onStartupProbe is optional and invoked per plugin (the index.ts seam)", () => {
    // Mirrors the composition-root loop:
    //   for (const p of listProviderPlugins()) p.onStartupProbe?.(ctx)
    // One plugin probes, one omits the hook entirely. The loop must not
    // throw on the omitter, and the prober must see the exact ctx.
    clearProviderPlugins()
    const seen: ProviderStartupContext[] = []
    const prober: ProviderPlugin = {
      id: "prober",
      displayName: "Prober",
      shortCode: "pr",
      register() {},
      onStartupProbe(ctx) {
        seen.push(ctx)
      },
    }
    const silent: ProviderPlugin = {
      id: "silent",
      displayName: "Silent",
      shortCode: "si",
      register() {},
    }
    registerProviderPlugin(prober)
    registerProviderPlugin(silent)

    const ctx: ProviderStartupContext = {
      auth: { kind: "api-key", key: "k" },
      modelId: "some-model",
    }
    expect(() => {
      for (const p of listProviderPlugins()) p.onStartupProbe?.(ctx)
    }).not.toThrow()
    expect(seen).toEqual([ctx])
  })
})

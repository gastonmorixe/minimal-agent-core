import { afterEach, describe, expect, it } from "bun:test"

import type { Capabilities } from "./capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  findModelByTags,
  findModelForProvider,
  findProvider,
  type ModelEntry,
  registerModel,
  registerProvider,
  resolveModel,
  resolveModelForProvider,
  resolveProvider,
} from "./model-registry.ts"
import type { ProviderAdapter } from "./provider.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"

const adapter = {
  id: "acme-next",
  surfaces: [],
  validate: () => ({ ok: true }),
  run: async function* () {},
} as unknown as ProviderAdapter

function setup(): void {
  clearProviderPlugins()
  clearModelRegistry()
  clearProviderRegistry()
  registerProviderPlugin({
    id: "acme-next",
    displayName: "OpenCode Go",
    shortCode: "ac",
    formerIds: ["acme"],
    register() {},
  })
  registerProvider(adapter)
  registerModel({
    id: "acme-model-1",
    providerId: "acme-next",
    surfaceId: "custom",
    displayName: "Acme Model 1",
    capabilities: {} as Capabilities,
    pricing: {} as ModelEntry["pricing"],
    tags: ["fast"],
  })
}

describe("model registry with provider formerIds", () => {
  afterEach(() => {
    clearProviderPlugins()
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("resolves providers by a former id", () => {
    setup()
    expect(findProvider("acme")).toBe(adapter)
    expect(resolveProvider("acme")).toBe(adapter)
    expect(() => resolveProvider("nope")).toThrow('unknown provider "nope"')
  })

  it("resolves provider-scoped models by a former id", () => {
    setup()
    expect(findModelForProvider("acme-model-1", "acme")?.providerId).toBe("acme-next")
    expect(resolveModelForProvider("acme-model-1", "acme").providerId).toBe("acme-next")
    expect(resolveModel("acme-model-1", "acme").providerId).toBe("acme-next")
    expect(findModelByTags("acme", ["fast"])?.id).toBe("acme-model-1")
  })
})

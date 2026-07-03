/**
 * Test: resolveProviderSessionInfo respects providerId for scoped labels.
 *
 * Proves that when two providers register the same model id, calling
 * resolveProviderSessionInfo with an explicit providerId returns the label
 * from that provider's scoped model entry, not the global last-write-wins
 * entry.
 */

import { describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "./model-registry.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { resolveProviderSessionInfo } from "./provider-session.ts"
import { registerTestProvider } from "./test-fixtures.ts"

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
}

describe("resolveProviderSessionInfo with providerId scoping", () => {
  it("produces different labels for a duplicate model id under different providers", async () => {
    setup()

    const modelId = "shared-model"
    registerTestProvider({
      id: "provider-a",
      shortCode: "pa",
      models: [{ id: modelId }],
      modelVersionToken: () => "one",
    })
    registerTestProvider({
      id: "provider-b",
      shortCode: "pb",
      models: [{ id: modelId }],
      modelVersionToken: () => "two",
    })

    // Unscoped: resolves via global = last-registered provider.
    const unscoped = await resolveProviderSessionInfo(modelId)
    expect(unscoped.modelLabel).toBe("pb-two")

    // Scoped to the first provider: must not leak through to the last global entry.
    const scopedA = await resolveProviderSessionInfo(modelId, {
      providerId: "provider-a",
    })
    expect(scopedA.modelLabel).toBe("pa-one")

    // Scoped to the second provider: must match the unscoped last-write-wins entry.
    const scopedB = await resolveProviderSessionInfo(modelId, {
      providerId: "provider-b",
    })
    expect(scopedB.modelLabel).toBe(unscoped.modelLabel)
  })
})

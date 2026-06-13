/**
 * TDD for the provider-loader registry seam (Wave D net/registry seam).
 *
 * A provider plugin must be able to register its model catalog at load time
 * WITHOUT importing `registerModel` / `setDefaultModelId` from `src/`. The host
 * builds a {@link buildProviderSetupContext} (the `models:register` capability
 * as a provider-neutral {@link ModelRegistrar}) and hands it to each plugin's
 * `register(ctx)` via {@link activateDiscoveredProviders}. The plugin contributes
 * through `ctx.models.register` / `ctx.models.setDefault`.
 *
 * These tests use a FAKE provider plugin whose `register(ctx)` only touches the
 * provider-neutral contract types (`ProviderSetupContext`, `ProviderModelSpec`
 * from `@minimal-agent/plugin-api/llm/provider-plugin`) — the exact shape a
 * real plugin in its own repo would use — and assert the live registry is
 * populated as a side effect, with no `src/` registry import in the plugin's
 * code path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type {
  ProviderModelSpec,
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

import { clearModelRegistry, findModel, getDefaultModelId } from "./model-registry.ts"
import { activateDiscoveredProviders, buildProviderSetupContext } from "./provider-discovery.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"

/** A neutral model spec, built only from contract types (no src import). */
function fakeSpec(): ProviderModelSpec {
  return {
    id: "test-model-1",
    providerId: "test-provider",
    surfaceId: "test-surface",
    displayName: "Test Model 1",
    tags: ["flagship"],
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 1,
      outputUSD: 2,
      cacheWriteUSD: 1,
      cacheReadUSD: 0.5,
      webSearchPerCallUSD: 0,
    },
    vendorIds: { firstParty: "test-model-1" },
  }
}

/** A fake provider plugin that registers purely through the setup ctx. */
function fakePlugin(): ProviderPlugin {
  return {
    id: "test-provider",
    displayName: "Test Provider",
    shortCode: "test",
    register(ctx?: ProviderSetupContext): void {
      // The seam: a plugin in its own repo reaches the host registry ONLY
      // through the ctx capability. No `registerModel` import from src/.
      if (!ctx?.models) throw new Error("fake plugin requires ctx.models")
      ctx.models.register(fakeSpec())
      ctx.models.setDefault("test-model-1")
    },
  }
}

describe("provider setup-context (models:register seam)", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderPlugins()
  })
  afterEach(() => {
    clearModelRegistry()
    clearProviderPlugins()
  })

  it("buildProviderSetupContext exposes a registrar bound to the live registry", () => {
    const ctx = buildProviderSetupContext()
    ctx.models.register(fakeSpec())
    expect(findModel("test-model-1")?.providerId).toBe("test-provider")
  })

  it("setDefault through the registrar drives getDefaultModelId", () => {
    const ctx = buildProviderSetupContext()
    ctx.models.register(fakeSpec())
    ctx.models.setDefault("test-model-1")
    expect(getDefaultModelId()).toBe("test-model-1")
  })

  it("activateDiscoveredProviders registers a fake plugin's catalog via ctx", () => {
    registerProviderPlugin(fakePlugin())
    const ids = activateDiscoveredProviders()
    expect(ids).toContain("test-provider")
    // The plugin reached the registry ONLY through ctx.models — proof the
    // seam works without a src/ registry import in the plugin.
    expect(findModel("test-model-1")?.displayName).toBe("Test Model 1")
    expect(getDefaultModelId()).toBe("test-model-1")
  })
})

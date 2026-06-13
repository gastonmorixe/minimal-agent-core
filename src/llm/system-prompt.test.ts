/**
 * Provider-resolved system-prompt tests.
 *
 * Covers the seam introduced so the agent never hardcodes a provider's
 * preamble: `resolveSystemPromptForModel` builds a neutral skeleton and
 * delegates to the model's provider plugin via the registry.
 *
 * @module llm/system-prompt.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { Capabilities } from "./capabilities.ts"
import { clearModelRegistry, registerModel } from "./model-registry.ts"
import {
  clearProviderPlugins,
  type ProviderPlugin,
  registerProviderPlugin,
  type SystemPromptContext,
} from "./provider-plugin.ts"
import { NEUTRAL_IDENTITY, resolveSystemPromptForModel } from "./system-prompt.ts"

const CAPS: Capabilities = {
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  maxOutputTokensBatch: null,
} as Capabilities

function registerFakeModel(id: string, providerId: string): void {
  registerModel({
    id,
    providerId,
    surfaceId: "custom",
    displayName: id,
    capabilities: CAPS,
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
}

afterEach(() => {
  clearProviderPlugins()
  clearModelRegistry()
})

// resolveAnthropicSystemPrompt's billing-header / Claude-Code-identity pins
// moved to plugins/llm-anthropic/system-prompt.test.ts (A-5): that preamble
// is provider wire knowledge and is pinned in the provider's own suite.

describe("resolveSystemPromptForModel", () => {
  it("delegates to the registered provider plugin's resolveSystemPrompt", () => {
    registerFakeModel("fake-1", "fakeprov")
    const seen: SystemPromptContext[] = []
    const plugin: ProviderPlugin = {
      id: "fakeprov",
      displayName: "Fake",
      shortCode: "fk",
      register() {},
      resolveSystemPrompt(ctx) {
        seen.push(ctx)
        return [{ type: "text", text: "FAKE-PREAMBLE" }, ...ctx.body]
      },
    }
    registerProviderPlugin(plugin)

    const out = resolveSystemPromptForModel("fake-1", {
      sessionContext: "ENV",
      authKind: "api-key",
    })
    expect(out[0].text).toBe("FAKE-PREAMBLE")
    // body = instructions block + session-context block
    expect(out.at(-1)?.text).toBe("ENV")
    expect(seen[0].authKind).toBe("api-key")
    expect(seen[0].modelId).toBe("fake-1")
  })

  it("falls back to the neutral identity when the provider declares no hook", () => {
    registerFakeModel("fake-2", "nohook")
    registerProviderPlugin({
      id: "nohook",
      displayName: "NoHook",
      shortCode: "nh",
      register() {},
    })
    const out = resolveSystemPromptForModel("fake-2", {})
    expect(out[0].text).toBe(NEUTRAL_IDENTITY)
  })

  it("falls back to neutral identity for an unknown model id (no throw)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {})
    expect(out[0].text).toBe(NEUTRAL_IDENTITY)
    // instructions block always present after the identity
    expect(out).toHaveLength(2)
    expect(out[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" })
  })
})

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
import {
  buildAgentSystemBody,
  NEUTRAL_IDENTITY,
  resolveSystemPromptForModel,
} from "./system-prompt.ts"
import type { SystemPromptOverrides } from "./system-prompt-overrides.ts"

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
    expect(out[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m", scope: "global" })
  })
})

describe("buildAgentSystemBody cache TTL", () => {
  it("defaults both breakpoints to 5m (instructions scoped global, session per-session)", () => {
    const body = buildAgentSystemBody({ sessionContext: "ENV" })
    expect(body).toHaveLength(2)
    expect(body[0].cache_control).toEqual({ type: "ephemeral", ttl: "5m", scope: "global" })
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("applies an explicit cacheTtl (1h) to both breakpoints", () => {
    const body = buildAgentSystemBody({ sessionContext: "ENV", cacheTtl: "1h" })
    expect(body[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" })
    expect(body[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("threads cacheTtl through resolveSystemPromptForModel to the instructions block", () => {
    const out = resolveSystemPromptForModel("does-not-exist", { cacheTtl: "1h" })
    expect(out[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" })
  })
})

describe("system-prompt overrides", () => {
  const NO_OVERRIDES: SystemPromptOverrides = {}

  it("produces byte-identical output with no overrides (default identity + instructions)", () => {
    const baseline = resolveSystemPromptForModel("does-not-exist", {})
    const withEmpty = resolveSystemPromptForModel("does-not-exist", { overrides: NO_OVERRIDES })
    expect(withEmpty).toEqual(baseline)
  })

  it("replaces the neutral identity", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { identity: { kind: "replace", text: "Custom identity" } },
    })
    expect(out[0].text).toBe("Custom identity")
  })

  it("omits the neutral identity (falls back to NEUTRAL_IDENTITY)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { identity: { kind: "omit" } },
    })
    // omit on identity falls back to NEUTRAL_IDENTITY via applyPromptPartOverride
    expect(out[0].text).toBe(NEUTRAL_IDENTITY)
  })

  it("replaces instructions text", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { instructions: { kind: "replace", text: "Custom instructions" } },
    })
    // instructions block starts with the replacement text
    expect(out[1].text.startsWith("Custom instructions")).toBe(true)
  })

  it("omits instructions text (loop-safety still present)", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      overrides: { instructions: { kind: "omit" } },
    })
    // identity + loop-safety block (instructions omitted but loop-safety remains)
    expect(out).toHaveLength(2)
    expect(out[0].text).toBe(NEUTRAL_IDENTITY)
    expect(out[1].text).toContain("Tool-use loop safety")
  })

  it("replaces session context", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "original context",
      overrides: { sessionContext: { kind: "replace", text: "custom context" } },
    })
    expect(out.at(-1)?.text).toBe("custom context")
  })

  it("omits session context", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "original context",
      overrides: { sessionContext: { kind: "omit" } },
    })
    // identity + instructions only, no session context
    expect(out).toHaveLength(2)
  })

  it("full override replaces the entire core-controllable body", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "ENV",
      overrides: { full: { kind: "replace", text: "Complete custom prompt" } },
    })
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe("Complete custom prompt")
  })

  it("full override omit returns empty blocks", () => {
    const out = resolveSystemPromptForModel("does-not-exist", {
      sessionContext: "ENV",
      overrides: { full: { kind: "omit" } },
    })
    expect(out).toHaveLength(0)
  })

  it("threads providerPreambleOverride to the provider context", () => {
    registerFakeModel("fake-pp", "pprov")
    const seen: SystemPromptContext[] = []
    registerProviderPlugin({
      id: "pprov",
      displayName: "PP",
      shortCode: "pp",
      register() {},
      resolveSystemPrompt(ctx) {
        seen.push(ctx)
        return [{ type: "text", text: "PREAMBLE" }, ...ctx.body]
      },
    })
    resolveSystemPromptForModel("fake-pp", {
      overrides: { providerPreamble: { kind: "replace", text: "custom preamble" } },
    })
    expect(seen[0].providerPreambleOverride).toEqual({
      kind: "replace",
      text: "custom preamble",
    })
  })
})

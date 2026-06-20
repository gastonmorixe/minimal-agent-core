/**
 * Cross-provider model disambiguation tests.
 *
 * Verifies that `findModelForProvider` and `resolveModelForProvider`
 * correctly disambiguate models registered by multiple providers with the
 * same bare ID (e.g. both OpenCode and Wafer serve `deepseek-v4-flash`).
 *
 * @module llm/providers/wafer/wafer-disambiguation.test
 */

import { describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
  findModelForProvider,
} from "../../src/llm/model-registry.ts"

import { bootstrapWafer } from "./adapter.ts"

/**
 * Dynamic import of OpenCode: we test cross-provider interaction but
 * avoid a static import dependency that would couple the two plugin
 * trees at build time.
 */
async function bootstrapOpencode(): Promise<void> {
  const mod = await import("../llm-opencode/adapter.ts")
  mod.bootstrapOpencode()
}

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
}

describe("cross-provider model disambiguation", () => {
  it("findModelForProvider returns the correct provider's entry", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    // Un-scoped global lookup: last write wins (Wafer, alphabetical order)
    expect(findModel("deepseek-v4-flash")?.providerId).toBe("wafer")

    // Scoped for OpenCode → OpenCode's entry
    const oc = findModelForProvider("deepseek-v4-flash", "opencode")
    expect(oc?.providerId).toBe("opencode")
    expect(oc?.tags).toContain("opencode")
    expect(oc?.tags).not.toContain("wafer")

    // Scoped for Wafer → Wafer's entry
    const wf = findModelForProvider("deepseek-v4-flash", "wafer")
    expect(wf?.providerId).toBe("wafer")
    expect(wf?.tags).toContain("wafer")

    // The two entries are DIFFERENT objects (different capabilities/pricing)
    expect(oc).not.toBe(wf)
  })

  it("findModelForProvider respects strict scoping: no fallback", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    // GLM-5.1 is only registered by Wafer
    expect(findModelForProvider("GLM-5.1", "wafer")?.providerId).toBe("wafer")

    // GLM-5.1 queried under OpenCode → NOT found (strict, no fallback)
    expect(findModelForProvider("GLM-5.1", "opencode")).toBeUndefined()
  })

  it("different providers expose different surfaces for the same id", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    // qwen3.7-max: OpenCode → anthropic-messages, Wafer → openai-chat-completions
    const oc = findModelForProvider("qwen3.7-max", "opencode")
    const wf = findModelForProvider("qwen3.7-max", "wafer")
    expect(oc?.providerId).toBe("opencode")
    expect(wf?.providerId).toBe("wafer")
    expect(oc?.surfaceId).toBe("anthropic-messages")
    expect(wf?.surfaceId).toBe("openai-chat-completions")
  })

  it("model unique to one provider resolves correctly for that provider", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    // Kimi-K2.6: Wafer only
    expect(findModelForProvider("Kimi-K2.6", "wafer")?.providerId).toBe("wafer")
    expect(findModelForProvider("Kimi-K2.6", "opencode")).toBeUndefined()

    // minimax-m3: OpenCode only (Messages surface)
    const ocMm3 = findModelForProvider("minimax-m3", "opencode")
    expect(ocMm3?.providerId).toBe("opencode")
    expect(ocMm3?.surfaceId).toBe("anthropic-messages")
  })
})

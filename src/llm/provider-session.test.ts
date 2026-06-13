/**
 * Tests for the provider session-metadata seam: the agent asks the current
 * model's provider for quota/context/label, with a context-only fallback.
 *
 * @module llm/provider-session.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { Capabilities } from "./capabilities.ts"
import { clearModelRegistry, registerModel } from "./model-registry.ts"
import {
  clearProviderPlugins,
  type ProviderPlugin,
  type ProviderSessionInfo,
  registerProviderPlugin,
} from "./provider-plugin.ts"
import {
  contextWindowForModel,
  primeProviderSessionInfo,
  resolveProviderSessionInfo,
} from "./provider-session.ts"

const CAPS = {
  contextWindow: 222_000,
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

describe("resolveProviderSessionInfo", () => {
  it("delegates to the provider's fetchSessionInfo and forwards the signal", async () => {
    registerFakeModel("m-quota", "provq")
    const ac = new AbortController()
    let sawSignal: AbortSignal | undefined
    const plugin: ProviderPlugin = {
      id: "provq",
      displayName: "Q",
      shortCode: "q",
      register() {},
      async fetchSessionInfo(ctx) {
        sawSignal = ctx.signal
        return {
          contextWindow: 500_000,
          modelLabel: "q-1",
          quota: { windows: [{ id: "5h", utilization: 0.5 }] },
        } satisfies ProviderSessionInfo
      },
    }
    registerProviderPlugin(plugin)

    const info = await resolveProviderSessionInfo("m-quota", { signal: ac.signal })
    expect(info.contextWindow).toBe(500_000)
    expect(info.quota?.windows[0]?.id).toBe("5h")
    expect(sawSignal).toBe(ac.signal)
  })

  it("falls back to a context-only view (from the registry) when no provider hook", async () => {
    registerFakeModel("m-nohook", "provn")
    registerProviderPlugin({ id: "provn", displayName: "N", shortCode: "n", register() {} })
    const info = await resolveProviderSessionInfo("m-nohook")
    expect(info.contextWindow).toBe(222_000) // from CAPS
    expect(info.quota).toBeUndefined()
  })

  it("backfills context window + label when the provider omits them", async () => {
    registerFakeModel("m-partial", "provp")
    registerProviderPlugin({
      id: "provp",
      displayName: "P",
      shortCode: "p",
      register() {},
      async fetchSessionInfo() {
        return { quota: { windows: [{ id: "rpm", utilization: 0.1 }] } }
      },
    })
    const info = await resolveProviderSessionInfo("m-partial")
    expect(info.contextWindow).toBe(222_000) // backfilled from registry
    expect(info.quota?.windows[0]?.id).toBe("rpm")
  })

  it("never throws when fetchSessionInfo rejects — degrades to context-only", async () => {
    registerFakeModel("m-throws", "provx")
    registerProviderPlugin({
      id: "provx",
      displayName: "X",
      shortCode: "x",
      register() {},
      async fetchSessionInfo() {
        throw new Error("boom")
      },
    })
    const info = await resolveProviderSessionInfo("m-throws")
    expect(info.contextWindow).toBe(222_000)
    expect(info.quota).toBeUndefined()
  })

  it("unknown model id → context-only with undefined window (no throw)", async () => {
    const info = await resolveProviderSessionInfo("nope")
    expect(info.contextWindow).toBeUndefined()
  })
})

describe("primeProviderSessionInfo", () => {
  it("routes to the provider plugin's primeSessionInfo and forwards modelId + signal", async () => {
    registerFakeModel("m-prime", "provp")
    const ac = new AbortController()
    let calls = 0
    let sawModelId: string | undefined
    let sawSignal: AbortSignal | undefined
    registerProviderPlugin({
      id: "provp",
      displayName: "P",
      shortCode: "p",
      register() {},
      async primeSessionInfo(ctx) {
        calls++
        sawModelId = ctx.modelId
        sawSignal = ctx.signal
      },
    })

    await primeProviderSessionInfo("m-prime", { signal: ac.signal })
    expect(calls).toBe(1)
    expect(sawModelId).toBe("m-prime")
    expect(sawSignal).toBe(ac.signal)
  })

  it("no-ops when the provider declares no primeSessionInfo", async () => {
    registerFakeModel("m-nohook", "provnh")
    registerProviderPlugin({
      id: "provnh",
      displayName: "NH",
      shortCode: "nh",
      register() {},
    })
    // Must resolve, not throw, even with no hook.
    await expect(primeProviderSessionInfo("m-nohook")).resolves.toBeUndefined()
  })

  it("never throws when primeSessionInfo rejects", async () => {
    registerFakeModel("m-throws", "provx")
    registerProviderPlugin({
      id: "provx",
      displayName: "X",
      shortCode: "x",
      register() {},
      async primeSessionInfo() {
        throw new Error("boom")
      },
    })
    await expect(primeProviderSessionInfo("m-throws")).resolves.toBeUndefined()
  })

  it("no-ops on an unknown model id", async () => {
    // No plugin registered, no model registered — must not throw.
    await expect(primeProviderSessionInfo("nope")).resolves.toBeUndefined()
  })
})

describe("contextWindowForModel", () => {
  it("reads the registry capabilities", () => {
    registerFakeModel("m-cw", "p")
    expect(contextWindowForModel("m-cw")).toBe(222_000)
    expect(contextWindowForModel("missing")).toBeUndefined()
  })
})

// parseAnthropicQuotaWindows moved to plugins/llm-anthropic/
// session-info.parse.test.ts (A-5): the header grammar is provider wire
// knowledge and is pinned in the provider's own suite.

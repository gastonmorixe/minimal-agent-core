/**
 * Unit tests for the synthetic in-test provider fixture
 * (`src/llm/test-fixtures.ts`) — the seam that lets core tests exercise the
 * canonical transport stack without importing any real provider plugin
 * (invariant I2) and without any provider fingerprint (invariant I1).
 *
 * @module llm/test-fixtures.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "./canonical-events.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
} from "./model-registry.ts"
import { clearProviderPlugins, findProviderPlugin } from "./provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents, testProviderUrl } from "./test-fixtures.ts"

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

/** Minimal structural network client the fixture adapter can drive. */
function fakeClient(
  events: CanonicalEvent[],
  onRequest?: (input: { url: string; headers?: Record<string, string> }) => void,
) {
  return {
    request: async (input: { url: string; headers?: Record<string, string> }) => {
      onRequest?.(input)
      return {
        ok: true,
        status: 200,
        body: sseBodyFromEvents(events),
        text: async () => "",
      }
    },
  }
}

const PONG_EVENTS: CanonicalEvent[] = [
  {
    type: "message_start",
    messageId: "msg_fx",
    modelId: "test-model-1",
    initialUsage: { inputTokens: 3, outputTokens: 0 },
  },
  { type: "text_start", index: 0 },
  { type: "text_delta", index: 0, text: "pong" },
  { type: "text_stop", index: 0 },
  {
    type: "message_delta",
    stopReason: "end_turn",
    usage: { inputTokens: 3, outputTokens: 1 },
  },
  { type: "message_stop" },
]

describe("registerTestProvider — registry wiring", () => {
  it("registers adapter + models (with aliases) + provider plugin", () => {
    registerTestProvider({
      id: "test-prov",
      models: [{ id: "test-model-1", aliases: ["test-model-1[x]"] }],
    })
    expect(resolveProvider("test-prov").id).toBe("test-prov")
    expect(resolveModel("test-model-1").providerId).toBe("test-prov")
    expect(resolveModel("test-model-1[x]").id).toBe("test-model-1")
    expect(findProviderPlugin("test-prov")?.shortCode).toBe("tp")
  })

  it("defaults: one neutral model under id test-prov", () => {
    registerTestProvider()
    expect(resolveModel("test-model-1").providerId).toBe("test-prov")
  })

  it("register() is idempotent (re-activation does not throw)", () => {
    const { plugin } = registerTestProvider()
    expect(() => plugin.register()).not.toThrow()
    expect(resolveModel("test-model-1").providerId).toBe("test-prov")
  })

  it("merges capability overrides over the neutral defaults", () => {
    registerTestProvider({
      id: "test-prov-caps",
      models: [
        {
          id: "test-cheap-model-1",
          capabilities: {
            caching: {
              explicit: true,
              automatic: false,
              ttls: ["5m", "1h"],
              minPrefixTokens: 2048,
              reportsCacheHits: true,
            },
          },
        },
      ],
    })
    expect(resolveModel("test-cheap-model-1").capabilities.caching.minPrefixTokens).toBe(2048)
    // Unspecified fields keep the neutral defaults.
    expect(resolveModel("test-cheap-model-1").capabilities.maxOutputTokens).toBeGreaterThan(0)
  })

  it("the plugin's modelVersionToken parses a trailing -<digits> token", () => {
    const { plugin } = registerTestProvider()
    expect(plugin.modelVersionToken?.("test-model-1")).toBe("1")
    expect(plugin.modelVersionToken?.("no-trailing-digits-x")).toBeUndefined()
  })
})

describe("registerTestProvider — adapter wire behavior", () => {
  it("streams canonical events round-trip through the injected network client", async () => {
    const { adapter } = registerTestProvider()
    const out: CanonicalEvent[] = []
    for await (const ev of adapter.run(
      { modelId: "test-model-1", messages: [] },
      resolveModel("test-model-1"),
      {
        auth: { kind: "api-key", key: "k-test" },
        sessionId: "",
        networkClient: fakeClient(PONG_EVENTS),
      },
    )) {
      out.push(ev)
    }
    expect(out.map((e) => e.type)).toEqual([
      "message_start",
      "text_start",
      "text_delta",
      "text_stop",
      "message_delta",
      "message_stop",
    ])
  })

  it("POSTs to its per-provider URL and authorizes with the resolved credential", async () => {
    const { adapter } = registerTestProvider({ id: "test-prov-auth" })
    let seenUrl = ""
    let seenAuth = ""
    const client = fakeClient(PONG_EVENTS, (input) => {
      seenUrl = input.url
      seenAuth = input.headers?.authorization ?? ""
    })
    const drain = async (auth: Parameters<typeof adapter.run>[2]["auth"]) => {
      for await (const _ of adapter.run(
        { modelId: "test-model-1", messages: [] },
        resolveModel("test-model-1"),
        { auth, sessionId: "", networkClient: client },
      )) {
        // drain
      }
    }
    await drain({ kind: "api-key", key: "k-secret" })
    expect(seenUrl).toBe(testProviderUrl("test-prov-auth"))
    expect(seenAuth).toBe("Bearer k-secret")
    await drain({ kind: "oauth", token: "t-secret" })
    expect(seenAuth).toBe("Bearer t-secret")
  })

  it("throws a clear error when no network client is injected", async () => {
    const { adapter } = registerTestProvider({ id: "test-prov-noc" })
    const gen = adapter.run(
      { modelId: "test-model-1", messages: [] },
      resolveModel("test-model-1"),
      {
        auth: { kind: "api-key", key: "k" },
        sessionId: "",
      },
    )
    let caught = ""
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("networkClient")
  })

  it("throws on a non-2xx response", async () => {
    const { adapter } = registerTestProvider({ id: "test-prov-err" })
    const client = {
      request: async () => ({
        ok: false,
        status: 500,
        body: null,
        text: async () => "boom",
      }),
    }
    const gen = adapter.run(
      { modelId: "test-model-1", messages: [] },
      resolveModel("test-model-1"),
      {
        auth: { kind: "api-key", key: "k" },
        sessionId: "",
        networkClient: client,
      },
    )
    let caught = ""
    try {
      for await (const _ of gen) {
        // drain
      }
    } catch (e) {
      caught = (e as Error).message
    }
    expect(caught).toContain("500")
  })
})

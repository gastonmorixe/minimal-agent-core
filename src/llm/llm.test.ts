/**
 * Smoke tests for the canonical LLM core.
 *
 * Verifies: registry round-trip, capability defaults, pricing
 * arithmetic, helper constructors, the `run()` validation path.
 *
 * @module llm/llm.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  type CanonicalEvent,
  type CanonicalRequest,
  type Capabilities,
  CapabilityViolation,
  calculateUsageCost,
  clearModelRegistry,
  clearProviderRegistry,
  compareEffort,
  defaultCapabilities,
  isEvent,
  isServerTool,
  type ModelEntry,
  type MTokRate,
  mergeUsage,
  type ProviderAdapter,
  type RunContext,
  registerModel,
  registerProvider,
  resolveModel,
  resolveProvider,
  run,
  supportsEffort,
  systemMessage,
  toolResult,
  UnsupportedCapabilityError,
  userText,
} from "./index.ts"

const TEST_RATE: MTokRate = {
  inputUSD: 5,
  outputUSD: 25,
  cacheWriteUSD: 6.25,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.01,
}

const ctx: RunContext = {
  auth: { kind: "api-key", key: "sk-test" },
  sessionId: "test-session",
}

function buildCapabilities(overrides: Partial<Capabilities> = {}): Capabilities {
  return { ...defaultCapabilities(), ...overrides }
}

function buildEntry(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "test-model",
    providerId: "test",
    surfaceId: "custom",
    displayName: "Test Model",
    capabilities: buildCapabilities(),
    pricing: TEST_RATE,
    ...overrides,
  }
}

function buildRequest(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    modelId: "test-model",
    messages: [userText("hi")],
    ...overrides,
  }
}

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
})

describe("capabilities", () => {
  it("defaultCapabilities returns a lowest-common-denominator record", () => {
    const c = defaultCapabilities()
    expect(c.thinking.adaptive).toBe(false)
    expect(c.caching.minPrefixTokens).toBe(0)
    expect(c.serverTools).toEqual([])
  })

  it("compareEffort orders levels low → max", () => {
    expect(compareEffort("low", "medium")).toBeLessThan(0)
    expect(compareEffort("max", "high")).toBeGreaterThan(0)
    expect(compareEffort("high", "high")).toBe(0)
  })

  it("supportsEffort checks membership", () => {
    expect(supportsEffort({ levels: ["high", "max"], default: "high" }, "high")).toBe(true)
    expect(supportsEffort({ levels: ["high", "max"], default: "high" }, "low")).toBe(false)
  })
})

describe("canonical-messages helpers", () => {
  it("userText / systemMessage / toolResult build expected shapes", () => {
    expect(userText("hi")).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi" }],
    })
    expect(systemMessage("ping")).toEqual({
      role: "system",
      content: [{ type: "text", text: "ping" }],
    })
    const tr = toolResult("tu_1", "ok")
    expect(tr.role).toBe("user")
    expect(tr.content).toEqual([
      { type: "tool_result", toolUseId: "tu_1", content: [{ type: "text", text: "ok" }] },
    ])
  })

  it("toolResult passes isError and cache through", () => {
    const tr = toolResult("tu_1", "fail", { isError: true, cache: { kind: "ephemeral" } })
    const block = tr.content[0]
    expect(block).toBeDefined()
    if (block === undefined) return
    expect(block.type === "tool_result" && block.isError).toBe(true)
    expect(block.type === "tool_result" && block.cache?.kind).toBe("ephemeral")
  })
})

describe("canonical-tools.isServerTool", () => {
  it("returns true only when `server` is set", () => {
    expect(isServerTool({ name: "x", description: "y", inputSchema: {} })).toBe(false)
    expect(
      isServerTool({ name: "x", description: "y", inputSchema: {}, server: "web_search" }),
    ).toBe(true)
  })
})

describe("pricing", () => {
  it("calculateUsageCost applies each per-MTok rate to its token bucket", () => {
    const cost = calculateUsageCost(
      {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      },
      TEST_RATE,
    )
    expect(cost.inputUSD).toBeCloseTo(5)
    expect(cost.outputUSD).toBeCloseTo(25)
    expect(cost.cacheReadUSD).toBeCloseTo(0.5)
    expect(cost.cacheCreationUSD).toBeCloseTo(6.25)
    expect(cost.totalUSD).toBeCloseTo(36.75)
  })

  it("mergeUsage sums defined fields, preserves undefined", () => {
    const merged = mergeUsage(
      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
      { inputTokens: 1, outputTokens: 2 },
    )
    expect(merged.inputTokens).toBe(11)
    expect(merged.outputTokens).toBe(22)
    expect(merged.cacheReadTokens).toBe(5)
    expect(merged.reasoningTokens).toBeUndefined()
  })
})

describe("registry", () => {
  it("round-trips model registration via id and alias", () => {
    registerModel(buildEntry({ aliases: ["test-model-alias"] }))
    expect(resolveModel("test-model").id).toBe("test-model")
    expect(resolveModel("test-model-alias").id).toBe("test-model")
  })

  it("throws on alias / id collision", () => {
    registerModel(buildEntry())
    expect(() => registerModel(buildEntry({ id: "other", aliases: ["test-model"] }))).toThrow(
      /collides/,
    )
  })

  it("resolveModel surfaces a useful error for unknown ids", () => {
    expect(() => resolveModel("ghost")).toThrow(/unknown model "ghost"/)
  })
})

describe("isEvent", () => {
  it("narrows by discriminator", () => {
    const ev: CanonicalEvent = { type: "text_delta", index: 0, text: "x" }
    if (isEvent(ev, "text_delta")) {
      expect(ev.text).toBe("x")
    } else {
      throw new Error("expected text_delta narrowing")
    }
  })
})

describe("run() validation", () => {
  function makeAdapter(behavior: {
    ok?: boolean
    degrade?: CanonicalRequest
    events?: CanonicalEvent[]
  }): ProviderAdapter {
    return {
      id: "test",
      displayName: "Test",
      surfaces: ["custom"],
      validate() {
        if (behavior.ok ?? true) return { ok: true, errors: [] }
        return {
          ok: false,
          errors: [new CapabilityViolation("contextWindow", "too big")],
          degrade: behavior.degrade,
        }
      },
      run: async function* (_req, _model, _ctx) {
        for (const ev of behavior.events ?? []) yield ev
      },
    }
  }

  it("dispatches events from the adapter on a clean validation", async () => {
    registerProvider(
      makeAdapter({
        events: [
          {
            type: "message_start",
            messageId: "m1",
            modelId: "test-model",
            initialUsage: { inputTokens: 0, outputTokens: 0 },
          },
          { type: "message_stop" },
        ],
      }),
    )
    registerModel(buildEntry())
    const got: CanonicalEvent[] = []
    for await (const ev of run(buildRequest(), { context: ctx })) got.push(ev)
    expect(got.map((e) => e.type)).toEqual(["message_start", "message_stop"])
  })

  it("throws UnsupportedCapabilityError when validation fails and no degrade accepted", async () => {
    registerProvider(makeAdapter({ ok: false }))
    registerModel(buildEntry())
    let caught: unknown
    try {
      for await (const _ev of run(buildRequest(), { context: ctx })) {
        // no-op
      }
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsupportedCapabilityError)
  })

  it("falls back to the degraded request when acceptDegrade is true", async () => {
    const degrade = buildRequest({ messages: [userText("smaller")] })
    registerProvider(
      makeAdapter({
        ok: false,
        degrade,
        events: [{ type: "message_stop" }],
      }),
    )
    registerModel(buildEntry())
    const got: CanonicalEvent[] = []
    for await (const ev of run(buildRequest(), { context: ctx, acceptDegrade: true })) {
      got.push(ev)
    }
    // No stream_error yielded — the degrade is surfaced via diag and the
    // adapter's degraded stream begins immediately.
    expect(got[0]?.type).toBe("message_stop")
  })
})

describe("resolveProvider", () => {
  it("throws when the provider isn't registered", () => {
    expect(() => resolveProvider("nope")).toThrow(/unknown provider/)
  })
})

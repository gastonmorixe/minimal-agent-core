/**
 * `AgentCore.switchTarget` / `resolveTargetSwitch` (anytime target switching).
 *
 * Plan v2 (`research/2026-11-12-model-switch/plan/04-plan-v2.md`, decisions
 * D1-D6): the credential/provider/model/effort quadruple switches atomically,
 * next-request onward, mid-turn included. The review warnings in
 * `plan/05-review-v2.md` are covered: no silent cross-provider fallback (R1),
 * single joint resolution (R2), `[1m]` strip-vs-store (R3), system-prompt skew
 * as contract + in-flight line (R4, warning 2), credential-only fast path
 * (R5), overwrite-path persistence note (R6, via `sessionPersistence` port —
 * the store-level `updateTargetMeta` lands with the HostRuntime phase).
 *
 * @module sdk/agent-core.switch-target.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type { ProviderAdapter } from "../llm/provider.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentCoreConfig, ToolExecResult, ToolExecutor, ToolRegistry } from "./ports.ts"
import type { TargetState } from "./target-switch.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROVIDER_ID = "switch-test-provider"
const OTHER_PROVIDER_ID = "switch-other-provider"

const ZERO_PRICING: ModelEntry["pricing"] = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

const EMPTY_REGISTRY: ToolRegistry = { list: () => [] }

const NOOP_EXECUTOR: ToolExecutor = {
  async execute(): Promise<ToolExecResult> {
    throw new Error("not used in this test")
  },
}

function registerFixtureModel(
  id: string,
  providerId: string,
  effort: { levels: readonly string[]; default: string },
): void {
  registerModel({
    id,
    providerId,
    surfaceId: "test",
    displayName: id,
    capabilities: {
      ...defaultCapabilities(),
      effort: effort as ModelEntry["capabilities"]["effort"],
    },
    pricing: ZERO_PRICING,
  })
}

/** A fake provider adapter. `run` is never exercised: cores use `sendFn`. */
function registerFixtureProvider(id: string): void {
  const adapter: ProviderAdapter = {
    id,
    displayName: id,
    surfaces: ["test"],
    validate: () => ({ ok: true, errors: [] }),
    run: () => {
      throw new Error("not used in this test")
    },
  }
  registerProvider(adapter)
}

function endTurnSendFn(text = "ok") {
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    yield text
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function baseConfig(overrides: Partial<AgentCoreConfig> = {}): AgentCoreConfig {
  return {
    auth: AUTH,
    model: "model-a",
    providerId: PROVIDER_ID,
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: NOOP_EXECUTOR,
    ...overrides,
  }
}

function credentialNamesFor(names: Record<string, readonly string[]>) {
  return (providerId: string): readonly string[] => names[providerId] ?? []
}

function buildCore(overrides: Partial<AgentCoreConfig> = {}): AgentCore {
  return new AgentCore(baseConfig({ sendFn: endTurnSendFn(), ...overrides }))
}

describe("AgentCore.switchTarget (quadruple, atomic)", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("no-op selection returns the current target with effortReset false and no notice", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const notices: unknown[] = []
    const core = buildCore({
      effort: "high",
      eventSink: { emit: (e) => notices.push(e) },
    })

    const result = core.switchTarget({})
    expect(result.from).toEqual(result.to)
    expect(result.effortReset).toBe(false)
    expect(result.effortFrom).toBeUndefined()
    expect(core.getTarget()).toEqual({ providerId: PROVIDER_ID, model: "model-a", effort: "high" })
    expect(notices).toHaveLength(0)
  })

  it("same-target selection is silent (no notice)", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const notices: unknown[] = []
    const core = buildCore({
      effort: "high",
      eventSink: { emit: (e) => notices.push(e) },
    })

    const result = core.switchTarget({ model: "model-a", effort: "high" })
    expect(result.from).toEqual(result.to)
    expect(notices).toHaveLength(0)
  })

  it("switches model same-provider, keeps valid effort, emits one notice", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-b", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const notices: Array<{ type: string; notice?: { kind: string } }> = []
    const core = buildCore({
      effort: "high",
      eventSink: { emit: (e) => notices.push(e as { type: string }) },
    })

    const result = core.switchTarget({ model: "model-b" })
    expect(result.from.model).toBe("model-a")
    expect(result.to.model).toBe("model-b")
    expect(result.effortReset).toBe(false)
    expect(core.getModel()).toBe("model-b")
    expect(core.getEffort()).toBe("high")
    expect(notices.filter((e) => e.type === "notice")).toHaveLength(1)
  })

  it("resets effort when the new model does not support it, flagging effortReset", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-b", PROVIDER_ID, { levels: [], default: "medium" })
    const core = buildCore({ effort: "high" })

    const result = core.switchTarget({ model: "model-b" })
    expect(result.effortReset).toBe(true)
    expect(result.effortFrom).toBe("high")
    expect(core.getModel()).toBe("model-b")
    expect(core.getEffort()).toBeUndefined()
  })

  it("applies an explicit effort validated against the new model", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-b", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const core = buildCore({ effort: "low" })

    core.switchTarget({ model: "model-b", effort: "high" })
    expect(core.getModel()).toBe("model-b")
    expect(core.getEffort()).toBe("high")
  })

  it("throws on an explicit effort the new model rejects, state unchanged", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-b", PROVIDER_ID, { levels: [], default: "medium" })
    const core = buildCore({ effort: "low" })

    expect(() => core.switchTarget({ model: "model-b", effort: "high" })).toThrow()
    expect(core.getModel()).toBe("model-a")
    expect(core.getEffort()).toBe("low")
  })

  it("throws on unknown model, leaving all four fields unchanged (atomicity)", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const core = buildCore({
      effort: "high",
      credentialNames: credentialNamesFor({ [PROVIDER_ID]: ["work"] }),
    })
    const before = core.getTarget()

    expect(() => core.switchTarget({ model: "no-such-model" })).toThrow()
    expect(core.getTarget()).toEqual(before)
  })

  it("cross-provider switch without a model throws naming registered models, state unchanged", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-x", OTHER_PROVIDER_ID, { levels: ["low"], default: "low" })
    registerFixtureProvider(PROVIDER_ID)
    registerFixtureProvider(OTHER_PROVIDER_ID)
    const core = buildCore({ effort: "high" })
    const before = core.getTarget()

    expect(() => core.switchTarget({ providerId: OTHER_PROVIDER_ID })).toThrow(/model-x/)
    expect(core.getTarget()).toEqual(before)
  })

  it("cross-provider switch with an explicit model applies all four fields", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-x", OTHER_PROVIDER_ID, { levels: ["low"], default: "low" })
    registerFixtureProvider(PROVIDER_ID)
    registerFixtureProvider(OTHER_PROVIDER_ID)
    const core = buildCore({ effort: "high" })

    const result = core.switchTarget({ providerId: OTHER_PROVIDER_ID, model: "model-x" })
    expect(result.from.providerId).toBe(PROVIDER_ID)
    expect(result.to.providerId).toBe(OTHER_PROVIDER_ID)
    expect(result.to.model).toBe("model-x")
    // "high" is not in model-x's levels, so the joint resolution resets it.
    expect(result.effortReset).toBe(true)
    expect(core.getProviderId()).toBe(OTHER_PROVIDER_ID)
    expect(core.getModel()).toBe("model-x")
    expect(core.getEffort()).toBeUndefined()
  })

  it("useProviderDefault resolves the other provider's own registered model", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: [], default: "low" })
    registerFixtureModel("model-x", OTHER_PROVIDER_ID, { levels: [], default: "low" })
    registerFixtureProvider(PROVIDER_ID)
    registerFixtureProvider(OTHER_PROVIDER_ID)
    const core = buildCore({ model: "model-a" })

    const result = core.switchTarget({
      providerId: OTHER_PROVIDER_ID,
      useProviderDefault: true,
    })
    expect(result.to.providerId).toBe(OTHER_PROVIDER_ID)
    expect(result.to.model).toBe("model-x")
    expect(core.getProviderId()).toBe(OTHER_PROVIDER_ID)
    expect(core.getModel()).toBe("model-x")
  })

  it("preserves the [1m] caller form in state (lookup strips to the base id)", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    registerFixtureModel("model-b", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const core = buildCore({ effort: "high" })

    core.switchTarget({ model: "model-b[1m]" })
    expect(core.getModel()).toBe("model-b[1m]")
    expect(core.getEffort()).toBe("high")
  })

  it("credential-only switch is a live write with effortReset false", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const notices: Array<{ type: string }> = []
    const core = buildCore({
      effort: "high",
      credentialNames: credentialNamesFor({ [PROVIDER_ID]: ["work", "personal"] }),
      eventSink: { emit: (e) => notices.push(e as { type: string }) },
    })

    const result = core.switchTarget({ credentialName: "personal" })
    expect(result.from.credentialName).toBeUndefined()
    expect(result.to.credentialName).toBe("personal")
    expect(result.effortReset).toBe(false)
    expect(result.effortFrom).toBeUndefined()
    expect(core.getCredentialName()).toBe("personal")
    expect(core.getModel()).toBe("model-a")
    expect(core.getEffort()).toBe("high")
    expect(notices.filter((e) => e.type === "notice")).toHaveLength(1)
  })

  it("throws on an unknown credential, state unchanged", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
    const core = buildCore({
      effort: "high",
      credentialNames: credentialNamesFor({ [PROVIDER_ID]: ["work"] }),
    })
    const before = core.getTarget()

    expect(() => core.switchTarget({ credentialName: "ghost" })).toThrow(/ghost/)
    expect(core.getTarget()).toEqual(before)
  })

  it("exposes getProviderId/getCredentialName/getTarget readers", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low"], default: "low" })
    const core = buildCore({ effort: "low" })

    expect(core.getProviderId()).toBe(PROVIDER_ID)
    expect(core.getCredentialName()).toBeUndefined()
    const target: TargetState = core.getTarget()
    expect(target).toEqual({ providerId: PROVIDER_ID, model: "model-a", effort: "low" })
  })
})

describe("AgentCore.switchTarget auth (sel.auth)", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  /** A sendFn that records the auth of every request. */
  function recordingSendFn(seen: AuthResult[]) {
    return async function* (opts: {
      auth: AuthResult
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      seen.push(opts.auth)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  async function drain(core: AgentCore): Promise<void> {
    const gen = core.run("hi")
    while (!(await gen.next()).done) {
      // drain
    }
  }

  it("sends the new auth from the next request after a validated switch", async () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: [], default: "low" })
    registerFixtureModel("model-x", OTHER_PROVIDER_ID, { levels: [], default: "low" })
    registerFixtureProvider(PROVIDER_ID)
    registerFixtureProvider(OTHER_PROVIDER_ID)
    const seen: AuthResult[] = []
    const core = buildCore({ sendFn: recordingSendFn(seen) as AgentCoreConfig["sendFn"] })
    const next: AuthResult = { type: "api-key", token: "other-token" }

    await drain(core)
    core.switchTarget({ providerId: OTHER_PROVIDER_ID, useProviderDefault: true, auth: next })
    await drain(core)

    expect(seen[0]).toEqual(AUTH)
    expect(seen.at(-1)).toEqual(next)
  })

  it("keeps the old auth when the switch throws (atomic)", async () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: [], default: "low" })
    registerFixtureProvider(PROVIDER_ID)
    registerFixtureProvider(OTHER_PROVIDER_ID)
    const seen: AuthResult[] = []
    const core = buildCore({ sendFn: recordingSendFn(seen) as AgentCoreConfig["sendFn"] })
    const before = core.getTarget()

    expect(() =>
      core.switchTarget({
        providerId: OTHER_PROVIDER_ID,
        useProviderDefault: true,
        auth: { type: "api-key", token: "never" },
      }),
    ).toThrow()
    expect(core.getTarget()).toEqual(before)
    await drain(core)
    expect(seen).toEqual([AUTH])
  })

  it("accepts any credential name when no credentialNames port is injected", () => {
    registerFixtureModel("model-a", PROVIDER_ID, { levels: [], default: "low" })
    const core = buildCore()

    core.switchTarget({ credentialName: "anything" })
    expect(core.getCredentialName()).toBe("anything")
  })
})

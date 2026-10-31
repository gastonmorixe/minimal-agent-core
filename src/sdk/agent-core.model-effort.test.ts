import { afterEach, describe, expect, it } from "bun:test"

import type { TurnNotice } from "../agent/turn-notice.ts"
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
import { clearProviderPlugins, registerProviderPlugin } from "../llm/provider-plugin.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type {
  AgentCoreConfig,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "./ports.ts"

/**
 * `AgentCore.setModel` / `setEffort` validation, and the preflight
 * `adoptModelId` auto-adoption path's `model_adopted` notice (handoff
 * Q16/Q17, decided in acp-decisions.md item 9: core's validated setters
 * are the single source of truth both the CLI and a future ACP host call
 * through).
 */

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROVIDER_ID = "acp-test-provider"
const OTHER_PROVIDER_ID = "acp-other-provider"

const ZERO_PRICING: ModelEntry["pricing"] = {
  inputUSD: 0,
  outputUSD: 0,
  cacheWriteUSD: 0,
  cacheReadUSD: 0,
  webSearchPerCallUSD: 0,
}

/** A transcript sink that discards everything (not under test here). */
const NOOP_SINK: TranscriptSink = { write: () => {} }

/** An empty tool registry — no tools are exercised by these tests. */
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

/** A fake provider adapter. `run`/`validate` are never exercised: AgentCore
 * sends through the injected `sendFn`, never through `ProviderAdapter.run`. */
function registerFixtureProvider(
  id: string,
  opts?: { preflightFor?: string; adoptTo?: string },
): void {
  const adapter: ProviderAdapter = {
    id,
    displayName: id,
    surfaces: ["test"],
    validate: () => ({ ok: true, errors: [] }),
    run: () => {
      throw new Error("not used in this test")
    },
    ...(opts?.preflightFor
      ? {
          preflight: (_req, model) =>
            model.id === opts.preflightFor
              ? [
                  {
                    code: "adopt-newer",
                    title: "Adopt a newer model",
                    detail: "",
                    options: [{ id: "adopt", label: "Adopt" }],
                  },
                ]
              : [],
        }
      : {}),
    ...(opts?.adoptTo
      ? {
          applyResolution: (req, _issueCode, optionId) =>
            optionId === "adopt"
              ? { kind: "modify-request" as const, request: req, adoptModelId: opts.adoptTo }
              : { kind: "cancel" as const },
        }
      : {}),
  }
  registerProvider(adapter)
}

function baseConfig(overrides: Partial<AgentCoreConfig>): AgentCoreConfig {
  return {
    auth: AUTH,
    model: "model-a",
    providerId: PROVIDER_ID,
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: NOOP_EXECUTOR,
    transcriptSink: NOOP_SINK,
    ...overrides,
  }
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

async function drainRun(core: AgentCore, onNotice?: (n: TurnNotice) => void): Promise<void> {
  const gen = core.run("hi", onNotice ? { onNotice } : {})
  while (true) {
    const { done } = await gen.next()
    if (done) return
  }
}

describe("AgentCore.setModel / setEffort / adoptModelId (model and effort switching)", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  describe("setModel", () => {
    it("throws on an unknown model id and leaves model and effort unchanged", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "high" }))

      expect(() => core.setModel("no-such-model")).toThrow()
      expect(core.getModel()).toBe("model-a")
      expect(core.getEffort()).toBe("high")
    })

    it("throws when the model belongs to a different provider (same-provider only)", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureModel("model-c", OTHER_PROVIDER_ID, { levels: [], default: "medium" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "high" }))

      expect(() => core.setModel("model-c")).toThrow()
      expect(core.getModel()).toBe("model-a")
      expect(core.getEffort()).toBe("high")
    })

    it("switches to a known same-provider model and keeps a still-valid effort", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureModel("model-b", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "high" }))

      core.setModel("model-b")
      expect(core.getModel()).toBe("model-b")
      expect(core.getEffort()).toBe("high")
    })

    it("resets effort to the model default (undefined) in the same step when the new model does not fit it", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureModel("model-b", PROVIDER_ID, { levels: [], default: "medium" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "high" }))

      core.setModel("model-b")
      expect(core.getModel()).toBe("model-b")
      expect(core.getEffort()).toBeUndefined()
    })

    it("with no providerId configured, validates globally via resolveModel", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(
        baseConfig({ sendFn: endTurnSendFn(), providerId: undefined, effort: undefined }),
      )

      expect(() => core.setModel("no-such-model")).toThrow()
      core.setModel("model-a")
      expect(core.getModel()).toBe("model-a")
    })
    it("accepts a [1m] suffix: looks up the base id, stores the raw id", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureModel("model-b", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "high" }))

      core.setModel("model-b[1m]")
      expect(core.getModel()).toBe("model-b[1m]")
      expect(core.getEffort()).toBe("high")
    })

    it("accepts a REPL-style re-select of the current [1m] model", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(
        baseConfig({ sendFn: endTurnSendFn(), model: "model-a[1m]", effort: "low" }),
      )

      core.setModel(core.getModel())
      expect(core.getModel()).toBe("model-a[1m]")
      expect(core.getEffort()).toBe("low")
    })
  })

  describe("setEffort", () => {
    it("throws on an effort the current model does not declare, state unchanged", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: "low" }))

      expect(() => core.setEffort("ultra")).toThrow()
      expect(core.getEffort()).toBe("low")
    })

    it("throws any explicit effort when the model declares no effort levels", () => {
      registerFixtureModel("model-b", PROVIDER_ID, { levels: [], default: "medium" })
      const core = new AgentCore(
        baseConfig({ sendFn: endTurnSendFn(), model: "model-b", effort: undefined }),
      )

      expect(() => core.setEffort("low")).toThrow()
      expect(core.getEffort()).toBeUndefined()
    })

    it("accepts a declared level and undefined (model default) unconditionally", () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      const core = new AgentCore(baseConfig({ sendFn: endTurnSendFn(), effort: undefined }))

      core.setEffort("high")
      expect(core.getEffort()).toBe("high")
      core.setEffort(undefined)
      expect(core.getEffort()).toBeUndefined()
    })
  })

  describe("adoptModelId preflight path (automatic model_adopted notice)", () => {
    it("emits model_adopted, severity info, with effortReset + effortFrom, exactly when to !== from", async () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureModel("model-b", PROVIDER_ID, { levels: [], default: "medium" })
      registerFixtureProvider(PROVIDER_ID, { preflightFor: "model-a", adoptTo: "model-b" })

      const core = new AgentCore(
        baseConfig({
          sendFn: endTurnSendFn(),
          effort: "high",
          ports: { askUser: { ask: async () => "adopt" } },
        }),
      )

      const notices: TurnNotice[] = []
      await drainRun(core, (n) => notices.push(n))

      const adopted = notices.filter((n) => n.kind === "model_adopted")
      expect(adopted).toHaveLength(1)
      expect(adopted[0]).toEqual({
        kind: "model_adopted",
        severity: "info",
        from: "model-a",
        to: "model-b",
        effortReset: true,
        effortFrom: "high",
      })
      expect(core.getModel()).toBe("model-b")
      expect(core.getEffort()).toBeUndefined()
    })

    it("emits no model_adopted notice when the provider raises no preflight issue", async () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureProvider(PROVIDER_ID)

      const core = new AgentCore(
        baseConfig({
          sendFn: endTurnSendFn(),
          effort: "high",
          ports: { askUser: { ask: async () => "adopt" } },
        }),
      )

      const notices: TurnNotice[] = []
      await drainRun(core, (n) => notices.push(n))

      expect(notices.filter((n) => n.kind === "model_adopted")).toHaveLength(0)
      expect(core.getModel()).toBe("model-a")
      expect(core.getEffort()).toBe("high")
    })

    it("registers a live-only adopted id with its provider plugin before the switch", async () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureProvider(PROVIDER_ID, { preflightFor: "model-a", adoptTo: "live-only" })
      registerProviderPlugin({
        id: PROVIDER_ID,
        displayName: PROVIDER_ID,
        shortCode: "at",
        register() {},
        registerAdHocModel(id: string) {
          registerFixtureModel(id, PROVIDER_ID, { levels: ["low", "high"], default: "low" })
        },
      })

      const core = new AgentCore(
        baseConfig({
          sendFn: endTurnSendFn(),
          effort: "high",
          ports: { askUser: { ask: async () => "adopt" } },
        }),
      )

      const notices: TurnNotice[] = []
      await drainRun(core, (n) => notices.push(n))

      expect(core.getModel()).toBe("live-only")
      expect(notices.filter((n) => n.kind === "model_adopted")).toHaveLength(1)
    })

    it("keeps the model and emits a warn notice when the adopted id stays unknown", async () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureProvider(PROVIDER_ID, { preflightFor: "model-a", adoptTo: "live-only" })

      const core = new AgentCore(
        baseConfig({
          sendFn: endTurnSendFn(),
          effort: "high",
          ports: { askUser: { ask: async () => "adopt" } },
        }),
      )

      const notices: TurnNotice[] = []
      await drainRun(core, (n) => notices.push(n))

      expect(core.getModel()).toBe("model-a")
      expect(core.getEffort()).toBe("high")
      expect(notices.filter((n) => n.kind === "model_adopted")).toHaveLength(0)
      const failed = notices.filter((n) => n.kind === "model_adopt_failed")
      expect(failed).toHaveLength(1)
      expect(failed[0]).toMatchObject({
        kind: "model_adopt_failed",
        severity: "warn",
        model: "model-a",
        requested: "live-only",
      })
    })

    it("emits no model_adopted notice when the resolution adopts the SAME model id (to === from)", async () => {
      registerFixtureModel("model-a", PROVIDER_ID, { levels: ["low", "high"], default: "low" })
      registerFixtureProvider(PROVIDER_ID, { preflightFor: "model-a", adoptTo: "model-a" })

      const core = new AgentCore(
        baseConfig({
          sendFn: endTurnSendFn(),
          effort: "high",
          ports: { askUser: { ask: async () => "adopt" } },
        }),
      )

      const notices: TurnNotice[] = []
      await drainRun(core, (n) => notices.push(n))

      expect(notices.filter((n) => n.kind === "model_adopted")).toHaveLength(0)
      expect(core.getModel()).toBe("model-a")
      expect(core.getEffort()).toBe("high")
    })
  })
})

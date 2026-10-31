/**
 * The optional host ports (spec v2 section 2.6, S17) through `AgentCore.run`.
 *
 * - With no ports, a plain turn works (headless).
 * - A fake `askUser` port: exactly one `ask_user` event, and the answer
 *   reaches the model.
 * - With no `askUser` port but a provider-raised issue, the ask is denied
 *   once with an `ask_denied` notice and the request goes out unchanged.
 * - `inputQueue`, `reflectionGate`, and `compactSource` each reach the loop
 *   at their seam.
 *
 * @module sdk/host-ports.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../client/types.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type {
  PreflightIssue,
  PreflightResolution,
  ProviderAdapter,
  ValidationResult,
} from "../llm/provider.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentCoreConfig } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const ok: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
}

function core(sendFn: TransportFn, over: Partial<AgentCoreConfig> = {}) {
  const events: AgentEvent[] = []
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    transcriptSink: { write: () => {} },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    ...over,
  })
  return { agent, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

describe("AgentCore host ports (S17): headless default", () => {
  it("runs a plain turn with no ports at all", async () => {
    const calls: SendOptions[] = []
    const sendFn: TransportFn = async function* (opts) {
      calls.push(opts)
      yield "done"
      return ok
    }
    const { agent, events } = core(sendFn)
    const result = await drain(agent.run("hi"))
    expect(result.outcome).toBe("completed")
    expect(calls).toHaveLength(1)
    expect(events.some((e) => e.type === "ask_user")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// askUser (preflight ask) — reuses the synthetic provider from
// agent/preflight-pipeline.test.ts (a thinking-signature mismatch issue).
// ---------------------------------------------------------------------------

const ISSUE_STALE_SIGNATURE = "test.thinking-signature-mismatch"
const OPTION_SWITCH = "switch:test-model-2"
const STALE_SIGNATURE = "sig-from-another-model"

function fakeModel(id: string): ModelEntry {
  return {
    id,
    providerId: "test-prov",
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

function registerFakePreflightProvider(): void {
  registerModel(fakeModel("test-model-1"))
  registerModel(fakeModel("test-model-2"))
  const adapter: ProviderAdapter = {
    id: "test-prov",
    displayName: "Test Provider",
    surfaces: ["custom"],
    validate(): ValidationResult {
      return { ok: true, errors: [] }
    },
    async *run() {
      throw new Error("not exercised")
    },
    preflight(req: CanonicalRequest): PreflightIssue[] {
      const stale = req.messages.some(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "thinking" && b.signature === STALE_SIGNATURE),
      )
      if (!stale) return []
      return [
        {
          code: ISSUE_STALE_SIGNATURE,
          title: "Stale reasoning from a different model",
          detail: "History contains thinking signed by another model.",
          options: [{ id: OPTION_SWITCH, label: "Switch" }],
        },
      ]
    },
    applyResolution(
      req: CanonicalRequest,
      issueCode: string,
      optionId: string,
    ): PreflightResolution {
      if (issueCode !== ISSUE_STALE_SIGNATURE) throw new Error(`unknown issue: ${issueCode}`)
      if (optionId === OPTION_SWITCH)
        return { kind: "modify-request", request: req, adoptModelId: "test-model-2" }
      throw new Error(`unknown option: ${optionId}`)
    },
  }
  registerProvider(adapter)
}

const mismatchHistory: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "old reasoning", signature: STALE_SIGNATURE },
      { type: "text", text: "ok" },
    ],
  },
]

describe("AgentCore host ports (S17): askUser", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("asks exactly once through the port, and the answer reaches the model", async () => {
    registerFakePreflightProvider()
    const calls: SendOptions[] = []
    const sendFn: TransportFn = async function* (opts) {
      calls.push(opts)
      yield "done"
      return ok
    }
    let askCalls = 0
    const { agent, events } = core(sendFn, {
      initialMessages: mismatchHistory,
      ports: {
        askUser: {
          ask: async () => {
            askCalls++
            return OPTION_SWITCH
          },
        },
      },
    })
    const result = await drain(agent.run(""))
    expect(result.outcome).toBe("completed")
    expect(askCalls).toBe(1)
    const asks = events.filter((e) => e.type === "ask_user")
    expect(asks).toHaveLength(1)
    expect(asks[0]).toMatchObject({ code: ISSUE_STALE_SIGNATURE, options: [{ id: OPTION_SWITCH }] })
    // The model switch from applyResolution reached the next send.
    expect(calls[0]?.model).toBe("test-model-2")
    expect(agent.getModel()).toBe("test-model-2")
  })

  it("denies the ask once with a notice when the host supplies no port", async () => {
    registerFakePreflightProvider()
    const calls: SendOptions[] = []
    const sendFn: TransportFn = async function* (opts) {
      calls.push(opts)
      yield "done"
      return ok
    }
    const { agent, events } = core(sendFn, { initialMessages: mismatchHistory })
    const result = await drain(agent.run(""))
    expect(result.outcome).toBe("completed")
    // The request went out unchanged: original model, mismatched thinking kept.
    expect(calls[0]?.model).toBe("test-model-1")
    expect(agent.getModel()).toBe("test-model-1")
    const notices = events.filter((e) => e.type === "notice")
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      notice: { kind: "ask_denied", code: ISSUE_STALE_SIGNATURE },
    })
  })
})

// ---------------------------------------------------------------------------
// inputQueue, reflectionGate, compactSource
// ---------------------------------------------------------------------------

describe("AgentCore host ports (S17): inputQueue / reflectionGate / compactSource", () => {
  it("joins queued host text into the next round's request, and calls injected()", async () => {
    let round = 0
    const sendFn: TransportFn = async function* () {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return ok
    }
    const captured: { injected: string | null } = { injected: null }
    const { agent } = core(sendFn, {
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      ports: {
        inputQueue: {
          take: () => (round === 1 ? "queued while the tool ran" : null),
          injected: (text) => {
            captured.injected = text
          },
        },
      },
    })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(captured.injected).toBe("queued while the tool ran")
    const lastUser = agent
      .history()
      .filter((m) => m.role === "user")
      .at(-1)
    expect(JSON.stringify(lastUser)).toContain("queued while the tool ran")
  })

  it("pauses at the reflectionGate port before a checkpoint attachment", async () => {
    let round = 0
    const sendFn: TransportFn = async function* () {
      round++
      if (round < 2) {
        return {
          blocks: [{ type: "tool_use", id: `t${round}`, name: "Bash", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return ok
    }
    const captured: { gateRound: number | null } = { gateRound: null }
    const { agent } = core(sendFn, {
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      reflectionInterval: 1,
      ports: {
        reflectionGate: {
          beforeCheckpoint: (round) => {
            captured.gateRound = round
          },
        },
      },
    })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(captured.gateRound).toBe(1)
  })

  it("drains one compactSource request between rounds, never mid-round", async () => {
    let round = 0
    const sendFn: TransportFn = async function* () {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return ok
    }
    let took = 0
    const { agent } = core(sendFn, {
      toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
      ports: {
        compactSource: {
          take: () => {
            took++
            // Only round 2's pre-send drain finds something queued.
            return took === 2 ? { reason: "manual" } : null
          },
        },
      },
    })
    let compacted = 0
    agent.compact = async () => {
      compacted++
      return { kind: "local" } as Awaited<ReturnType<AgentCore["compact"]>>
    }
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(compacted).toBe(1)
    // Drained once per round (before each send): round 1 and round 2.
    expect(took).toBe(2)
  })
})

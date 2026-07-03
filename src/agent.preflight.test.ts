/**
 * End-to-end integration test for the preflight pipeline inside
 * `Agent.run()`.
 *
 * Core-side seam test (Wave A unit A-4): the agent must drive the
 * provider-neutral preflight contract (`runPreflightPipeline` →
 * `askUser` → `applyResolution`) without importing any real provider
 * (invariant I2) or naming one (invariant I1). A synthetic in-test
 * provider registered straight into the canonical registries supplies a
 * `preflight()` that flags a stale thinking-block signature and an
 * `applyResolution()` for the three resolutions. The Anthropic-specific
 * signature decoding lives in `plugins/llm-anthropic/`'s own
 * `thinking-preflight.test.ts` + `adapter.preflight.test.ts`.
 *
 * Wires the fake provider + a stubbed sendFn + a stubbed askUser
 * callback, then drives `agent.run()` and asserts that:
 *
 *  - clean messages → no askUser call
 *  - mismatched thinking → askUser called exactly once; chosen option
 *    is applied to the messages BEFORE sendFn sees them
 *  - SWITCH option mutates `this.model`
 *  - user cancel throws AbortError
 *
 * @module agent.preflight.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { Message, SendOptions, StreamedResponse } from "./client/types.ts"
import type { CanonicalRequest } from "./llm/canonical-request.ts"
import { defaultCapabilities } from "./llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "./llm/model-registry.ts"
import type {
  PreflightIssue,
  PreflightResolution,
  ProviderAdapter,
  ValidationResult,
} from "./llm/provider.ts"

// ---------------------------------------------------------------------------
// Synthetic preflight provider (neutral — I1/I2 clean)
// ---------------------------------------------------------------------------

/** Issue code the fake provider raises. Neutral, provider-agnostic. */
const ISSUE_STALE_SIGNATURE = "test.thinking-signature-mismatch"
/** Resolution option ids (provider-defined strings, passed back verbatim). */
const OPTION_STRIP = "strip"
const OPTION_SWITCH_PREFIX = "switch:"
const OPTION_CANCEL = "cancel"
/** Sentinel signature standing in for "signed by a different model". */
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

/**
 * Register a synthetic provider whose `preflight()` flags any assistant
 * thinking block carrying {@link STALE_SIGNATURE}, plus two neutral
 * models so the agent can `switch` between them. Exercises the seam, not
 * any provider's signature scheme.
 */
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
      throw new Error("fake preflight provider: run() is not exercised by these tests")
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
          options: [
            { id: OPTION_STRIP, label: "Strip" },
            { id: `${OPTION_SWITCH_PREFIX}test-model-2`, label: "Switch" },
            { id: OPTION_CANCEL, label: "Cancel" },
          ],
        },
      ]
    },
    applyResolution(
      req: CanonicalRequest,
      issueCode: string,
      optionId: string,
    ): PreflightResolution {
      if (issueCode !== ISSUE_STALE_SIGNATURE) throw new Error(`unknown issue code: ${issueCode}`)
      if (optionId === OPTION_CANCEL) return { kind: "cancel" }
      if (optionId === OPTION_STRIP) {
        const messages = req.messages.map((m) =>
          m.role === "assistant" && Array.isArray(m.content)
            ? { ...m, content: m.content.filter((b) => b.type !== "thinking") }
            : m,
        )
        return { kind: "modify-request", request: { ...req, messages } }
      }
      if (optionId.startsWith(OPTION_SWITCH_PREFIX)) {
        const adoptModelId = optionId.slice(OPTION_SWITCH_PREFIX.length)
        return { kind: "modify-request", request: req, adoptModelId }
      }
      throw new Error(`unknown option id: ${optionId}`)
    },
  }
  registerProvider(adapter)
}

interface CapturedSend {
  modelId: string | undefined
  messages: Message[]
}

function makeAuth(): AuthResult {
  return { type: "api-key", token: "test-token" }
}

function makeSendFn(captured: CapturedSend[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push({
      modelId: opts.model,
      messages: structuredClone(opts.messages),
    })
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function staleAssistant(): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "old thoughts", signature: STALE_SIGNATURE },
      { type: "text", text: "old reply" },
    ],
  }
}

describe("Agent.run preflight integration", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("no askUser → no preflight at all; old thinking blocks are sent as-is", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []
    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "previous" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    expect(captured).toHaveLength(1)
    const asst = captured[0]?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    // Without preflight, the thinking block is sent verbatim.
    expect(types).toContain("thinking")
  })

  it("askUser + clean messages → askUser is never called", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []
    let askCalls = 0
    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
    })

    for await (const _ of agent.run("hi", {
      askUser: async () => {
        askCalls++
        return null
      },
    })) {
      // drain
    }

    expect(askCalls).toBe(0)
    expect(captured).toHaveLength(1)
  })

  it("askUser + mismatch + STRIP → sendFn sees stripped messages, same model", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []
    let askCalls = 0
    let seenIssueCode = ""

    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi", {
      askUser: async (issue) => {
        askCalls++
        seenIssueCode = issue.code
        return OPTION_STRIP
      },
    })) {
      // drain
    }

    expect(askCalls).toBe(1)
    expect(seenIssueCode).toBe(ISSUE_STALE_SIGNATURE)
    expect(captured).toHaveLength(1)
    const sent = captured[0]
    expect(sent?.modelId).toBe("test-model-1") // unchanged
    // Stale assistant is the SECOND message in history; its thinking
    // block should be gone from what sendFn received.
    const asst = sent?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toEqual(["text"])
  })

  it("askUser + mismatch + SWITCH → agent.model updates and sendFn sees new model", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi", {
      askUser: async () => `${OPTION_SWITCH_PREFIX}test-model-2`,
    })) {
      // drain
    }

    expect(captured).toHaveLength(1)
    expect(captured[0]?.modelId).toBe("test-model-2")
    // Agent's internal model also updated for future turns.
    expect((agent as unknown as { model: string }).model).toBe("test-model-2")
    // Thinking block preserved (we kept the original model's history).
    const asst = captured[0]?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toContain("thinking")
  })

  it("askUser + mismatch + CANCEL → throws AbortError; sendFn never called", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    let threwAbort = false
    try {
      for await (const _ of agent.run("hi", {
        askUser: async () => OPTION_CANCEL,
      })) {
        // drain
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") threwAbort = true
      else throw err
    }
    expect(threwAbort).toBe(true)
    expect(captured).toHaveLength(0)
  })

  it("askUser + mismatch + askUser returns null → throws AbortError", async () => {
    registerFakePreflightProvider()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "test-model-1",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    let threwAbort = false
    try {
      for await (const _ of agent.run("hi", { askUser: async () => null })) {
        // drain
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") threwAbort = true
      else throw err
    }
    expect(threwAbort).toBe(true)
  })
})

/**
 * Snapshot tests for Opus 4.8-specific wire features:
 *
 * - `speed: "fast"` flips the body field AND adds `fast-mode-2026-02-01`
 *   to the beta header.
 * - `task_budget` adds `task-budgets-2026-03-13` to the beta header AND
 *   surfaces under `output_config.task_budget` on the body.
 * - `mid-conversation system` (`role:"system"` inside messages[])
 *   emits the right wire shape.
 * - `cacheDiagnostics` adds the `diagnostics:{previous_message_id}`
 *   block and the `cache-diagnosis-2026-04-07` beta.
 * - Refusal `stop_details` surfaces as `MessageDeltaEvent.stopDetails`
 *   from the SSE translator.
 *
 * Each test pins the exact wire snapshot we want; if Anthropic ships
 * a breaking change to one of these fields we'll see a clean diff.
 *
 * @module llm/providers/anthropic/opus-48-features.test
 */

import { describe, expect, it } from "bun:test"

import {
  type CanonicalEvent,
  type CanonicalRequest,
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  systemMessage,
  userText,
} from "../../index.ts"

import { bootstrapAnthropic } from "./adapter.ts"
import { ANTHROPIC_BETA_FLAGS, buildBetaFlags } from "./beta-flags.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { buildAnthropicRequestBody } from "./request-body.ts"
import { translateAnthropicStream } from "./response-stream.ts"

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapAnthropic()
}

describe("Opus 4.8 — fast mode", () => {
  it("speed:fast flips the body field and adds fast-mode beta", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hi")],
      speed: "fast",
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.speed).toBe("fast")
    const { headers, betaFlags } = buildAnthropicHeaders({
      req,
      model,
      auth: { kind: "oauth", token: "tok" },
      sessionId: "s",
      clientRequestId: "rid",
    })
    expect(betaFlags).toContain(ANTHROPIC_BETA_FLAGS.FAST_MODE)
    expect(headers["anthropic-beta"]).toContain("fast-mode-2026-02-01")
  })

  it("pricingForRequest doubles base when speed:fast", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const standard = model.pricingForRequest?.({ modelId: model.id, messages: [] })
    const fast = model.pricingForRequest?.({
      modelId: model.id,
      messages: [],
      speed: "fast",
    })
    expect(standard?.inputUSD).toBe(5)
    expect(standard?.outputUSD).toBe(25)
    expect(fast?.inputUSD).toBe(10)
    expect(fast?.outputUSD).toBe(50)
  })

  it("sonnet-4-6 does NOT support fast mode (capability-gated)", () => {
    setup()
    const model = resolveModel("claude-sonnet-4-6")
    expect(model.capabilities.speedFast).toBe(false)
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hi")],
      speed: "fast",
    }
    const body = buildAnthropicRequestBody(req, model)
    // Adapter drops it silently — server would reject anyway.
    expect(body.speed).toBeUndefined()
  })
})

describe("Opus 4.8 — task budget", () => {
  it("task_budget surfaces on output_config and adds the beta flag", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hi")],
      vendor: {
        anthropic: { taskBudget: { type: "tokens", total: 50_000 } },
      },
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.output_config?.task_budget).toEqual({ type: "tokens", total: 50_000 })
    const flags = buildBetaFlags({
      kind: "conversation",
      req,
      model,
      authKind: "oauth",
    })
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.TASK_BUDGETS)
  })
})

describe("Opus 4.8 — mid-conversation system message", () => {
  it("role:'system' lands as wire {role:'system', content:string}", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [
        userText("first turn"),
        systemMessage(
          "The user sent a new message while you were working:\nhelp\n\nIMPORTANT: After completing your current task, you MUST address the user's message above.",
        ),
      ],
    }
    const body = buildAnthropicRequestBody(req, model)
    const last = body.messages[body.messages.length - 1]
    expect(last?.role).toBe("system")
    expect(typeof last?.content).toBe("string")
    expect(last?.content).toContain("you were working")
    // Beta header flips on
    const flags = buildBetaFlags({
      kind: "conversation",
      req,
      model,
      authKind: "oauth",
    })
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM)
  })
})

describe("Opus 4.8 — cache diagnostics", () => {
  it("opts into the diagnostics block + cache-diagnosis beta", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("hi")],
      vendor: { anthropic: { cacheDiagnostics: true } },
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.diagnostics).toEqual({ previous_message_id: null })
    const flags = buildBetaFlags({
      kind: "conversation",
      req,
      model,
      authKind: "oauth",
    })
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.CACHE_DIAGNOSIS)
  })
})

describe("Opus 4.8 — refusal stop_details surfacing", () => {
  async function* iter<T>(arr: ReadonlyArray<unknown>): AsyncIterable<T> {
    for (const v of arr) yield v as T
  }

  it("propagates stop_details verbatim through MessageDeltaEvent", async () => {
    setup()
    const events = [
      {
        type: "message_start",
        message: {
          id: "m1",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_sequence: null,
          stop_details: {
            type: "harm_category_dangerous_capabilities",
            message: "I can't help with that request.",
          },
        },
        usage: { input_tokens: 100, output_tokens: 5 },
      },
      { type: "message_stop" },
    ] as const

    const out: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(iter(events))) out.push(ev)
    const md = out.find((e) => e.type === "message_delta")
    expect(md?.type).toBe("message_delta")
    if (md?.type !== "message_delta") return
    expect(md.stopReason).toBe("refusal")
    expect(md.stopDetails).toEqual({
      type: "harm_category_dangerous_capabilities",
      message: "I can't help with that request.",
    })
  })

  it("passes null stop_details through on a normal end_turn", async () => {
    setup()
    const events = [
      {
        type: "message_start",
        message: {
          id: "m2",
          model: "claude-opus-4-8",
          usage: { input_tokens: 50, output_tokens: 10 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        usage: { input_tokens: 50, output_tokens: 10 },
      },
      { type: "message_stop" },
    ] as const

    const out: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(iter(events))) out.push(ev)
    const md = out.find((e) => e.type === "message_delta")
    if (md?.type !== "message_delta") throw new Error("expected message_delta")
    expect(md.stopReason).toBe("end_turn")
    expect(md.stopDetails).toBeNull()
  })

  it("surfaces output_tokens_details.thinking_tokens as reasoningTokens", async () => {
    setup()
    const events = [
      {
        type: "message_start",
        message: {
          id: "m3",
          model: "claude-opus-4-8",
          usage: { input_tokens: 100, output_tokens: 5 },
        },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          output_tokens_details: { thinking_tokens: 150 },
        },
      },
      { type: "message_stop" },
    ] as const

    const out: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(iter(events))) out.push(ev)
    const md = out.find((e) => e.type === "message_delta")
    if (md?.type !== "message_delta") throw new Error("expected message_delta")
    expect(md.usage.reasoningTokens).toBe(150)
    expect(md.usage.outputTokens).toBe(200)
  })

  it("breaks down cache_creation by 5m / 1h", async () => {
    setup()
    const events = [
      {
        type: "message_start",
        message: {
          id: "m4",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_creation_input_tokens: 1000,
            cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 800 },
          },
        },
      },
      { type: "message_stop" },
    ] as const

    const out: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(iter(events))) out.push(ev)
    const start = out.find((e) => e.type === "message_start")
    if (start?.type !== "message_start") throw new Error("expected message_start")
    expect(start.initialUsage.cacheCreationTokens).toBe(1000)
    expect(start.initialUsage.cacheBreakdown).toEqual({ fiveMinute: 200, oneHour: 800 })
  })
})

describe("Opus 4.8 — combined 4.8 wire snapshot", () => {
  it("speed:fast + task_budget + mid-conv system all coexist with the right betas", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("first user turn"), systemMessage("nudge")],
      tools: [
        { name: "Bash", description: "shell", inputSchema: {} },
        { name: "Read", description: "read", inputSchema: {} },
      ],
      effort: "xhigh",
      speed: "fast",
      vendor: {
        anthropic: { taskBudget: { type: "tokens", total: 30_000 } },
      },
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.speed).toBe("fast")
    expect(body.output_config).toEqual({
      effort: "xhigh",
      task_budget: { type: "tokens", total: 30_000 },
    })
    // Mid-conv system message present
    expect(body.messages[1]?.role).toBe("system")

    const flags = buildBetaFlags({
      kind: "conversation",
      req,
      model,
      authKind: "oauth",
    })
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.FAST_MODE)
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.TASK_BUDGETS)
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM)
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.EFFORT)
  })
})

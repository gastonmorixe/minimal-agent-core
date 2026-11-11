import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentCoreConfig, ToolExecutor, ToolRegistry } from "./ports.ts"
import {
  RunOutputStrict,
  STRICT_UNSUPPORTED_CODE,
  type StrictWarnPort,
} from "./run-output-strict.ts"

function register(id: string, structuredOutputs: boolean): void {
  registerModel({
    id,
    providerId: "test-provider",
    surfaceId: "test",
    displayName: id,
    capabilities: { ...defaultCapabilities(), structuredOutputs },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
}

function port(): StrictWarnPort & { calls: unknown[][] } {
  const calls: unknown[][] = []
  return { calls, warn: (...args) => calls.push(args) }
}

const schema = { type: "object" }

describe("RunOutputStrict", () => {
  afterEach(() => clearModelRegistry())

  it("is off by default and has no effect without a schema", () => {
    const s = new RunOutputStrict(undefined)
    expect(s.forRequest(schema, "m", undefined, port())).toBeUndefined()
    const on = new RunOutputStrict(true)
    expect(on.forRequest(undefined, "m", undefined, port())).toBeUndefined()
    expect(on.forRequest(schema, "m", undefined, port())).toBe(true)
  })

  it("run value wins, then the session value comes back after end", () => {
    const s = new RunOutputStrict(false)
    s.start(true)
    expect(s.forRequest(schema, "m", undefined, port())).toBe(true)
    s.end()
    expect(s.forRequest(schema, "m", undefined, port())).toBeUndefined()
    const t = new RunOutputStrict(true)
    t.start(false)
    expect(t.forRequest(schema, "m", undefined, port())).toBeUndefined()
  })

  it("the pending value arms the next run only", () => {
    const s = new RunOutputStrict(false)
    s.pending = true
    s.start(undefined)
    expect(s.forRequest(schema, "m", undefined, port())).toBe(true)
    s.end()
    s.start(undefined)
    expect(s.forRequest(schema, "m", undefined, port())).toBeUndefined()
  })

  it("warns once per run for a model without structured outputs", () => {
    register("no-so", false)
    const p = port()
    const s = new RunOutputStrict(true)
    s.start(undefined)
    expect(s.forRequest(schema, "no-so", "test-provider", p)).toBe(true)
    expect(s.forRequest(schema, "no-so", "test-provider", p)).toBe(true)
    expect(p.calls).toHaveLength(1)
    expect(p.calls[0]?.[0]).toBe(STRICT_UNSUPPORTED_CODE)
    expect(p.calls[0]?.[2]).toEqual({ model: "no-so" })
    s.end()
    s.start(undefined)
    s.forRequest(schema, "no-so", "test-provider", p)
    expect(p.calls).toHaveLength(2)
  })

  it("does not warn for a model with structured outputs or with no registry entry", () => {
    register("yes-so", true)
    const p = port()
    const s = new RunOutputStrict(true)
    s.start(undefined)
    s.forRequest(schema, "yes-so", "test-provider", p)
    s.forRequest(schema, "unknown-model", undefined, p)
    expect(p.calls).toEqual([])
  })
})

const AUTH = { type: "api-key", token: "test-token" } as AuthResult
const EMPTY_REGISTRY: ToolRegistry = { list: () => [] }
const NO_TOOLS: ToolExecutor = { execute: async () => ({ content: "", isError: false }) }

function baseConfig(overrides: Partial<AgentCoreConfig>): AgentCoreConfig {
  return {
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: NO_TOOLS,
    ...overrides,
  }
}

async function drain(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<{ text: string }> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return { text }
    text += value
  }
}

describe("AgentCore.run — strict structured output (R2)", () => {
  afterEach(() => clearModelRegistry())

  const SCHEMA = { type: "object" }

  /** Records `outputConfig.format.strict` of each request. Fails round 1 when asked. */
  function strictSend(seen: unknown[], fail?: "error" | AbortController) {
    let round = 0
    return async function* (send: {
      outputConfig?: { format?: { strict?: boolean } }
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      seen.push(send.outputConfig?.format?.strict)
      round++
      if (round === 1 && fail === "error") throw new Error("boom")
      if (round === 1 && fail instanceof AbortController) {
        fail.abort()
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  function coreWith(sendFn: unknown, extra?: Record<string, unknown>): AgentCore {
    return new AgentCore({
      ...baseConfig({ sendFn: sendFn as AgentCoreConfig["sendFn"], outputSchema: SCHEMA }),
      ...extra,
    })
  }

  it("session strict reaches the request on every run", async () => {
    const seen: unknown[] = []
    const core = coreWith(strictSend(seen), { outputStrict: true })
    await drain(core.run("one"))
    await drain(core.run("two"))
    expect(seen).toEqual([true, true])
  })

  it("strict without a schema sends no format", async () => {
    const formats: unknown[] = []
    const sendFn = async function* (send: {
      outputConfig?: { format?: unknown }
    }): AsyncGenerator<string, StreamedResponse, undefined> {
      formats.push(send.outputConfig?.format)
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore({
      ...baseConfig({ sendFn: sendFn as AgentCoreConfig["sendFn"] }),
      outputStrict: true,
    })
    await drain(core.run("one", { outputStrict: true }))
    expect(formats).toEqual([undefined])
  })

  it("per-run strict applies to that run only", async () => {
    const seen: unknown[] = []
    const core = coreWith(strictSend(seen))
    await drain(core.run("one", { outputStrict: true }))
    await drain(core.run("two"))
    expect(seen).toEqual([true, undefined])
  })

  it("per-run strict is restored after a run that fails", async () => {
    const seen: unknown[] = []
    const core = coreWith(strictSend(seen, "error"))
    await expect(drain(core.run("one", { outputStrict: true }))).rejects.toThrow("boom")
    await drain(core.run("two"))
    expect(seen).toEqual([true, undefined])
  })

  it("per-run strict is restored after an aborted run", async () => {
    const seen: unknown[] = []
    const controller = new AbortController()
    const core = coreWith(strictSend(seen, controller), { outputStrict: true })
    await expect(
      drain(core.run("one", { outputStrict: false, signal: controller.signal })),
    ).rejects.toThrow()
    await drain(core.run("two"))
    expect(seen).toEqual([undefined, true])
  })

  it("setNextRunOutputStrict arms the next run only", async () => {
    const seen: unknown[] = []
    const core = coreWith(strictSend(seen))
    core.setNextRunOutputStrict(true)
    await drain(core.run("one"))
    await drain(core.run("two"))
    expect(seen).toEqual([true, undefined])
  })

  function registerSo(id: string, structuredOutputs: boolean): void {
    registerModel({
      id,
      providerId: "test-provider",
      surfaceId: "test",
      displayName: id,
      capabilities: { ...defaultCapabilities(), structuredOutputs },
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
  }

  it("warns once per run for a model without structuredOutputs, and the run succeeds", async () => {
    registerSo("so-no", false)
    const seen: unknown[] = []
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e) => events.push(e) })
    const core = coreWith(strictSend(seen), { model: "so-no", diagnostics, outputStrict: true })
    const { text } = await drain(core.run("one"))
    expect(text).toBe("done")
    const warns = events.filter((e) => e.source === "llm.strict-unsupported")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.severity).toBe(Severity.Warning)
    expect(warns[0]?.structuredData).toEqual({ model: "so-no" })
  })

  it("does not warn when the model has no registry entry", async () => {
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e) => events.push(e) })
    const core = coreWith(strictSend([]), { model: "not-registered", diagnostics })
    await drain(core.run("one", { outputStrict: true }))
    expect(events.filter((e) => e.source === "llm.strict-unsupported")).toEqual([])
  })
})

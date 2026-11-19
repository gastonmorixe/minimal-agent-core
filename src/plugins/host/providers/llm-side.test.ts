/**
 * `llm.request()` side call (C3, SPEC §3a M1/M2/M6/m2, §11).
 *
 * All sends go to an injected fake transport (`attemptFn`) and a fake auth
 * resolver. No network, no auth store, no write under the agent home.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "../../../llm/canonical-request.ts"
import type { UsageRecord } from "../../../llm/codec/usage-record.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../../llm/model-registry.ts"
import { clearProviderPlugins } from "../../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../../llm/test-fixtures.ts"
import { canonicalAttemptFn, canonicalSendFn } from "../../../llm/transport/canonical-send.ts"
import type { SendOptions, StreamedResponse } from "../../../llm/transport/types.ts"
import {
  addSessionEstimatedUsage,
  addSessionUsage,
  clearSessionTokens,
  getAuxUsageTotals,
  getSessionTokens,
} from "../../../session/session-tokens.ts"
import { Hooks } from "../../hooks/hooks.ts"
import type { UtilityModelRecommendation } from "../../types.ts"
import { buildPluginHost } from "../factory.ts"

import {
  clampSideTimeoutMs,
  createLlmSideRequest,
  DEFAULT_SIDE_ATTEMPT_FN,
  DEFAULT_SIDE_TIMEOUT_MS,
  type LlmSideDeps,
} from "./llm-side.ts"

const PROV = "side-prov-a"
const OTHER = "side-prov-b"
const CHEAP = "side-cheap-1"
const COSTLY = "side-costly-1"
const NOPRICE = "side-noprice-1"
const FREE = "side-free-1"
const FOREIGN = "side-foreign-1"
const COSTLY_OUT = "side-costly-out-1"
const AT_CEILING = "side-at-ceiling-1"

const SCHEMA = {
  name: "session_title",
  schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
}

type Fake = {
  calls: SendOptions[]
  fn: NonNullable<LlmSideDeps["attemptFn"]>
}

function response(text: string, extra: Partial<StreamedResponse> = {}): StreamedResponse {
  return { blocks: [], text, stopReason: "end_turn", ...extra }
}

/** A fake one-attempt transport. `body` runs once per call. */
function fakeAttempt(
  body: (opts: SendOptions) => Promise<StreamedResponse> | StreamedResponse,
): Fake {
  const calls: SendOptions[] = []
  return {
    calls,
    // biome-ignore lint/correctness/useYield: the fake yields no text delta.
    fn: async function* (opts: SendOptions) {
      calls.push(opts)
      return await body(opts)
    },
  }
}

/** Resolves when `signal` aborts (the fake "hangs" until then). */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return
    if (signal.aborted) reject(new Error("aborted"))
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
  })
}

function deps(fake: Fake, extra: Partial<LlmSideDeps> = {}): LlmSideDeps {
  return {
    attemptFn: fake.fn,
    resolveAuth: async () => ({ type: "oauth", token: "t", accountUuid: "a" }),
    sessionProviderId: () => PROV,
    ...extra,
  }
}

const BASE = { purpose: "title" as const, system: "sys", userText: "hello", timeoutMs: 5_000 }

let home: string
const prevHome = process.env.MINIMAL_AGENT_HOME

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ma-llm-side-"))
  process.env.MINIMAL_AGENT_HOME = join(home, ".minimal-agent")
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  clearSessionTokens()
  registerTestProvider({
    id: PROV,
    models: [
      { id: CHEAP, pricing: { inputUSD: 0.5, outputUSD: 2 } },
      { id: COSTLY, pricing: { inputUSD: 5, outputUSD: 25 } },
      { id: NOPRICE, pricing: { inputUSD: Number.NaN } },
      { id: FREE, pricing: { inputUSD: 0, outputUSD: 0 } },
      { id: COSTLY_OUT, pricing: { inputUSD: 0.5, outputUSD: 20 } },
      { id: AT_CEILING, pricing: { inputUSD: 1, outputUSD: 5 } },
    ],
  })
  registerTestProvider({ id: OTHER, models: [{ id: FOREIGN, pricing: { inputUSD: 0.1 } }] })
})

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  clearSessionTokens()
  rmSync(home, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = prevHome
})

describe("llm.request: request mapping", () => {
  it("maps schema, effort, thinking off, requestType and one signal", async () => {
    const fake = fakeAttempt(() => response('{"title":"Fix the build"}'))
    const request = createLlmSideRequest(deps(fake))
    const r = await request({
      ...BASE,
      model: CHEAP,
      outputSchema: SCHEMA,
      thinking: "off",
      effort: "low",
      maxTokens: 64,
    })
    expect(fake.calls.length).toBe(1)
    const o = fake.calls[0] as SendOptions
    expect(o.requestType).toBe("title")
    // R11: no provider recommendation ⇒ stream required.
    expect(o.stream).toBe(true)
    expect(o.system).toEqual([{ type: "text", text: "sys" }])
    expect(o.thinking).toBe(false)
    expect(o.model).toBe(CHEAP)
    expect(o.selectedProviderId).toBe(PROV)
    expect(o.maxTokens).toBe(64)
    expect(o.outputConfig?.effort).toBe("low")
    expect(o.outputConfig?.format).toEqual({
      type: "json_schema",
      schema: SCHEMA.schema,
      strict: true,
    } as never)
    expect(o.signal).toBeInstanceOf(AbortSignal)
    expect(r.stopReason).toBe("end_turn")
    expect(r.json).toEqual({ title: "Fix the build" })
    expect(r.text).toBe('{"title":"Fix the build"}')
    expect(r.model).toBe(CHEAP)
    expect(r.provider).toBe(PROV)
    expect(r.reason).toBeUndefined()
  })

  it("strict:false omits strict; thinking default sends no thinking key", async () => {
    const fake = fakeAttempt(() => response("{}"))
    await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: CHEAP,
      outputSchema: { ...SCHEMA, strict: false },
    })
    const o = fake.calls[0] as SendOptions
    expect(o.thinking).toBeUndefined()
    expect(o.outputConfig?.format).toEqual({ type: "json_schema", schema: SCHEMA.schema })
  })

  it("returns usage, stopReason and costUsd from the stream end", async () => {
    const usage: UsageRecord = {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 0,
    }
    const fake = fakeAttempt(() => response('{"title":"x"}', { stopReason: "max_tokens", usage }))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP })
    expect(r.stopReason).toBe("max_tokens")
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 100 })
    // 1000 × 0.5/1M + 100 × 2/1M
    expect(r.costUsd).toBeCloseTo(0.0007, 10)
    expect(r.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it("JSON parse failure gives reason invalid-json, keeps the text, no json", async () => {
    const fake = fakeAttempt(() => response("not json"))
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: CHEAP,
      outputSchema: SCHEMA,
    })
    expect(r.stopReason).toBe("end_turn")
    expect(r.reason).toBe("invalid-json")
    expect(r.json).toBeUndefined()
    expect(r.text).toBe("not json")
  })
})

describe("llm.request: bounded attempts (M1)", () => {
  it("a transient 529 error gives one attempt and stopReason error (no retry)", async () => {
    const fake = fakeAttempt(() => {
      throw Object.assign(new Error("overloaded"), { status: 529 })
    })
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP })
    expect(fake.calls.length).toBe(1)
    expect(r.stopReason).toBe("error")
    expect(r.reason).toBe("transport")
  })

  it("a 429 error gives one attempt and stopReason error", async () => {
    const fake = fakeAttempt(() => {
      throw Object.assign(new Error("rate limited"), { status: 429 })
    })
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP })
    expect(fake.calls.length).toBe(1)
    expect(r.stopReason).toBe("error")
  })

  it("timeout: the transport sees signal.aborted, stopReason timeout, one attempt", async () => {
    let seen: AbortSignal | undefined
    const fake = fakeAttempt((o) => {
      seen = o.signal
      return untilAborted(o.signal)
    })
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP, timeoutMs: 30 })
    expect(seen?.aborted).toBe(true)
    expect(r.stopReason).toBe("timeout")
    expect(r.reason).toBe("timeout")
    expect(fake.calls.length).toBe(1)
  })

  it("timeout also ends a transport that ignores the signal", async () => {
    const fake = fakeAttempt(() => new Promise<StreamedResponse>(() => {}))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP, timeoutMs: 20 })
    expect(r.stopReason).toBe("timeout")
    expect(fake.calls.length).toBe(1)
  })

  it("caller abort: the transport sees signal.aborted, stopReason aborted", async () => {
    const ac = new AbortController()
    let seen: AbortSignal | undefined
    const fake = fakeAttempt((o) => {
      seen = o.signal
      queueMicrotask(() => ac.abort())
      return untilAborted(o.signal)
    })
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: CHEAP,
      abortSignal: ac.signal,
    })
    expect(seen?.aborted).toBe(true)
    expect(r.stopReason).toBe("aborted")
    expect(fake.calls.length).toBe(1)
  })

  it("an already-aborted caller signal sends nothing", async () => {
    const ac = new AbortController()
    ac.abort()
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: CHEAP,
      abortSignal: ac.signal,
    })
    expect(fake.calls.length).toBe(0)
    expect(r.stopReason).toBe("aborted")
  })

  it("host shutdown aborts a call in flight", async () => {
    const shutdown = new AbortController()
    const fake = fakeAttempt((o) => {
      queueMicrotask(() => shutdown.abort())
      return untilAborted(o.signal)
    })
    const r = await createLlmSideRequest(deps(fake, { shutdownSignal: shutdown.signal }))({
      ...BASE,
      model: CHEAP,
    })
    expect(r.stopReason).toBe("aborted")
  })

  it("A1: an auth step that hangs ends at the timeout (stopReason timeout, no send)", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(
      deps(fake, { resolveAuth: () => new Promise<never>(() => {}) }),
    )({ ...BASE, model: CHEAP, timeoutMs: 30 })
    expect(r.stopReason).toBe("timeout")
    expect(r.reason).toBe("timeout")
    expect(fake.calls.length).toBe(0)
  })

  it("A1: a caller abort during a hanging auth step gives stopReason aborted", async () => {
    const ac = new AbortController()
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(
      deps(fake, {
        resolveAuth: () => {
          queueMicrotask(() => ac.abort())
          return new Promise<never>(() => {})
        },
      }),
    )({ ...BASE, model: CHEAP, abortSignal: ac.signal })
    expect(r.stopReason).toBe("aborted")
    expect(r.reason).toBe("aborted")
    expect(fake.calls.length).toBe(0)
  })

  it("A2: a bad timeoutMs (-1, NaN, Infinity, 0) does not throw; the call sends", async () => {
    for (const timeoutMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      const fake = fakeAttempt(() => response("{}"))
      const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP, timeoutMs })
      expect(fake.calls.length).toBe(1)
      expect(r.stopReason).toBe("end_turn")
    }
  })

  it("A2: clampSideTimeoutMs keeps the SPEC range 1-30 s, default 10 s", () => {
    expect(clampSideTimeoutMs(undefined)).toBe(DEFAULT_SIDE_TIMEOUT_MS)
    expect(clampSideTimeoutMs(-1)).toBe(DEFAULT_SIDE_TIMEOUT_MS)
    expect(clampSideTimeoutMs(Number.NaN)).toBe(DEFAULT_SIDE_TIMEOUT_MS)
    expect(clampSideTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDE_TIMEOUT_MS)
    expect(clampSideTimeoutMs(5)).toBe(1_000)
    expect(clampSideTimeoutMs(5_000)).toBe(5_000)
    expect(clampSideTimeoutMs(10_000_000)).toBe(30_000)
  })

  it("auth failure gives stopReason error, no send, no throw", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(
      deps(fake, {
        resolveAuth: async () => {
          throw new Error("no credential")
        },
      }),
    )({ ...BASE, model: CHEAP })
    expect(fake.calls.length).toBe(0)
    expect(r.stopReason).toBe("error")
    expect(r.reason).toBe("auth")
  })
})

describe("llm.request: model, price and provider gates (M2, M6)", () => {
  it("purpose title with no model: no send, reason no-model", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE })
    expect(fake.calls.length).toBe(0)
    expect(r.stopReason).toBe("error")
    expect(r.reason).toBe("no-model")
  })

  it("an unknown model id: no send", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: "side-missing-9" })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("unknown-model")
  })

  it("over the default title ceiling (1.0): no send, reason over-ceiling", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: COSTLY })
    expect(fake.calls.length).toBe(0)
    expect(r.stopReason).toBe("error")
    expect(r.reason).toBe("over-ceiling")
  })

  it("an explicit ceiling below the price: no send", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: CHEAP,
      maxUsdPerMTokIn: 0.25,
    })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("over-ceiling")
  })

  it("a raised ceiling allows the costly model", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: COSTLY,
      maxUsdPerMTokIn: 10,
      maxUsdPerMTokOut: 30,
    })
    expect(fake.calls.length).toBe(1)
    expect(r.reason).toBeUndefined()
  })

  it("B6: cheap input but costly output: no send at the default output ceiling (5)", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const request = createLlmSideRequest(deps(fake))
    const r = await request({ ...BASE, model: COSTLY_OUT })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("over-ceiling")
    expect(r.detail).toContain("output")
    const ok = await request({ ...BASE, model: COSTLY_OUT, maxUsdPerMTokOut: 25 })
    expect(fake.calls.length).toBe(1)
    expect(ok.reason).toBeUndefined()
  })

  it("B6: an output price at the ceiling passes (a $1 / $5 utility tier)", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({
      ...BASE,
      model: AT_CEILING,
    })
    expect(fake.calls.length).toBe(1)
    expect(r.reason).toBeUndefined()
  })

  it("B7: no purpose and no model: no send, no default-model fallback", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const { purpose: _p, ...noPurpose } = BASE
    const r = await createLlmSideRequest(deps(fake))(noPurpose)
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("no-model")
  })

  it("B7: purpose aux or summary gets the same default ceilings as title", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const request = createLlmSideRequest(deps(fake))
    const { purpose: _p, ...noPurpose } = BASE
    for (const req of [
      noPurpose,
      { ...BASE, purpose: "aux" as const },
      { ...BASE, purpose: "summary" as const },
    ]) {
      expect((await request({ ...req, model: COSTLY })).reason).toBe("over-ceiling")
      expect((await request({ ...req, model: COSTLY_OUT })).reason).toBe("over-ceiling")
      expect((await request({ ...req, model: NOPRICE })).reason).toBe("unknown-price")
    }
    expect(fake.calls.length).toBe(0)
    expect((await request({ ...noPurpose, model: CHEAP })).reason).toBeUndefined()
    expect(fake.calls.length).toBe(1)
  })

  it("a model with no known price: no send, reason unknown-price", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: NOPRICE })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("unknown-price")
  })

  it("a $0 (subscription or local) model passes the ceiling", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake))({ ...BASE, model: FREE })
    expect(fake.calls.length).toBe(1)
    expect(r.reason).toBeUndefined()
  })

  it("a model of another provider: no send, unless allowOtherProvider", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const request = createLlmSideRequest(deps(fake))
    const r = await request({ ...BASE, model: FOREIGN })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("other-provider")
    expect(r.provider).toBe(OTHER)

    const ok = await request({ ...BASE, model: FOREIGN, allowOtherProvider: true })
    expect(fake.calls.length).toBe(1)
    expect(ok.provider).toBe(OTHER)
    expect((fake.calls[0] as SendOptions).selectedProviderId).toBe(OTHER)
  })

  it("no known session provider: no send", async () => {
    const fake = fakeAttempt(() => response("{}"))
    const r = await createLlmSideRequest(deps(fake, { sessionProviderId: () => undefined }))({
      ...BASE,
      model: CHEAP,
    })
    expect(fake.calls.length).toBe(0)
    expect(r.reason).toBe("no-session-provider")
  })
})

describe("llm.request: aux usage frame (SPEC §3b)", () => {
  it("real usage goes to aux; turns and contextSize do not change", async () => {
    addSessionUsage({ input_tokens: 40, output_tokens: 2 })
    const before = getSessionTokens()
    const auxBefore = getAuxUsageTotals()
    const fake = fakeAttempt(() => {
      // canonical-send calls this sink at the stream end.
      addSessionUsage({ input_tokens: 300, output_tokens: 12 })
      return response('{"title":"x"}', { usage: { input_tokens: 300, output_tokens: 12 } })
    })
    await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP })
    const after = getSessionTokens()
    expect(after.turns).toBe(before.turns)
    expect(after.contextSize).toBe(before.contextSize)
    expect(after.input).toBe(before.input)
    const aux = getAuxUsageTotals()
    expect(aux.calls).toBe(auxBefore.calls + 1)
    expect(aux.inputTokens).toBe(auxBefore.inputTokens + 300)
    expect(aux.outputTokens).toBe(auxBefore.outputTokens + 12)
  })

  it("estimated usage goes to aux; turns do not change", async () => {
    const before = getSessionTokens()
    const auxBefore = getAuxUsageTotals()
    const fake = fakeAttempt(() => {
      addSessionEstimatedUsage(77)
      return response("{}")
    })
    await createLlmSideRequest(deps(fake))({ ...BASE, model: CHEAP })
    const after = getSessionTokens()
    expect(after.turns).toBe(before.turns)
    expect(after.contextSize).toBe(before.contextSize)
    expect(getAuxUsageTotals().calls).toBe(auxBefore.calls + 1)
  })
})

describe("plugin host: llm.request wiring and capability gating", () => {
  it("only a plugin with llm:complete gets request()", () => {
    expect(buildPluginHost({ capabilities: [] }).llm).toBeUndefined()
    expect(buildPluginHost({ capabilities: ["models:read"] }).llm).toBeUndefined()
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    expect(typeof host.llm?.request).toBe("function")
    expect(typeof host.llm?.complete).toBe("function")
  })

  it("host.llm.request uses the injected deps", async () => {
    const fake = fakeAttempt(() => response('{"title":"ok"}'))
    const host = buildPluginHost({ capabilities: ["llm:complete"], llmSide: deps(fake) })
    const r = await host.llm?.request?.({ ...BASE, model: CHEAP, outputSchema: SCHEMA })
    expect(fake.calls.length).toBe(1)
    expect(r?.json).toEqual({ title: "ok" })
  })
})

describe("plugin host: default attemptFn is one attempt (B4)", () => {
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH

  afterEach(() => {
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("the default transport is canonicalAttemptFn (not the retrying canonicalSendFn)", () => {
    expect(DEFAULT_SIDE_ATTEMPT_FN).toBe(canonicalAttemptFn)
    expect(DEFAULT_SIDE_ATTEMPT_FN).not.toBe(canonicalSendFn)
  })

  it("with no injected attemptFn, a transient error gives one adapter call", async () => {
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
    clearProviderRegistry()
    clearModelRegistry()
    clearProviderPlugins()
    const handle = registerTestProvider({
      id: PROV,
      models: [{ id: CHEAP, pricing: { inputUSD: 0.5, outputUSD: 2 } }],
    })
    let calls = 0
    // biome-ignore lint/correctness/useYield: the fake fails before any event.
    handle.adapter.run = async function* () {
      calls++
      throw Object.assign(new Error("overloaded"), { streamErrorType: "overloaded_error" })
    }
    const origRandom = Math.random
    Math.random = () => 0 // a retrying transport would loop with 0 ms backoff
    try {
      const host = buildPluginHost({
        capabilities: ["llm:complete"],
        llmSide: { sessionProviderId: () => PROV },
      })
      const r = await host.llm?.request?.({ ...BASE, model: CHEAP, timeoutMs: 1_000 })
      expect(calls).toBe(1)
      expect(r?.stopReason).toBe("error")
      expect((r as { reason?: string } | undefined)?.reason).toBe("transport")
    } finally {
      Math.random = origRandom
    }
  })
})

describe("plugin host: llm.complete usage goes to aux", () => {
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH

  afterEach(() => {
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("turns and contextSize do not change after complete()", async () => {
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
    clearProviderRegistry()
    clearModelRegistry()
    clearProviderPlugins()
    const handle = registerTestProvider({ id: PROV, models: [{ id: CHEAP }] })
    handle.adapter.run = async function* () {
      yield {
        type: "message_start",
        messageId: "m1",
        modelId: CHEAP,
        initialUsage: { inputTokens: 50, outputTokens: 0 },
      }
      yield { type: "text_delta", index: 0, text: "summary" }
      yield {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 50, outputTokens: 4 },
      }
      yield { type: "message_stop" }
    }
    const before = getSessionTokens()
    const auxBefore = getAuxUsageTotals()
    const host = buildPluginHost({ capabilities: ["llm:complete"] })
    const text = await host.llm?.complete({ model: CHEAP, system: "s", userText: "u" })
    expect(text).toBe("summary")
    const after = getSessionTokens()
    expect(after.turns).toBe(before.turns)
    expect(after.contextSize).toBe(before.contextSize)
    expect(getAuxUsageTotals().calls).toBeGreaterThan(auxBefore.calls)
  })
})

describe("llm.request: wire shape (R10 minimal call, R11 profile, G1, G2)", () => {
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
  beforeEach(() => {
    // The fake adapter's credential comes from the test auth hook (no store).
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
  })
  afterEach(() => {
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  const PREAMBLE_A = { type: "text" as const, text: "fake-preamble-a" }
  const PREAMBLE_B = { type: "text" as const, text: "fake-preamble-b" }

  type Wire = {
    reqs: CanonicalRequest[]
    sends: SendOptions[]
    authKinds: string[]
    preambleCalls: { identity: string; body: unknown[]; authKind: string; modelId: string }[]
  }

  /**
   * A provider-neutral fake provider plugin + adapter. The adapter records the
   * CanonicalRequest it gets; the real one-attempt transport runs. The fake
   * attempt wrapper records the SendOptions too.
   */
  function wire(opts: {
    recommend?: () => UtilityModelRecommendation | undefined
    preamble?: boolean
  }): { w: Wire; request: ReturnType<typeof createLlmSideRequest> } {
    clearProviderRegistry()
    clearModelRegistry()
    clearProviderPlugins()
    const handle = registerTestProvider({
      id: PROV,
      models: [{ id: CHEAP, pricing: { inputUSD: 0.5, outputUSD: 2 } }],
    })
    const w: Wire = { reqs: [], sends: [], authKinds: [], preambleCalls: [] }
    if (opts.preamble !== false) {
      handle.plugin.resolveSystemPrompt = (ctx) => {
        w.preambleCalls.push({
          identity: ctx.identity,
          body: ctx.body,
          authKind: ctx.authKind,
          modelId: ctx.modelId,
        })
        return [PREAMBLE_A, { type: "text", text: ctx.identity }, PREAMBLE_B, ...ctx.body]
      }
    } else {
      delete (handle.plugin as { resolveSystemPrompt?: unknown }).resolveSystemPrompt
    }
    if (opts.recommend) handle.adapter.recommendUtilityModel = opts.recommend
    handle.adapter.run = async function* (req, _model, ctx) {
      w.reqs.push(req)
      w.authKinds.push(ctx.auth.kind)
      yield {
        type: "message_start",
        messageId: "m1",
        modelId: CHEAP,
        initialUsage: { inputTokens: 20, outputTokens: 0 },
      }
      yield { type: "text_delta", index: 0, text: '{"title":"Fix the build"}' }
      yield {
        type: "message_delta",
        stopReason: "end_turn",
        usage: { inputTokens: 20, outputTokens: 6 },
      }
      yield { type: "message_stop" }
    }
    const request = createLlmSideRequest({
      attemptFn: (o: SendOptions) => {
        w.sends.push(o)
        return canonicalAttemptFn(o)
      },
      resolveAuth: async () => ({ type: "api-key", token: "fake-key" }),
      sessionProviderId: () => PROV,
    })
    return { w, request }
  }

  const CALL = {
    purpose: "title" as const,
    model: CHEAP,
    system: "Write a short title.",
    userText: "user text",
    outputSchema: SCHEMA,
    effort: "low" as const,
    thinking: "off" as const,
    maxTokens: 77,
    timeoutMs: 5_000,
  }

  it("(a) system = provider preamble blocks + the instruction; empty blocks dropped", async () => {
    const { w, request } = wire({})
    const r = await request(CALL)
    expect(r.json).toEqual({ title: "Fix the build" })
    expect(w.preambleCalls).toEqual([
      {
        identity: "",
        body: [{ type: "text", text: "Write a short title." }],
        authKind: "api-key",
        modelId: CHEAP,
      },
    ])
    expect(w.reqs.length).toBe(1)
    const sys = (w.reqs[0]?.system ?? []).map((b) => (b as { text: string }).text)
    expect(sys).toEqual(["fake-preamble-a", "fake-preamble-b", "Write a short title."])
  })

  it("(a) no provider resolveSystemPrompt: the instruction is the only block", async () => {
    const { w, request } = wire({ preamble: false })
    await request(CALL)
    const sys = (w.reqs[0]?.system ?? []).map((b) => (b as { text: string }).text)
    expect(sys).toEqual(["Write a short title."])
  })

  it("(b) no tools, (c) exactly one user message, (g) max_tokens is the caller value", async () => {
    const { w, request } = wire({})
    await request(CALL)
    const req = w.reqs[0] as CanonicalRequest
    expect(req.tools).toBeUndefined()
    expect(w.sends[0]?.tools).toBeUndefined()
    expect(req.messages.length).toBe(1)
    expect(req.messages[0]?.role).toBe("user")
    expect(req.generation?.maxOutputTokens).toBe(77)
    expect(req.purpose).toBe("title")
  })

  it("(d) outputConfig json_schema + effort reach the adapter", async () => {
    const { w, request } = wire({})
    await request(CALL)
    const req = w.reqs[0] as CanonicalRequest
    expect(req.effort).toBe("low")
    expect(req.outputFormat?.type).toBe("json_schema")
    expect((req.outputFormat as { schema?: unknown }).schema).toEqual(SCHEMA.schema)
    expect(w.sends[0]?.outputConfig?.effort).toBe("low")
  })

  it('(e) stream false only when the profile says "off"', async () => {
    const off = wire({
      recommend: () => ({ modelId: CHEAP, structured: "json_schema", stream: "off" }),
    })
    const r = await off.request(CALL)
    expect(off.w.reqs[0]?.stream).toBe(false)
    expect(off.w.sends[0]?.stream).toBe(false)
    expect(r.json).toEqual({ title: "Fix the build" })

    const req = wire({
      recommend: () => ({ modelId: CHEAP, structured: "json_schema", stream: "required" }),
    })
    await req.request(CALL)
    expect(req.w.reqs[0]?.stream).toBe(true)

    const absent = wire({ recommend: () => ({ modelId: CHEAP, structured: "json_schema" }) })
    await absent.request(CALL)
    expect(absent.w.reqs[0]?.stream).toBe(true)

    const none = wire({})
    await none.request(CALL)
    expect(none.w.reqs[0]?.stream).toBe(true)

    // "off" for another model does not apply to this model.
    const other = wire({
      recommend: () => ({ modelId: "some-other-model", structured: "json_schema", stream: "off" }),
    })
    await other.request(CALL)
    expect(other.w.reqs[0]?.stream).toBe(true)
  })

  it("(f) no message.willSend / message.didSend hook runs", async () => {
    const hooks = new Hooks({ logger: () => {} })
    let willSend = 0
    let didSend = 0
    hooks.on(
      "message.willSend",
      (p: unknown) => {
        willSend++
        return p
      },
      { caller: "plugin" },
    )
    hooks.on(
      "message.didSend",
      () => {
        didSend++
      },
      { caller: "plugin" },
    )
    // Spy on every Hooks instance: the side path must emit no message.* channel.
    const emitted: string[] = []
    const proto = Hooks.prototype as unknown as Record<string, (...a: unknown[]) => unknown>
    const names = ["emitAsync", "emitSync", "emitChain"] as const
    const orig = names.map((n) => proto[n])
    for (const [i, n] of names.entries()) {
      const fn = orig[i] as (...a: unknown[]) => unknown
      proto[n] = function (this: unknown, ...a: unknown[]) {
        emitted.push(String(a[0]))
        return fn.apply(this, a)
      }
    }
    try {
      const { w, request } = wire({})
      const r = await request(CALL)
      expect(w.reqs.length).toBe(1)
      expect(r.stopReason).toBe("end_turn")
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      for (const [i, n] of names.entries()) proto[n] = orig[i] as (...a: unknown[]) => unknown
    }
    expect(willSend).toBe(0)
    expect(didSend).toBe(0)
    expect(emitted.filter((c) => c.startsWith("message."))).toEqual([])
  })
})

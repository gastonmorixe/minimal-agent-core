import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../llm/model-registry.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"

import {
  type CacheSendState,
  createCacheSendState,
  isThinkingHistoryRejection,
  keepsThinkingHistory,
} from "./cache-send-policy.ts"
import { RunOutputStrict } from "./run-output-strict.ts"
import { emptyRunTemperature } from "./run-temperature.ts"
import { type SendAttemptDeps, sendAttemptInto } from "./send-attempt.ts"

/** `explicitCache` stands for a wire with per-block cache markers (Messages shape). */
function entry(
  id: string,
  explicitCache: boolean,
  priorThinking?: "keep-all" | "last-turn-only",
): ModelEntry {
  const base = defaultCapabilities()
  return {
    id,
    providerId: "test-provider",
    surfaceId: explicitCache ? "messages-shape" : "chat-shape",
    displayName: id,
    capabilities: {
      ...base,
      caching: { ...base.caching, explicit: explicitCache },
      ...(priorThinking ? { priorThinking } : {}),
    },
    pricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0 },
  } as ModelEntry
}

const think = (t: string) => ({ type: "thinking", thinking: t, signature: `sig-${t}` }) as const

/** Two finished tool rounds + a pending tool_result: the round-3 request. */
function history(): Message[] {
  return [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [think("t0"), { type: "tool_use", id: "u0", name: "R", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u0", content: "ok" }] },
    {
      role: "assistant",
      content: [think("t1"), { type: "tool_use", id: "u1", name: "R", input: {} }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] },
  ] as Message[]
}

const THINKING_400 =
  "Provider API 400: messages.1.content.0: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response."

/** A fake transport: records each request; the first `fail` sends throw. */
function fakeSend(fail: Array<unknown>) {
  const seen: SendOptions[] = []
  const sendFn = async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
    seen.push(opts)
    const err = fail.shift()
    if (err !== undefined) throw err
    yield "done"
    return { blocks: [{ type: "text", text: "done" }], text: "done", stopReason: "end_turn" }
  }
  return { seen, sendFn }
}

function deps(
  model: string,
  cacheSend: CacheSendState | undefined,
  sendFn: SendAttemptDeps["sendFn"],
  warns: string[],
): SendAttemptDeps {
  return {
    runOutputSchema: undefined,
    outputSchema: undefined,
    strict: new RunOutputStrict(false),
    model,
    providerId: "test-provider",
    messages: history(),
    diagnostics: createDiagnostics({
      emit: (e) => {
        if (e.severity === Severity.Warning) warns.push(`${e.source}: ${e.message}`)
      },
    }),
    credentialName: undefined,
    networkClient: undefined,
    effort: undefined,
    runTemp: emptyRunTemperature(),
    speed: "normal",
    serviceTier: undefined,
    thinkingDisplay: undefined,
    defaultStatusPort: undefined,
    defaultPluginEvents: undefined,
    cacheTtl: "5m",
    ...(cacheSend ? { cacheSend } : {}),
    auth: { kind: "api-key", token: "x" } as unknown as AuthResult,
    sendFn,
    emit: () => {},
  }
}

async function drain(gen: AsyncGenerator<string, unknown>): Promise<unknown> {
  while (true) {
    const r = await gen.next()
    if (r.done) return r.value
  }
}

const hasThinking = (m: Message) =>
  typeof m.content !== "string" && m.content.some((b) => b.type === "thinking")

describe("cache send policy (F2 gate)", () => {
  afterEach(() => clearModelRegistry())

  it("keeps only for a keep-all model on an explicit-cache wire with the flag on", () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    registerModel(entry("last-msg", true, "last-turn-only"))
    registerModel(entry("nodata-msg", true))
    registerModel(entry("keep-chat", false, "keep-all"))
    const keep = createCacheSendState({ thinkingHistory: "keep" })
    const strip = createCacheSendState({})
    expect(keepsThinkingHistory(keep, "keep-msg", "test-provider")).toBe(true)
    expect(keepsThinkingHistory(strip, "keep-msg", "test-provider")).toBe(false)
    expect(keepsThinkingHistory(keep, "last-msg", "test-provider")).toBe(false)
    expect(keepsThinkingHistory(keep, "nodata-msg", "test-provider")).toBe(false)
    expect(keepsThinkingHistory(keep, "keep-chat", "test-provider")).toBe(false)
    expect(keepsThinkingHistory(keep, "unknown-model", "test-provider")).toBe(false)
    expect(keepsThinkingHistory(undefined, "keep-msg", "test-provider")).toBe(false)
  })

  it("requires a providerId: no cross-provider model lookup (L4)", () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const keep = createCacheSendState({ thinkingHistory: "keep" })
    expect(keepsThinkingHistory(keep, "keep-msg", undefined)).toBe(false)
    expect(keepsThinkingHistory(keep, "keep-msg", "")).toBe(false)
    expect(keepsThinkingHistory(keep, "keep-msg", "test-provider")).toBe(true)
  })

  it("classifies the thinking 400s and nothing else", () => {
    const e400 = (m: string) => Object.assign(new Error(m), { status: 400 })
    expect(isThinkingHistoryRejection(new Error(THINKING_400))).toBe(true)
    expect(
      isThinkingHistoryRejection(
        e400("messages.3.content.0: Invalid `signature` in `thinking` block"),
      ),
    ).toBe(true)
    expect(isThinkingHistoryRejection(e400("prompt is too long"))).toBe(false)
    // L1: a 400 about a signature that does not name thinking is not matched.
    expect(isThinkingHistoryRejection(e400("invalid request signature for webhook"))).toBe(false)
    expect(isThinkingHistoryRejection(e400("Invalid `signature` header"))).toBe(false)
    expect(
      isThinkingHistoryRejection(new Error("Provider API 500: thinking cannot be modified")),
    ).toBe(false)
  })
})

describe("sendAttemptInto with the cache flags", () => {
  afterEach(() => clearModelRegistry())

  it("default (no flags): strip plus the anchor marker (the anchor is ON by default)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([])
    const { seen: seen2, sendFn: sendFn2 } = fakeSend([])
    await drain(sendAttemptInto(deps("keep-msg", undefined, sendFn, []), { sendOpts: {} }, 1))
    await drain(
      sendAttemptInto(deps("keep-msg", createCacheSendState({}), sendFn2, []), { sendOpts: {} }, 1),
    )
    const { withRollingCacheBreakpoint } = await import("../agent/cache.ts")
    const anchored = JSON.stringify(withRollingCacheBreakpoint(history(), "5m", { anchor: true }))
    expect(JSON.stringify(seen[0].messages)).toBe(anchored)
    expect(JSON.stringify(seen2[0].messages)).toBe(anchored)
    expect(hasThinking(seen2[0].messages[1])).toBe(false)
  })

  it("cacheAnchor: false: the request messages are byte-identical to the legacy build", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([])
    const state = createCacheSendState({ cacheAnchor: false })
    expect(state.anchor).toBe(false)
    await drain(sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1))
    const { withRollingCacheBreakpoint } = await import("../agent/cache.ts")
    const legacy = JSON.stringify(withRollingCacheBreakpoint(history(), "5m"))
    expect(JSON.stringify(seen[0].messages)).toBe(legacy)
  })

  it("createCacheSendState: undefined is ON, only false is off, thinking stays strip", () => {
    expect(createCacheSendState({})).toMatchObject({ anchor: true, thinkingHistory: "strip" })
    expect(createCacheSendState({ cacheAnchor: true }).anchor).toBe(true)
    expect(createCacheSendState({ cacheAnchor: false }).anchor).toBe(false)
  })

  it("keep mode on a keep-all model sends the older thinking", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([])
    const state = createCacheSendState({ thinkingHistory: "keep", cacheAnchor: true })
    await drain(sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1))
    expect(hasThinking(seen[0].messages[1])).toBe(true)
    const anchor = (seen[0].messages[2].content as Array<{ cache_control?: unknown }>)[0]
    expect(anchor.cache_control).toEqual({ type: "ephemeral", ttl: "5m" })
  })

  it("keep mode on a last-turn-only model keeps today's strip", async () => {
    registerModel(entry("last-msg", true, "last-turn-only"))
    const { seen, sendFn } = fakeSend([])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    await drain(sendAttemptInto(deps("last-msg", state, sendFn, []), { sendOpts: {} }, 1))
    expect(hasThinking(seen[0].messages[1])).toBe(false)
  })

  it("F2b: a thinking 400 retries the same turn once stripped, latches strip, warns once", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const warns: string[] = []
    const { seen, sendFn } = fakeSend([new Error(THINKING_400)])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    const result = (await drain(
      sendAttemptInto(deps("keep-msg", state, sendFn, warns), { sendOpts: {} }, 1),
    )) as { kind: string }
    expect(result.kind).toBe("response")
    expect(seen.length).toBe(2)
    expect(hasThinking(seen[0].messages[1])).toBe(true)
    expect(hasThinking(seen[1].messages[1])).toBe(false)
    expect(state.stripLatched).toBe(true)
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain("cache.thinking-fallback")
    expect(warns[0]).toContain("cannot be modified")
    // Later sends of the session stay stripped, with no new warn.
    const { seen: later, sendFn: sendLater } = fakeSend([])
    await drain(sendAttemptInto(deps("keep-msg", state, sendLater, warns), { sendOpts: {} }, 2))
    expect(hasThinking(later[0].messages[1])).toBe(false)
    expect(warns.length).toBe(1)
  })

  it("F2b: the retry sends the same messages (same length, same tool_result) (L7)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([new Error(THINKING_400)])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    await drain(sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1))
    expect(seen.length).toBe(2)
    expect(seen[1].messages.length).toBe(seen[0].messages.length)
    const toolResults = (ms: Message[]) =>
      JSON.stringify(
        ms.flatMap((m) =>
          typeof m.content === "string"
            ? []
            : m.content
                .filter((b) => b.type === "tool_result")
                .map((b) => {
                  const { cache_control: _c, ...rest } = b as { cache_control?: unknown }
                  return rest
                }),
        ),
      )
    expect(toolResults(seen[1].messages)).toBe(toolResults(seen[0].messages))
    expect(seen[1].messages.map((m) => m.role)).toEqual(seen[0].messages.map((m) => m.role))
  })

  it("F2b: a 400 with 'signature' that is not about thinking is not retried (L1)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const err = Object.assign(new Error("Provider API 400: invalid request signature"), {
      status: 400,
    })
    const { seen, sendFn } = fakeSend([err])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    const result = (await drain(
      sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1),
    )) as { kind: string }
    expect(result.kind).toBe("error")
    expect(seen.length).toBe(1)
    expect(state.stripLatched).toBe(false)
  })

  it("F2b: the warn cuts a long server error text to about 300 chars (L2)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const warns: string[] = []
    const long = `${THINKING_400} ${"x".repeat(5000)}`
    const { sendFn } = fakeSend([new Error(long)])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    await drain(sendAttemptInto(deps("keep-msg", state, sendFn, warns), { sendOpts: {} }, 1))
    expect(warns.length).toBe(1)
    expect(warns[0]).toContain("cannot be modified")
    expect(warns[0].length).toBeLessThan(500)
    expect(warns[0]).not.toContain("x".repeat(400))
  })

  it("F2b: a mid-stream error after yielded output is not retried (L7)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const seen: SendOptions[] = []
    const sendFn = async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse> {
      seen.push(opts)
      yield "partial"
      throw new Error(THINKING_400)
    }
    const state = createCacheSendState({ thinkingHistory: "keep" })
    const result = (await drain(
      sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1),
    )) as { kind: string }
    expect(result.kind).toBe("error")
    expect(seen.length).toBe(1)
    expect(state.stripLatched).toBe(false)
  })

  it("F2b: an unrelated 400 is not retried", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([new Error("Provider API 400: prompt is too long")])
    const state = createCacheSendState({ thinkingHistory: "keep" })
    const result = (await drain(
      sendAttemptInto(deps("keep-msg", state, sendFn, []), { sendOpts: {} }, 1),
    )) as { kind: string }
    expect(result.kind).toBe("error")
    expect(seen.length).toBe(1)
    expect(state.stripLatched).toBe(false)
  })

  it("F2b: strip mode never retries a thinking 400 (today's behavior)", async () => {
    registerModel(entry("keep-msg", true, "keep-all"))
    const { seen, sendFn } = fakeSend([new Error(THINKING_400)])
    const result = (await drain(
      sendAttemptInto(deps("keep-msg", createCacheSendState({}), sendFn, []), { sendOpts: {} }, 1),
    )) as { kind: string }
    expect(result.kind).toBe("error")
    expect(seen.length).toBe(1)
  })
})

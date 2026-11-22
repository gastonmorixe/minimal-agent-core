/**
 * Plan B-4 (step B5): when a `message.willSend` listener changes the
 * messages, the wrap sizes the output budget again with the same function as
 * the sender (`resolveMaxOutputTokens`). A model whose output shares the
 * context window then gets a smaller `maxTokens`, not a
 * `context_length_exceeded`. An unchanged payload keeps the same value.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { DEFAULT_OUTPUT_SAFETY_MARGIN, MIN_OUTPUT_TOKENS } from "../llm/context-budget.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../llm/model-registry.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import { allowDecision, type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { resolveMaxOutputTokens } from "./run-temperature.ts"
import { wrapTransportWithLifecycle } from "./with-lifecycle-send.ts"

const MODEL = "t-shared-budget"
const PROVIDER = "p-budget"
const ONE_MB = 1_000_000

function entry(share: boolean): ModelEntry {
  return {
    id: MODEL,
    providerId: PROVIDER,
    surfaceId: "test",
    displayName: MODEL,
    capabilities: {
      ...defaultCapabilities(),
      contextWindow: 2_000_000,
      maxOutputTokens: 1_500_000,
      outputTokensShareContextWindow: share,
    },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  } as ModelEntry
}

/** A hook that grows the last user message by about 1 MB (a new array). */
const GROW: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    const messages: Message[] = payload.messages.map((m) =>
      m.role === "user" && typeof m.content === "string"
        ? { ...m, content: `${m.content}${"x".repeat(ONE_MB)}` }
        : m,
    )
    return allowDecision({ ...payload, messages })
  },
}

/** A hook that gives the payload back with no change (the same array). */
const SAME: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    return allowDecision(payload)
  },
}

/** A hook that gives a copy of the messages with the same text. */
const COPY: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    return allowDecision({ ...payload, messages: payload.messages.map((m) => ({ ...m })) })
  },
}

/** A hook that pushes a ~1 MB message into the SAME array (an edit in place). */
const PUSH_IN_PLACE: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    payload.messages.push({ role: "user", content: "x".repeat(ONE_MB) })
    return allowDecision(payload)
  },
}

/** A hook that changes only the system (it adds ~1 MB of text). */
const GROW_SYSTEM: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    return allowDecision({ ...payload, system: "x".repeat(ONE_MB) })
  },
}

/** A hook that grows the input over the full context window. */
const OVER_WINDOW: LifecyclePort = {
  ...NOOP_LIFECYCLE,
  async beforeSend(payload) {
    return allowDecision({ ...payload, system: "x".repeat(2_100_000) })
  },
}

type Tools = NonNullable<SendOptions["tools"]>

async function sentMaxTokens(lifecycle: LifecyclePort, tools?: Tools): Promise<number | undefined> {
  const calls: SendOptions[] = []
  const inner: TransportFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    calls.push(opts)
    return { blocks: [], text: "", stopReason: "end_turn" }
  }
  const messages: Message[] = [{ role: "user", content: "hello" }]
  // The sender sizes the cap before the hook, as send-attempt does.
  const maxTokens = resolveMaxOutputTokens(MODEL, PROVIDER, messages, tools ? { tools } : {})
  const gen = wrapTransportWithLifecycle(
    inner,
    lifecycle,
  )({
    auth: { type: "api_key", apiKey: "k" } as never,
    messages,
    model: MODEL,
    selectedProviderId: PROVIDER,
    ...(tools ? { tools } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  })
  while (!(await gen.next()).done) {
    /* drain */
  }
  return calls[0]?.maxTokens
}

/** The cap for `input` bytes of input on the shared 2M window (no estimator). */
const capFor = (input: number): number => 2_000_000 - input - DEFAULT_OUTPUT_SAFETY_MARGIN

describe("wrapTransportWithLifecycle: output budget after message.willSend", () => {
  afterEach(() => clearModelRegistry())

  test("a hook that grows a message by ~1 MB gives a smaller maxTokens (shared window)", async () => {
    registerModel(entry(true))
    const before = await sentMaxTokens(NOOP_LIFECYCLE)
    const after = await sentMaxTokens(GROW)
    expect(before).toBe(1_500_000)
    // No estimator: the UTF-8 byte count is the input upper bound.
    expect(after).toBe(2_000_000 - (ONE_MB + "hello".length) - DEFAULT_OUTPUT_SAFETY_MARGIN)
    expect(after as number).toBeLessThan(before as number)
  })

  test("an unchanged payload keeps the same maxTokens", async () => {
    registerModel(entry(true))
    const base = await sentMaxTokens(NOOP_LIFECYCLE)
    expect(await sentMaxTokens(SAME)).toBe(base)
    expect(await sentMaxTokens(COPY)).toBe(base)
  })

  test("a model whose output does not share the window keeps its cap", async () => {
    registerModel(entry(false))
    expect(await sentMaxTokens(GROW)).toBe(1_500_000)
  })

  test("an unknown model keeps the request as it is (no maxTokens added)", async () => {
    expect(await sentMaxTokens(GROW)).toBeUndefined()
  })

  test("a hook that pushes into the same array in place gets a smaller maxTokens", async () => {
    registerModel(entry(true))
    expect(await sentMaxTokens(PUSH_IN_PLACE)).toBe(capFor(ONE_MB + "hello".length))
  })

  test("a change of the system only gives a smaller maxTokens", async () => {
    registerModel(entry(true))
    expect(await sentMaxTokens(GROW_SYSTEM)).toBe(capFor(ONE_MB + "hello".length))
  })

  test("an input over the window gets the floor (MIN_OUTPUT_TOKENS)", async () => {
    registerModel(entry(true))
    expect(await sentMaxTokens(OVER_WINDOW)).toBe(MIN_OUTPUT_TOKENS)
  })

  test("tools count in the estimate: a large tool schema gives a smaller cap", async () => {
    registerModel(entry(true))
    const schema = { type: "object", description: "y".repeat(200_000) }
    const tools: Tools = [{ name: "Big", description: "d", input_schema: schema }]
    const toolBytes = "Big".length + "d".length + JSON.stringify(schema).length
    const plain = await sentMaxTokens(GROW)
    const withTools = await sentMaxTokens(GROW, tools)
    expect(plain).toBe(capFor(ONE_MB + "hello".length))
    expect(withTools).toBe(capFor(ONE_MB + "hello".length + toolBytes))
  })

  // The full path: send-attempt sizes the cap (resolveMaxOutputTokens), then
  // the AgentCore transport wrap runs the hook and sizes it again.
  test("AgentCore.run: the request after a growing hook has the smaller cap", async () => {
    registerModel(entry(true))
    const sent = async (lifecycle: LifecyclePort): Promise<number | undefined> => {
      const requests: SendOptions[] = []
      const sendFn: TransportFn = async function* (opts) {
        requests.push(opts)
        return { blocks: [{ type: "text", text: "ok" }], text: "ok", stopReason: "end_turn" }
      }
      const agent = new AgentCore({
        auth: { type: "api-key", token: "t" },
        model: MODEL,
        systemPrompt: "",
        maxTokens: 4096,
        toolRegistry: { list: () => [] },
        toolExecutor: { execute: async () => ({ content: "", isError: false }) },
        eventSink: { emit: () => {} },
        sendFn,
        lifecycle,
      })
      const gen: AsyncGenerator<string, TurnResult, undefined> = agent.run("hello")
      while (!(await gen.next()).done) {
        /* drain */
      }
      return requests[0]?.maxTokens
    }
    const before = await sent(SAME)
    const after = await sent(PUSH_IN_PLACE)
    expect(before).toBe(1_500_000)
    // The core adds its own small text, so the cap is at most the 1 MB cap.
    expect(after as number).toBeLessThanOrEqual(capFor(ONE_MB))
    expect(after as number).toBeGreaterThan(capFor(ONE_MB + 10_000))
  })
})

/**
 * Plan B-4 (step B5): when a `message.willSend` listener changes the
 * messages, the wrap sizes the output budget again with the same function as
 * the sender (`resolveMaxOutputTokens`). A model whose output shares the
 * context window then gets a smaller `maxTokens`, not a
 * `context_length_exceeded`. An unchanged payload keeps the same value.
 */

import { afterEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { DEFAULT_OUTPUT_SAFETY_MARGIN } from "../llm/context-budget.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../llm/model-registry.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

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

async function sentMaxTokens(lifecycle: LifecyclePort): Promise<number | undefined> {
  const calls: SendOptions[] = []
  const inner: TransportFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    calls.push(opts)
    return { blocks: [], text: "", stopReason: "end_turn" }
  }
  const messages: Message[] = [{ role: "user", content: "hello" }]
  // The sender sizes the cap before the hook, as send-attempt does.
  const maxTokens = resolveMaxOutputTokens(MODEL, PROVIDER, messages)
  const gen = wrapTransportWithLifecycle(
    inner,
    lifecycle,
  )({
    auth: { type: "api_key", apiKey: "k" } as never,
    messages,
    model: MODEL,
    selectedProviderId: PROVIDER,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  })
  while (!(await gen.next()).done) {
    /* drain */
  }
  return calls[0]?.maxTokens
}

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
})

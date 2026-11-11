import { describe, expect, test } from "bun:test"

import type { ContentBlock } from "../llm/messages.ts"
import type {
  SendOptions,
  StreamedResponse,
  SystemBlock,
  TransportFn,
} from "../llm/transport/types.ts"

import {
  allowDecision,
  denyDecision,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type SendSnapshot,
} from "./lifecycle.ts"
import {
  LifecycleSendDeniedError,
  requestView,
  wrapTransportWithLifecycle,
} from "./with-lifecycle-send.ts"

function stubTransport(calls: SendOptions[]): TransportFn {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    calls.push(opts)
    yield "hi"
    return { blocks: [{ type: "text", text: "hi" }], text: "hi", stopReason: "end_turn" }
  }
}

describe("wrapTransportWithLifecycle", () => {
  test("deny skips inner transport", async () => {
    const calls: SendOptions[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend() {
        return denyDecision("secrets")
      },
    }
    const wrapped = wrapTransportWithLifecycle(stubTransport(calls), lifecycle)
    await expect(
      (async () => {
        const g = wrapped({
          auth: { type: "api_key", apiKey: "k" } as never,
          messages: [],
          model: "m",
        })
        await g.next()
      })(),
    ).rejects.toBeInstanceOf(LifecycleSendDeniedError)
    expect(calls).toHaveLength(0)
  })

  test("allow with rewritten messages reaches transport", async () => {
    const calls: SendOptions[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        return allowDecision({
          ...p,
          messages: [{ role: "user", content: "redacted" }],
        })
      },
    }
    const wrapped = wrapTransportWithLifecycle(stubTransport(calls), lifecycle)
    const g = wrapped({
      auth: { type: "api_key", apiKey: "k" } as never,
      messages: [{ role: "user", content: "sk-SECRET" }],
      model: "m",
    })
    const first = await g.next()
    expect(first.value).toBe("hi")
    await g.next()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.messages).toEqual([{ role: "user", content: "redacted" }])
  })
})

describe("wrapTransportWithLifecycle: snapshot request view", () => {
  const tools = [{ name: "Read", description: "read a file", input_schema: { type: "object" } }]

  test("listener sees tools and request options, transport gets them unchanged", async () => {
    const calls: SendOptions[] = []
    let seen: SendSnapshot | undefined
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        seen = p
        return allowDecision(p)
      },
    }
    const wrapped = wrapTransportWithLifecycle(stubTransport(calls), lifecycle)
    const g = wrapped({
      auth: { type: "api_key", apiKey: "k" } as never,
      messages: [{ role: "user", content: "hi" }],
      model: "m",
      requestType: "conversation",
      tools,
      maxTokens: 1234,
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "high" },
      temperature: 0.2,
    })
    while (!(await g.next()).done) {
      /* drain */
    }
    expect(seen?.request).toEqual({
      requestType: "conversation",
      tools,
      maxTokens: 1234,
      thinking: { type: "adaptive", display: "summarized" },
      outputConfig: { effort: "high" },
      temperature: 0.2,
    })
    expect(seen?.compact).toBeUndefined()
    expect(calls[0]?.tools).toBe(tools)
    expect(calls[0]?.maxTokens).toBe(1234)
  })

  test("listener edits to request are ignored (read-only view)", async () => {
    const calls: SendOptions[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        return allowDecision({ ...p, request: { maxTokens: 1, tools: [] } })
      },
    }
    const wrapped = wrapTransportWithLifecycle(stubTransport(calls), lifecycle)
    const g = wrapped({
      auth: { type: "api_key", apiKey: "k" } as never,
      messages: [],
      model: "m",
      tools,
      maxTokens: 99,
    })
    while (!(await g.next()).done) {
      /* drain */
    }
    expect(calls[0]?.tools).toBe(tools)
    expect(calls[0]?.maxTokens).toBe(99)
  })

  test("requestView copies only keys that are set", () => {
    expect(requestView({ auth: {} as never, messages: [], model: "m", maxTokens: 5 })).toEqual({
      maxTokens: 5,
    })
    expect(requestView({ auth: {} as never, messages: [] })).toEqual({})
  })
})

describe("wrapTransportWithLifecycle: system cache_control survives the wrap", () => {
  const SYSTEM: SystemBlock[] = [
    { type: "text", text: "billing" },
    {
      type: "text",
      text: "static",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
    { type: "text", text: "session ctx", cache_control: { type: "ephemeral", ttl: "1h" } },
  ]

  async function send(lifecycle: LifecyclePort, system: SystemBlock[] | undefined) {
    const calls: SendOptions[] = []
    const wrapped = wrapTransportWithLifecycle(stubTransport(calls), lifecycle)
    const g = wrapped({
      auth: { type: "api_key", apiKey: "k" } as never,
      messages: [{ role: "user", content: "hi" }],
      model: "m",
      ...(system ? { system } : {}),
    })
    while (!(await g.next()).done) {
      /* drain */
    }
    return calls[0]
  }

  test("no-op lifecycle (no plugin) keeps every system block byte-identical", async () => {
    const sent = await send(NOOP_LIFECYCLE, SYSTEM)
    expect(sent?.system).toEqual(SYSTEM)
  })

  test("single cached system block keeps its cache_control", async () => {
    const one: SystemBlock[] = [
      { type: "text", text: "only", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]
    const sent = await send(NOOP_LIFECYCLE, one)
    expect(sent?.system).toEqual(one)
  })

  test("hook that rewrites one block keeps cache_control on every block", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        const sys = p.system as ContentBlock[]
        return allowDecision({
          ...p,
          system: sys.map((b) =>
            b.type === "text" && b.text === "session ctx"
              ? Object.assign({}, b, { text: "[REDACTED] ctx" })
              : b,
          ),
        })
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system?.[1]).toEqual(SYSTEM[1])
    expect(sent?.system?.[2]).toEqual({
      type: "text",
      text: "[REDACTED] ctx",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
  })

  test("hook that strips cache_control from a rebuilt block still keeps the original marker", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        const sys = p.system as ContentBlock[]
        // Plugin rebuilds blocks as bare text (common pattern): markers must not be lost.
        return allowDecision({
          ...p,
          system: sys.map((b) => ({
            type: "text" as const,
            text: b.type === "text" ? b.text : "",
          })),
        })
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system).toEqual(SYSTEM)
  })

  test("hook that returns a plain string replaces the system (no stale markers)", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        return allowDecision({ ...p, system: "flat" })
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system).toEqual([{ type: "text", text: "flat" }])
  })

  test("listener that clones the payload unchanged keeps the same system array", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        return allowDecision(structuredClone(p))
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system).toBe(SYSTEM)
  })

  test("edit of block 2 of 3 reuses blocks 1 and 3 by identity", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        const sys = [...(p.system as ContentBlock[])]
        sys[1] = { type: "text", text: "[REDACTED]" }
        return allowDecision({ ...p, system: sys })
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system?.[0]).toBe(SYSTEM[0])
    expect(sent?.system?.[2]).toBe(SYSTEM[2])
    expect(sent?.system?.[1]).toEqual({
      type: "text",
      text: "[REDACTED]",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    })
  })

  test("listener that mutates a block in place (returns same ref) still redacts", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        const b = (p.system as ContentBlock[])[2]
        if (b && b.type === "text") b.text = "[REDACTED] ctx"
        return allowDecision(p)
      },
    }
    const sent = await send(lifecycle, SYSTEM)
    expect(sent?.system?.[2]).toEqual({
      type: "text",
      text: "[REDACTED] ctx",
      cache_control: { type: "ephemeral", ttl: "1h" },
    })
    expect(sent?.system?.[1]).toBe(SYSTEM[1])
    expect(SYSTEM[2]?.text).toBe("session ctx")
  })

  test("single-block system redacted as a string keeps its marker", async () => {
    const one: SystemBlock[] = [
      { type: "text", text: "sk-SECRET", cache_control: { type: "ephemeral", ttl: "5m" } },
    ]
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeSend(p) {
        return allowDecision({ ...p, system: "[REDACTED]" })
      },
    }
    const sent = await send(lifecycle, one)
    expect(sent?.system).toEqual([
      { type: "text", text: "[REDACTED]", cache_control: { type: "ephemeral", ttl: "5m" } },
    ])
  })

  test("no-op lifecycle keeps the same system array (identity)", async () => {
    const sent = await send(NOOP_LIFECYCLE, SYSTEM)
    expect(sent?.system).toBe(SYSTEM)
  })

  test("no system stays undefined", async () => {
    const sent = await send(NOOP_LIFECYCLE, undefined)
    expect(sent?.system).toBeUndefined()
  })
})

import { describe, expect, test } from "bun:test"

import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { allowDecision, denyDecision, type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { LifecycleSendDeniedError, wrapTransportWithLifecycle } from "./with-lifecycle-send.ts"

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

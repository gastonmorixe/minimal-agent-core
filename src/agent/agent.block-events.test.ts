import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import type { AgentEvent } from "../sdk/events.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

/**
 * `AgentCore.run` turns the transport's block edges into `block_started`
 * and `block_stopped` events (S36, S37). A host renders text and thinking
 * blocks from these events and the deltas. It gets no callback.
 *
 * The wire-level edges (`content_block_start` / `content_block_stop`) are
 * tested in `adapter-legacy-stream.block-edge.test.ts`.
 */
describe("AgentCore.run block events", () => {
  const auth: AuthResult = { type: "api-key", token: "test-token" }

  const collect = (): { events: AgentEvent[]; sink: { emit(e: AgentEvent): void } } => {
    const events: AgentEvent[] = []
    return { events, sink: { emit: (e) => events.push(e) } }
  }

  const drain = async (gen: AsyncGenerator<string, unknown, undefined>): Promise<string[]> => {
    const out: string[] = []
    while (true) {
      const { done, value } = await gen.next()
      if (done) return out
      out.push(value)
    }
  }

  const streamKinds = (events: AgentEvent[]): string[] =>
    events.flatMap((e) => {
      if (e.type === "block_started" || e.type === "block_stopped") {
        return [`${e.type}:${e.itemType}:${e.id}`]
      }
      if (e.type === "text_delta" || e.type === "thinking_delta") return [`${e.type}:${e.text}`]
      return []
    })

  it("emits one block_stopped per text block, after its deltas, in every round", async () => {
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        await opts.onBlockEdge?.({ block: "text", edge: "start" })
        yield "sentence one. "
        await opts.onBlockEdge?.({ block: "text", edge: "stop" })
        return {
          blocks: [
            { type: "text", text: "sentence one. " },
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "true" } },
          ],
          text: "sentence one. ",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      await opts.onBlockEdge?.({ block: "text", edge: "start" })
      yield "sentence two."
      await opts.onBlockEdge?.({ block: "text", edge: "stop" })
      return {
        blocks: [{ type: "text", text: "sentence two." }],
        text: "sentence two.",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const { events, sink } = collect()
    const agent = await buildTestCore({ auth, sendFn, eventSink: sink })
    const yielded = await drain(agent.run("go", { emitDeltas: true }))

    expect(yielded).toEqual(["sentence one. ", "sentence two."])
    expect(streamKinds(events)).toEqual([
      "block_started:text:1:text",
      "text_delta:sentence one. ",
      "block_stopped:text:1:text",
      "block_started:text:2:text",
      "text_delta:sentence two.",
      "block_stopped:text:2:text",
    ])
  })

  it("emits thinking block edges around the thinking deltas", async () => {
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      await opts.onBlockEdge?.({ block: "thinking", edge: "start" })
      await opts.onThinkingDelta?.("let me ")
      await opts.onThinkingDelta?.("think.")
      await opts.onBlockEdge?.({ block: "thinking", edge: "stop" })
      yield "answer"
      await opts.onBlockEdge?.({ block: "text", edge: "stop" })
      return {
        blocks: [{ type: "text", text: "answer" }],
        text: "answer",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const { events, sink } = collect()
    const agent = await buildTestCore({ auth, sendFn, eventSink: sink })
    await drain(agent.run("hi", { emitDeltas: true }))

    expect(streamKinds(events)).toEqual([
      "block_started:thinking:1:thinking",
      "thinking_delta:let me ",
      "thinking_delta:think.",
      "block_stopped:thinking:1:thinking",
      "text_delta:answer",
      "block_stopped:text:1:text",
    ])
  })

  it("emits no block events and passes no edge hook when deltas are off", async () => {
    let hook: SendOptions["onBlockEdge"]
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      hook = opts.onBlockEdge
      yield "x"
      return {
        blocks: [{ type: "text", text: "x" }],
        text: "x",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const { events, sink } = collect()
    const agent = await buildTestCore({ auth, sendFn, eventSink: sink })
    await drain(agent.run("hi"))

    expect(hook).toBeUndefined()
    expect(streamKinds(events)).toEqual([])
  })

  it("keeps a host edge hook out of the send options", async () => {
    // The run options take `Partial<SendOptions>`. The edge hook is the
    // core's own seam: a host value never reaches the transport.
    let hook: SendOptions["onBlockEdge"]
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      hook = opts.onBlockEdge
      yield "x"
      return {
        blocks: [{ type: "text", text: "x" }],
        text: "x",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const hostHook = (): void => {}
    const agent = await buildTestCore({ auth, sendFn })
    await drain(agent.run("hi", { onBlockEdge: hostHook }))

    expect(hook).toBeUndefined()
  })
})

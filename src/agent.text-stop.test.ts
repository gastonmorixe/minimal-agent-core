import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { SendOptions, StreamedResponse } from "./client.ts"

/**
 * `Agent.run`'s plumbing of the `onTextStop` hook. The wire-level
 * (`content_block_stop` for `text`) test lives in
 * `client.text-stop.test.ts`. This file covers `Agent.run`'s contract:
 *
 *   1. The hook is forwarded into `sendFn` opts so the SSE layer can
 *      fire it from `content_block_stop`.
 *   2. The hook fires for EACH text block across ALL sub-turns
 *      (one `Agent.run` invocation can produce multiple text blocks,
 *      one per round between tool calls — that's the entire reason
 *      the hook exists, see the field's doc-comment).
 *   3. Async handlers are awaited (host can call `await formatter.end()`).
 *
 * The smashing-into-one-paragraph manifestation is exercised by the
 * formatter respawn in `runReplLiveArea`/`runRepl`; this file pins the
 * agent-level contract one layer below.
 */
describe("Agent.run onTextStop wiring", () => {
  const auth: AuthResult = { type: "api-key", token: "test-token" }

  it("forwards onTextStop to sendFn so a single-text run fires it", async () => {
    let captured: (() => unknown) | undefined
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      captured = opts.onTextStop
      // Simulate the SSE layer's fire site for a text block stop.
      if (opts.onTextStop) await opts.onTextStop()
      yield "hello"
      return {
        blocks: [{ type: "text", text: "hello" }],
        text: "hello",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    let fired = 0
    const agent = new Agent({ auth, model: "test-model", sendFn })
    const gen = agent.run("hi", {
      onTextStop: () => {
        fired++
      },
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The hook was forwarded into sendFn opts.
    expect(typeof captured).toBe("function")
    // …and invocation in the fake SSE layer triggered the agent's handler.
    expect(fired).toBe(1)
  })

  it("fires onTextStop once per sub-turn (multi-round text→tool→text)", async () => {
    // Replicates the smashing scenario: round 1 emits text + tool_use,
    // round 2 emits text. The host's onTextStop MUST fire at the end of
    // BOTH text blocks — otherwise the formatter wouldn't get a chance to
    // respawn between them, and mdstream would concatenate the two
    // sentences into one paragraph at end-of-run.
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        // First sub-turn: text block then tool_use block.
        yield "sentence one. "
        if (opts.onTextStop) await opts.onTextStop()
        return {
          blocks: [
            { type: "text", text: "sentence one. " },
            { type: "tool_use", id: "call-1", name: "Bash", input: { command: "true" } },
          ],
          text: "sentence one. ",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      // Second sub-turn: just a text block (final answer).
      yield "sentence two."
      if (opts.onTextStop) await opts.onTextStop()
      return {
        blocks: [{ type: "text", text: "sentence two." }],
        text: "sentence two.",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const calls: number[] = []
    const agent = new Agent({ auth, model: "test-model", sendFn })
    const gen = agent.run("go", {
      onTextStop: () => {
        calls.push(round)
      },
    })
    const yielded: string[] = []
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      yielded.push(value)
    }

    // One fire per sub-turn — round-1 text-stop + round-2 text-stop.
    expect(calls).toEqual([1, 2])
    // Sanity: both texts were streamed.
    expect(yielded).toEqual(["sentence one. ", "sentence two."])
  })

  it("awaits an async onTextStop handler (host can drain a formatter)", async () => {
    // The handler simulates `await formatter.end()` — mdstream's `finish()`
    // outputs the partial paragraph render through `drainOutput`, and
    // until that drain completes the host's compositor hasn't yet seen
    // the full markdown. `Agent.run` must propagate the await chain so
    // the next tool block (drawn directly to compositor, not via the
    // formatter) lands AFTER the drain — not racing past it.
    const trace: string[] = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "x"
      trace.push("before-stop")
      if (opts.onTextStop) await opts.onTextStop()
      trace.push("after-stop")
      return {
        blocks: [{ type: "text", text: "x" }],
        text: "x",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const agent = new Agent({ auth, model: "test-model", sendFn })
    const gen = agent.run("hi", {
      onTextStop: async () => {
        trace.push("handler-begin")
        await new Promise<void>((r) => setTimeout(r, 5))
        trace.push("handler-end")
      },
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The handler's begin→end pair must sit STRICTLY between
    // before-stop and after-stop in the trace.
    expect(trace).toEqual(["before-stop", "handler-begin", "handler-end", "after-stop"])
  })
})

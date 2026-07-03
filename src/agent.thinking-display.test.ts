import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { SendOptions, StreamedResponse } from "./client/types.ts"

/**
 * `--thinking-display` (and `MINIMAL_AGENT_THINKING_DISPLAY`) is plumbed
 * from the CLI down to the Agent constructor as `thinkingDisplay`, and
 * the agent must thread it onto every `sendMessage` call as
 * `thinking: { type: "adaptive", display: <value> }`.
 *
 * Default behavior (no opt-in) must NOT add a `thinking` field — the
 * client.ts default `{type:"adaptive"}` continues to apply, and the
 * server picks the per-model default (omitted on opus-4.7, summarized
 * on sonnet-4.6).
 */
describe("Agent: thinkingDisplay flag", () => {
  function makeRecordingSendFn(records: Array<Record<string, unknown>>) {
    return async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      records.push(
        JSON.parse(
          JSON.stringify({
            thinking: opts.thinking ?? null,
            model: opts.model,
          }),
        ),
      )
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  const auth: AuthResult = { type: "api-key", token: "test" }

  it("does NOT pass `thinking` when thinkingDisplay is unset (server default)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const agent = new Agent({ auth, model: "test-model-1", sendFn })

    for await (const _ of agent.run("hi", { onTranscriptLine: () => {} })) {
      // drain
    }

    expect(records.length).toBeGreaterThan(0)
    expect(records[0].thinking).toBeNull() // not present in opts
  })

  it("passes `thinking: {type:'adaptive', display:'summarized'}` when opted in", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const agent = new Agent({
      auth,
      model: "test-model-1",
      sendFn,
      thinkingDisplay: "summarized",
    })

    for await (const _ of agent.run("hi", { onTranscriptLine: () => {} })) {
      // drain
    }

    expect(records[0].thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    })
  })

  it("passes `display:'omitted'` when explicitly forced (e.g. on a summarizing model)", async () => {
    const records: Array<Record<string, unknown>> = []
    const sendFn = makeRecordingSendFn(records)
    const agent = new Agent({
      auth,
      model: "test-model-2",
      sendFn,
      thinkingDisplay: "omitted",
    })

    for await (const _ of agent.run("hi", { onTranscriptLine: () => {} })) {
      // drain
    }

    expect(records[0].thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    })
  })
})

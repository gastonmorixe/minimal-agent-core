/**
 * Phase 4 thread test: the `--output-schema` JSON Schema must reach the model
 * request as `outputConfig.format = { type: "json_schema", schema }` on EVERY
 * sendFn call, via the Agent's `outputSchema` constructor option +
 * `outputConfigSpread()` helper. A captured-options mock transport proves the
 * schema is not silently dropped (the "accepted and ignored" failure mode).
 */
import { describe, expect, test } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { SendOptions, StreamedResponse } from "./llm/transport/types.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

/** A sendFn that records the SendOptions it was called with. */
function capturingTransport(): {
  calls: SendOptions[]
  sendFn: (opts: SendOptions) => AsyncGenerator<string, StreamedResponse, undefined>
} {
  const calls: SendOptions[] = []
  const sendFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    calls.push(opts)
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return { calls, sendFn }
}

describe("Agent --output-schema threading", () => {
  test("outputSchema reaches the request as outputConfig.format json_schema", async () => {
    const { calls, sendFn } = capturingTransport()
    const schema = { type: "object", properties: { ok: { type: "boolean" } } }
    const agent = new Agent({ auth, model: "test-model", sendFn, outputSchema: schema })

    const gen = agent.run("go")
    while (!(await gen.next()).done) {
      /* drain */
    }

    expect(calls.length).toBeGreaterThan(0)
    const cfg = calls[0].outputConfig
    expect(cfg?.format?.type).toBe("json_schema")
    expect(cfg?.format?.schema).toBe(schema)
  })

  test("no outputSchema → no format on the request (back-compat)", async () => {
    const { calls, sendFn } = capturingTransport()
    const agent = new Agent({ auth, model: "test-model", sendFn })

    const gen = agent.run("go")
    while (!(await gen.next()).done) {
      /* drain */
    }

    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].outputConfig?.format).toBeUndefined()
  })

  test("outputSchema coexists with effort on outputConfig", async () => {
    const { calls, sendFn } = capturingTransport()
    const schema = { type: "object" }
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn,
      effort: "high",
      outputSchema: schema,
    })

    const gen = agent.run("go")
    while (!(await gen.next()).done) {
      /* drain */
    }

    const cfg = calls[0].outputConfig
    expect(cfg?.effort).toBe("high")
    expect(cfg?.format?.schema).toBe(schema)
  })
})

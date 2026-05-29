/**
 * Phase 3 proof: the agent's DEFAULT transport dispatches a non-Anthropic
 * model to the right vendor.
 *
 * Before this work `--model gpt-5.5` was listed + registered but, at
 * runtime through the agent loop, the legacy Anthropic-only `sendMessage`
 * would have sent it to api.anthropic.com. Now the default `selectedTransport`
 * routes it through the canonical `run()` to OpenAI's Responses endpoint.
 *
 * This drives a real `Agent.run` turn with NO injected `sendFn` (so the
 * production default transport is exercised) and a fake `NetworkClient`, and
 * asserts the request landed on `https://api.openai.com/v1/responses` with
 * the OpenAI bearer — never Anthropic.
 *
 * @module agent.canonical-dispatch.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { beforeAll, describe, expect, it } from "bun:test"

import { bootstrapOpenAI } from "../plugins/llm-openai/adapter.ts"
import { RESPONSES_URL } from "../plugins/llm-openai/wire-constants.ts"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"

function fakeNetworkClient(
  handler: (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>,
): NetworkClient {
  const transport: NetworkTransport = { id: "fake", request: async (req) => handler(req) }
  return new NetworkClient({ primary: transport })
}

function sseFromString(raw: string): NetworkResponse {
  const enc = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_dispatch" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(raw))
        c.close()
      },
    }),
  })
}

function openaiFixture(name: string): string {
  return readFileSync(join(import.meta.dir, "../plugins/llm-openai/__fixtures__", name), "utf-8")
}

beforeAll(() => {
  bootstrapOpenAI()
})

describe("Agent default transport — multi-provider dispatch", () => {
  it("routes --model gpt-5.5 to the OpenAI Responses endpoint (never Anthropic)", async () => {
    let seenUrl = ""
    let seenAuth = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      seenAuth = req.headers?.authorization ?? ""
      return sseFromString(openaiFixture("responses-pong.sse"))
    })

    const auth: AuthResult = { type: "api-key", token: "sk-openai-test" }
    // NO sendFn injected → the production default (selectedTransport) runs.
    const agent = new Agent({ auth, model: "gpt-5.5", networkClient })

    const out: string[] = []
    const gen = agent.run("ping")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      if (typeof value === "string") out.push(value)
    }

    // The migration payoff: a gpt-5.5 turn through the agent hit OpenAI's
    // Responses API, not api.anthropic.com.
    expect(seenUrl).toBe(RESPONSES_URL)
    expect(seenUrl).toContain("api.openai.com")
    expect(seenUrl).not.toContain("anthropic")
    expect(seenAuth).toBe("Bearer sk-openai-test")
    // And the turn completed with the model's text.
    expect(out.join("")).toContain("pong")
  }, 20_000)

  it("still routes Anthropic models to the legacy client (api.anthropic.com)", async () => {
    let seenUrl = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      return sseFromString(
        [
          `data: ${JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-opus-4-8", usage: { input_tokens: 1 } } })}`,
          `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
          `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}`,
          `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
          `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } })}`,
          `data: ${JSON.stringify({ type: "message_stop" })}`,
          "",
        ].join("\n"),
      )
    })
    const auth: AuthResult = { type: "oauth", token: "oauth-test" }
    const agent = new Agent({ auth, model: "claude-opus-4-8", networkClient })
    const gen = agent.run("ping")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    // Anthropic stayed on the legacy transport → api.anthropic.com.
    expect(seenUrl).toContain("api.anthropic.com")
    expect(seenUrl).not.toContain("openai")
  }, 20_000)
})

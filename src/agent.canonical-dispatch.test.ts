/**
 * Phase 3 proof: the agent's DEFAULT transport dispatches each model to the
 * provider that OWNS it, with that provider's own credential.
 *
 * Before this work `--model gpt-5.5` was listed + registered but, at
 * runtime through the agent loop, the legacy Anthropic-only `sendMessage`
 * would have sent it to api.anthropic.com. Now the default
 * `selectedTransport` routes any REGISTERED model through the canonical
 * `run()` to its owning adapter, and falls back to the legacy client only
 * for unregistered ids.
 *
 * Core-side seam test (Wave A unit A-4): drives a real `Agent.run` turn
 * with NO injected `sendFn` (so the production default transport is
 * exercised) against a SYNTHETIC in-test provider registered straight
 * into the canonical registries — no real provider import (invariant I2).
 * The fake provider REUSES the real provider id "openai" AS DATA because
 * `resolveProviderAuth` (core, pending C-5) selects the credential
 * strategy by provider id; the real OpenAI Responses endpoint + wire
 * shape is owned by `plugins/llm-openai/` (wire-constants.ts + its adapter
 * suite), not pinned here.
 *
 * @module agent.canonical-dispatch.test
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { CanonicalEvent } from "./llm/canonical-events.ts"
import { clearModelRegistry, clearProviderRegistry } from "./llm/model-registry.ts"
import { type ApiKeyAuthProvider, clearProviderPlugins } from "./llm/provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents, testProviderUrl } from "./llm/test-fixtures.ts"
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

/** SSE response whose `data:` lines are canonical events (the fixture wire). */
function sseFromEvents(events: CanonicalEvent[]): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_dispatch" },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(events),
  })
}

/** A complete single-text-block stream: `pong` then a clean `end_turn`. */
function pongEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_dispatch",
      modelId: "test-model-1",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "pong" },
    { type: "text_stop", index: 0 },
    {
      type: "message_delta",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { type: "message_stop" },
  ]
}

const openAITestApiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "openai-api-key",
  displayName: "OpenAI API Key",
  envVars: ["OPENAI_API_KEY"],
  configKey: "openai",
  buildCredential(apiKey) {
    return {
      serviceId: this.serviceId,
      displayName: this.displayName,
      secrets: { api_key: apiKey },
    }
  },
  readApiKey(secrets) {
    const value = secrets.api_key
    return typeof value === "string" ? value : null
  },
}

// Synthetic registration replaces the real adapter bootstrap. The fake
// provider REUSES the real provider id "openai" as test data; gpt-5.5 is
// its owned model and its auth strategy is declared through the same plugin
// hook production providers use. The Anthropic model id is left UNREGISTERED
// so the dispatch falls back to the legacy client (the second case below).
beforeAll(() => {
  registerTestProvider({
    id: "openai",
    models: [{ id: "gpt-5.5" }],
    apiKeyAuth: openAITestApiKeyAuth,
  })
})

afterAll(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("Agent default transport — multi-provider dispatch", () => {
  it("routes a registered non-Anthropic model to its owner with OPENAI_API_KEY, never the Anthropic token", async () => {
    // The agent holds the ANTHROPIC session credential (as in production).
    // It must NOT be sent to the OpenAI-owned model; OPENAI_API_KEY is used.
    const ANTHROPIC_SECRET = "anthropic-oauth-secret-DO-NOT-LEAK"
    const prevKey = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "sk-openai-real-key"
    try {
      let seenUrl = ""
      let seenAuth = ""
      const networkClient = fakeNetworkClient((req) => {
        seenUrl = req.url
        seenAuth = req.headers?.authorization ?? ""
        return sseFromEvents(pongEvents())
      })

      const auth: AuthResult = { type: "oauth", token: ANTHROPIC_SECRET }
      // NO sendFn injected → the production default (selectedTransport) runs.
      const agent = new Agent({ auth, model: "gpt-5.5", networkClient })

      const out: string[] = []
      const gen = agent.run("ping")
      while (true) {
        const { done, value } = await gen.next()
        if (done) break
        if (typeof value === "string") out.push(value)
      }

      // The migration payoff: a gpt-5.5 turn through the agent hit the
      // owning provider's endpoint, authenticated with the OpenAI key (not
      // the host's Anthropic session).
      expect(seenUrl).toBe(testProviderUrl("openai"))
      expect(seenUrl).not.toContain("anthropic")
      expect(seenAuth).toBe("Bearer sk-openai-real-key")
      expect(seenAuth).not.toContain(ANTHROPIC_SECRET)
      expect(out.join("")).toContain("pong")
    } finally {
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
    }
  }, 20_000)

  it("falls back to the legacy client for an unregistered model id (api.anthropic.com)", async () => {
    let seenUrl = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      return sseFromEvents([
        {
          type: "message_start",
          messageId: "m",
          modelId: "test-model-1",
          initialUsage: { inputTokens: 1, outputTokens: 0 },
        },
        { type: "text_start", index: 0 },
        { type: "text_delta", index: 0, text: "hi" },
        { type: "text_stop", index: 0 },
        {
          type: "message_delta",
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
        { type: "message_stop" },
      ])
    })
    const auth: AuthResult = { type: "oauth", token: "oauth-test" }
    // "claude-opus-4-8" is NOT registered → pickTransport falls back to the
    // legacy sendMessage, which targets api.anthropic.com (core's legacy
    // client, dissolving in Wave B-5). The id is provider DATA, kept until
    // the legacy stack leaves core.
    const agent = new Agent({ auth, model: "claude-opus-4-8", networkClient })
    const gen = agent.run("ping")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    expect(seenUrl).toContain("api.anthropic.com")
    expect(seenUrl).not.toContain("openai")
  }, 20_000)
})

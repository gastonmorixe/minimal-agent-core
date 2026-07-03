/**
 * Proof: the agent's DEFAULT transport dispatches each model to the provider
 * that OWNS it, with that provider's OWN credential — never the host's session
 * token meant for a different provider.
 *
 * The default `selectedTransport` routes any REGISTERED model through the
 * canonical `run()` to its owning adapter; an unregistered id raises an
 * unknown-model error rather than falling back to a hard-wired vendor.
 *
 * Core-side seam test: drives a real `Agent.run` turn with NO injected `sendFn`
 * (so the production default transport is exercised) against a SYNTHETIC in-test
 * provider registered straight into the canonical registries — no real provider
 * import (invariant I2). The fake provider uses a neutral id ("acme") because
 * credential resolution selects the strategy by provider id; a real provider's
 * endpoint + wire shape is owned by its own plugin, not pinned here.
 *
 * @module agent.canonical-dispatch.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "../auth/auth-store.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { type ApiKeyAuthProvider, clearProviderPlugins } from "../llm/provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents, testProviderUrl } from "../llm/test-fixtures.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../network/index.ts"

import { Agent } from "./agent.ts"

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

const acmeTestApiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "acme-api-key",
  displayName: "Acme API Key",
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
    id: "acme",
    models: [{ id: "acme-model-1" }],
    apiKeyAuth: acmeTestApiKeyAuth,
  })
})

afterAll(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

function writeStoredAcmeKey(apiKey: string): void {
  const write = acmeTestApiKeyAuth.buildCredential(apiKey)
  defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
}

describe("Agent default transport — multi-provider dispatch", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "minimal-agent-agent-auth-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
    resetDefaultAuthStoreForTests()
  })

  it("routes a registered model to its owner with stored provider auth, never the host session token", async () => {
    const HOST_SESSION_SECRET = "host-session-secret-DO-NOT-LEAK"
    writeStoredAcmeKey("sk-acme-real-key")
    let seenUrl = ""
    let seenAuth = ""
    const networkClient = fakeNetworkClient((req) => {
      seenUrl = req.url
      seenAuth = req.headers?.authorization ?? ""
      return sseFromEvents(pongEvents())
    })

    const auth: AuthResult = { type: "oauth", token: HOST_SESSION_SECRET }
    const agent = new Agent({ auth, model: "acme-model-1", networkClient })

    const out: string[] = []
    const gen = agent.run("ping")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      if (typeof value === "string") out.push(value)
    }

    expect(seenUrl).toBe(testProviderUrl("acme"))
    expect(seenAuth).toBe("Bearer sk-acme-real-key")
    expect(seenAuth).not.toContain(HOST_SESSION_SECRET)
    expect(out.join("")).toContain("pong")
  }, 20_000)

  it("raises an unknown-model error for an unregistered model id (no legacy fallback)", async () => {
    let requested = false
    const networkClient = fakeNetworkClient(() => {
      requested = true
      return sseFromEvents(pongEvents())
    })
    const auth: AuthResult = { type: "oauth", token: "oauth-test" }
    // An unregistered model id no longer falls back to a hard-wired vendor
    // endpoint. Every request routes through the canonical run(), which fails
    // to resolve the model and raises before any network call.
    const agent = new Agent({ auth, model: "totally-unregistered-model", networkClient })
    let threw = false
    try {
      const gen = agent.run("ping")
      while (true) {
        const { done } = await gen.next()
        if (done) break
      }
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    expect(requested).toBe(false)
  }, 20_000)
})

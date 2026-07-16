/**
 * Full-stack offline test: pre-stream hang → responseHeadersTimeoutMs →
 * polite pre-stream retry → recover (MA-882492 / legacy 65ab8ca spirit).
 *
 * Proves the watchdog AbortSignal reaches networkClient.request and that
 * dead responseHeadersTimeoutMs wiring cannot regress unnoticed.
 *
 * @module llm/transport/pre-stream-recovery.integration.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import {
  defaultAuthStore,
  resetDefaultAuthStoreForTests,
  type SecretBag,
} from "../../auth/auth-store.ts"
import { getDiagnosticBus, type LogEvent, resetDiagnosticBus } from "../../bus/diagnostic-bus.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../../network/index.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import type { ApiKeyAuthProvider } from "../provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents } from "../test-fixtures.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import type { StreamedResponse } from "./types.ts"

function successEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "resp_prestream_ok",
      modelId: "test-model-prestream",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "recovered" },
    { type: "text_stop", index: 0 },
    {
      type: "message_delta",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    },
    { type: "message_stop" },
  ]
}

function sseFromEvents(events: CanonicalEvent[]): NetworkResponse {
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream", "request-id": "req_prestream" },
    transport: { id: "fake", protocol: "h2" },
    body: sseBodyFromEvents(events),
  })
}

async function drainSend(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<StreamedResponse> {
  let r: IteratorResult<string, StreamedResponse>
  // biome-ignore lint/suspicious/noAssignInExpressions: drain pattern
  while (!(r = await gen.next()).done) {
    /* discard text */
  }
  return r.value
}

const apiKeyAuth: ApiKeyAuthProvider = {
  serviceId: "test-prestream-api-key",
  displayName: "Test Prestream API Key",
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

const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
let moduleAuthDir: string

beforeAll(() => {
  moduleAuthDir = mkdtempSync(join(tmpdir(), "minimal-agent-prestream-auth-"))
  process.env.MINIMAL_AGENT_AUTH_FILE = join(moduleAuthDir, "auth.jsonc")
  resetDefaultAuthStoreForTests()
  registerTestProvider({
    id: "test-prestream",
    models: [{ id: "test-model-prestream" }],
    apiKeyAuth,
  })
  const write = apiKeyAuth.buildCredential("sk-test-prestream")
  defaultAuthStore().set(write.serviceId, write.displayName, write.secrets as SecretBag)
})

afterAll(() => {
  if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
  else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  resetDefaultAuthStoreForTests()
  if (moduleAuthDir) rmSync(moduleAuthDir, { recursive: true, force: true })
})

const auth: AuthResult = { type: "api-key", token: "sk-test-prestream" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

describe("pre-stream recovery — full stack (MA-882492)", () => {
  let origRandom: () => number

  beforeEach(() => {
    origRandom = Math.random
    Math.random = () => 0
    resetDiagnosticBus()
  })

  afterEach(() => {
    Math.random = origRandom
    resetDiagnosticBus()
  })

  it("hangs request until abort, retries with pre-stream curve, then recovers", async () => {
    const events: LogEvent[] = []
    const dispose = getDiagnosticBus().on("*", (e) => {
      events.push(e)
    })

    let calls = 0
    const handler = mock(async (req: NetworkRequest) => {
      calls++
      if (calls === 1) {
        // Hang until the watchdog aborts (signal must reach the transport).
        await new Promise<void>((_resolve, reject) => {
          const signal = req.signal
          if (!signal) {
            reject(new Error("expected AbortSignal on NetworkRequest"))
            return
          }
          if (signal.aborted) {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
            return
          }
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          )
        })
      }
      return sseFromEvents(successEvents())
    })

    const transport: NetworkTransport = {
      id: "fake",
      request: async (req) => handler(req),
    }
    const networkClient = new NetworkClient({ primary: transport })

    try {
      const response = await drainSend(
        canonicalSendFn({
          model: "test-model-prestream",
          messages,
          auth,
          networkClient,
          // 50ms pre-stream; 1s tick → trip ~1s. Mid-stream idle high so only
          // pre-stream can fire on attempt 1.
          responseHeadersTimeoutMs: 50,
          streamIdleTimeoutMs: 30_000,
          attemptHardTimeoutMs: 30_000,
        }),
      )
      expect(response.text).toContain("recovered")
    } finally {
      dispose()
    }

    expect(calls).toBe(2)
    const retry = events.find((e) => e.source === "api.retry")
    expect(retry?.structuredData?.["error-type"]).toBe("stream_idle")
    expect(retry?.structuredData?.phase).toBe("pre-stream")
    expect(retry?.structuredData?.curve).toBe("pre-stream")
    expect(Number(retry?.structuredData?.["delay-ms"])).toBeGreaterThanOrEqual(2000)
    expect(events.some((e) => e.source === "api.retry-success")).toBe(true)
  }, 20_000)
})

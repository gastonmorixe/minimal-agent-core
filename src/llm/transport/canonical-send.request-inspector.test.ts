/**
 * The `llm.requestWillSend` publish site in `canonicalAttemptFn`: one event
 * per attempt with a subscriber, NO publish (and no build) with none, the
 * session routing data on the event, no credential in the event, and no
 * dependence on `DEBUG` / `VERBOSE`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "../../network/index.ts"
import { clearSessionTokens } from "../../session/session-tokens.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import { registerTestProvider, sseBodyFromEvents } from "../test-fixtures.ts"

import { canonicalAttemptFn } from "./canonical-send.ts"
import {
  createRequestInspector,
  processRequestInspector,
  type RequestInspector,
  type RequestWillSendEvent,
} from "./request-inspector.ts"
import type { SendOptions } from "./types.ts"

const SECRET = "SECRET-TOKEN-INSPECT-42"

function pongEvents(): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_pong",
      modelId: "inspect-model",
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "pong" },
    { type: "text_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "message_stop" },
  ]
}

function fakeNetworkClient(): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async () =>
      new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: sseBodyFromEvents(pongEvents()),
      }),
  }
  return new NetworkClient({ primary: transport })
}

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
// Provider-native auth: the transport uses it as is (no auth store read).
const auth: AuthResult = { type: "provider", auth: { kind: "oauth", token: SECRET } }

function sendOpts(extra: Partial<SendOptions> = {}): SendOptions {
  return {
    auth,
    messages,
    model: "inspect-model",
    stream: true,
    maxTokens: 64,
    networkClient: fakeNetworkClient(),
    credentialName: "cred-inspect",
    ...extra,
  }
}

async function drain(opts: SendOptions): Promise<void> {
  const gen = canonicalAttemptFn(opts)
  while (!(await gen.next()).done) {
    // drain
  }
}

/** A channel whose `publish` throws: a publish call would fail the send. */
function publishSpy(): RequestInspector {
  return {
    hasSubscribers: () => false,
    subscribe: () => () => {},
    publish: () => {
      throw new Error("must not publish")
    },
  }
}

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const prev: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

beforeAll(() => {
  registerTestProvider({ id: "inspect-prov", models: [{ id: "inspect-model" }] })
})

afterAll(() => {
  clearSessionTokens()
})

describe("canonicalAttemptFn — llm.requestWillSend", () => {
  it("publishes one event per attempt, with the session routing data and no credential", async () => {
    const inspector = createRequestInspector()
    const seen: RequestWillSendEvent[] = []
    inspector.subscribe((e) => seen.push(e))
    const logged: LogEvent[] = []
    const diagnostics = createDiagnostics(
      { emit: (e) => logged.push(e) },
      { sessionId: "sess-inspect", now: () => 1234 },
    )
    const opts = sendOpts({ requestInspector: inspector, diagnostics })
    await drain(opts)

    expect(seen).toHaveLength(1)
    const ev = seen[0]
    expect(ev.request.model).toBe("inspect-model")
    // Resolved from the model registry (no selectedProviderId on the request).
    expect(ev.request.providerId).toBe("inspect-prov")
    expect(ev.request.maxTokens).toBe(64)
    expect(ev.request.messages).toBe(opts.messages)
    expect(ev.sessionId).toBe("sess-inspect")
    expect(ev.ts).toBe(1234)
    // The request's own handle, so a subscriber can re-emit on the session scope.
    expect(ev.diagnostics).toBe(diagnostics)
    const text = JSON.stringify(ev.request)
    expect(text).not.toContain(SECRET)
    expect(text).not.toContain("cred-inspect")
    expect("auth" in ev.request).toBe(false)

    await drain(
      sendOpts({ requestInspector: inspector, diagnostics, selectedProviderId: "inspect-prov" }),
    )
    expect(seen).toHaveLength(2)
    expect(seen[1].request.providerId).toBe("inspect-prov")
  })

  it("does not publish with no subscriber (zero cost at the send site)", async () => {
    await drain(sendOpts({ requestInspector: publishSpy() }))
  })

  it("control: the publish spy does fail the send when it reports a subscriber", async () => {
    const spy: RequestInspector = { ...publishSpy(), hasSubscribers: () => true }
    await expect(drain(sendOpts({ requestInspector: spy }))).rejects.toThrow("must not publish")
  })

  it("a throwing subscriber does not break the send, and is reported on the request's diagnostics", async () => {
    const inspector = createRequestInspector()
    inspector.subscribe(() => {
      throw new Error("view crashed")
    })
    const logged: LogEvent[] = []
    const diagnostics = createDiagnostics(
      { emit: (e) => logged.push(e) },
      { sessionId: "sess-throw" },
    )
    await drain(sendOpts({ requestInspector: inspector, diagnostics }))
    const reports = logged.filter((e) => e.source === "transport.request-inspector")
    expect(reports).toHaveLength(1)
    expect(reports[0].message).toContain("view crashed")
    expect(reports[0].sessionId).toBe("sess-throw")
  })

  it("uses the process channel when the request sets none", async () => {
    const seen: RequestWillSendEvent[] = []
    const off = processRequestInspector().subscribe((e) => seen.push(e))
    try {
      await drain(sendOpts())
    } finally {
      off()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0].sessionId).toBeUndefined()
    expect(processRequestInspector().hasSubscribers()).toBe(false)
  })

  it("does not read DEBUG or VERBOSE", async () => {
    await withEnv({ DEBUG: undefined, VERBOSE: undefined }, async () => {
      const inspector = createRequestInspector()
      let n = 0
      inspector.subscribe(() => {
        n++
      })
      await drain(sendOpts({ requestInspector: inspector }))
      expect(n).toBe(1)
    })
    await withEnv({ DEBUG: "1", VERBOSE: "1" }, async () => {
      // The legacy dump still runs under DEBUG (until Phase D); keep it off the process bus.
      const diagnostics = createDiagnostics({ emit: () => {} })
      await drain(sendOpts({ requestInspector: publishSpy(), diagnostics }))
    })
  })

  it("carries the final wire headers and other body fields, with no secret", async () => {
    const inspector = createRequestInspector()
    const seen: RequestWillSendEvent[] = []
    inspector.subscribe((e) => seen.push(e))
    await drain(sendOpts({ requestInspector: inspector }))
    expect(seen).toHaveLength(1)
    const req = seen[0].request
    expect(req.headers).toBeDefined()
    const names = Object.keys(req.headers ?? {})
    expect(names).toEqual([...names].sort())
    for (const n of names) expect(n).toBe(n.toLowerCase())
    expect(req.body).toBeDefined()
    for (const k of ["model", "messages", "tools", "system", "stream", "max_tokens"]) {
      expect(req.body && k in req.body).toBe(false)
    }
    expect(JSON.stringify(req)).not.toContain(SECRET)
  })
})

/**
 * The session sideband API reaches the provider `RunContext` (design step
 * 12b): `SendOptions.sideband` → `RunContext.sideband`, and the AgentCore
 * transport wrapper puts the session API on each send.
 *
 * @module llm/transport/canonical-send.sideband.test
 */

import { beforeAll, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "../../network/index.ts"
import { withSessionSideband } from "../../sdk/with-lifecycle-send.ts"
import { NO_SIDEBAND } from "../../sideband/api.ts"
import type { Message } from "../messages.ts"
import type { RunContext } from "../provider.ts"
import { registerTestProvider, sseBodyFromEvents } from "../test-fixtures.ts"

import { canonicalAttemptFn } from "./canonical-send.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "./types.ts"

const seen: RunContext[] = []

beforeAll(() => {
  const handle = registerTestProvider({ id: "sb-prov", models: [{ id: "sb-model" }] })
  const inner = handle.adapter.run.bind(handle.adapter)
  handle.adapter.run = (req, model, ctx) => {
    seen.push(ctx)
    return inner(req, model, ctx)
  }
})

function client(): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (_req: NetworkRequest) =>
      new NetworkResponse({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        transport: { id: "fake", protocol: "h2" },
        body: sseBodyFromEvents([
          {
            type: "message_start",
            messageId: "m1",
            modelId: "sb-model",
            initialUsage: { inputTokens: 1, outputTokens: 0 },
          },
          { type: "text_start", index: 0 },
          { type: "text_delta", index: 0, text: "ok" },
          { type: "text_stop", index: 0 },
          {
            type: "message_delta",
            stopReason: "end_turn",
            usage: { inputTokens: 1, outputTokens: 1 },
          },
          { type: "message_stop" },
        ]),
      }),
  }
  return new NetworkClient({ primary: transport })
}

const auth: AuthResult = { type: "provider", auth: { kind: "api-key", key: "k" } }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
  while (!(await gen.next()).done) {
    // drain
  }
}

describe("RunContext.sideband", () => {
  it("carries SendOptions.sideband to the provider", async () => {
    seen.length = 0
    await drain(
      canonicalAttemptFn({
        auth,
        messages,
        model: "sb-model",
        selectedProviderId: "sb-prov",
        stream: true,
        networkClient: client(),
        sideband: NO_SIDEBAND,
      }),
    )
    expect(seen.length).toBe(1)
    expect(seen[0]?.sideband).toBe(NO_SIDEBAND)
  })

  it("has no sideband when the send gives none", async () => {
    seen.length = 0
    await drain(
      canonicalAttemptFn({
        auth,
        messages,
        model: "sb-model",
        selectedProviderId: "sb-prov",
        stream: true,
        networkClient: client(),
      }),
    )
    expect(seen.length).toBe(1)
    expect("sideband" in (seen[0] ?? {})).toBe(false)
  })
})

describe("withSessionSideband", () => {
  const capture = (): { fn: TransportFn; got: SendOptions[] } => {
    const got: SendOptions[] = []
    const fn: TransportFn = async function* (opts) {
      got.push(opts)
      return { blocks: [], text: "", stopReason: null } as StreamedResponse
    }
    return { fn, got }
  }

  it("adds the session API to each send", async () => {
    const { fn, got } = capture()
    await drain(withSessionSideband(fn, NO_SIDEBAND)({ auth, messages }))
    expect(got[0]?.sideband).toBe(NO_SIDEBAND)
  })

  it("keeps a caller value, and is the identity with no API", async () => {
    const { fn, got } = capture()
    const other = { ...NO_SIDEBAND }
    await drain(withSessionSideband(fn, NO_SIDEBAND)({ auth, messages, sideband: other }))
    expect(got[0]?.sideband).toBe(other)
    expect(withSessionSideband(fn, undefined)).toBe(fn)
  })
})

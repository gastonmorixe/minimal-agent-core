/**
 * The hook payload `sid` of a runtime session is that session's own id, not
 * the process session id. And reading the host facts never mints the
 * process id, so `setSessionId` still works after it.
 *
 * @module runtime/session-facts-sid.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { allowDecision, type LifecyclePort, type TurnWillStopPayload } from "../sdk/lifecycle.ts"
import {
  _resetSessionId,
  getSessionId,
  peekSessionId,
  setSessionId,
} from "../session/session-id.ts"

import { hostSessionFacts } from "./host-session-facts.ts"
import { createRuntime } from "./runtime.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const SAMPLE_UUID = "9c1a4f2e-0b3d-4a6c-8e1f-2d3c4b5a6978"

const transport: TransportFn = async function* () {
  return {
    blocks: [{ type: "text", text: "ok" }],
    text: "ok",
    stopReason: "end_turn",
  } as StreamedResponse
}

async function drain(entries: AsyncIterable<unknown>): Promise<void> {
  for await (const _ of entries) {
    /* drain */
  }
}

describe("runtime session sid", () => {
  it("two sessions in one process give their own sid to turn.willStop", async () => {
    const seen: TurnWillStopPayload[] = []
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        seen.push(p)
        return allowDecision(p)
      },
    }
    const runtime = createRuntime()
    const a = runtime.openSession({ auth: AUTH, model: "m", sendFn: transport, lifecycle })
    const b = runtime.openSession({ auth: AUTH, model: "m", sendFn: transport, lifecycle })
    await drain(a.run("go"))
    await drain(b.run("go"))
    expect(a.id).not.toBe(b.id)
    expect(seen.map((p) => p.sid)).toEqual([a.id, b.id])
    runtime.close()
  })
})

describe("hostSessionFacts and the process session id", () => {
  it("does not mint an id, so setSessionId still works after it", () => {
    _resetSessionId()
    try {
      const facts = hostSessionFacts()
      expect(facts.sid).toBeUndefined()
      expect(peekSessionId()).toBeUndefined()
      expect(() => setSessionId(SAMPLE_UUID)).not.toThrow()
      expect(hostSessionFacts().sid).toBe(SAMPLE_UUID)
      expect(getSessionId()).toBe(SAMPLE_UUID)
    } finally {
      _resetSessionId()
    }
  })
})

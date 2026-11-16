/**
 * `providerMessageId`: the provider response id (e.g. Anthropic `msg_…`)
 * captured from `message_start`, stored on the assistant history message,
 * persisted on the session `assistant` record, restored on resume, and
 * carried to the canonical request as metadata. The wire-leak check lives in
 * `plugin-api/src/llm/provider-message-id.wire.test.ts`.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { loadSession } from "../../session/session-restore.ts"
import { SessionStore } from "../../session/session-store.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import type { Message } from "../messages.ts"
import { resetStreamDeltaAccumulator } from "../transport/stream-delta.ts"

import { messageFromCanonical, messageToCanonical } from "./message-codec.ts"
import { assembleStreamedResponse } from "./stream-assembler.ts"

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const e of events) yield e
}

async function drain(events: CanonicalEvent[]) {
  const gen = assembleStreamedResponse(fromArray(events))
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  return next.value
}

afterEach(() => resetStreamDeltaAccumulator())

const usage = { inputTokens: 1, outputTokens: 1 }

const textTurn = (messageId = ""): CanonicalEvent[] => [
  { type: "message_start", messageId, modelId: "m", initialUsage: usage },
  { type: "text_start", index: 0 },
  { type: "text_delta", index: 0, text: "hello" },
  { type: "text_stop", index: 0 },
  { type: "message_delta", stopReason: "end_turn", usage },
]

describe("stream assembler providerMessageId", () => {
  it("is set from message_start when the stream reaches message_stop", async () => {
    const res = await drain([...textTurn("msg_01abc"), { type: "message_stop" }])
    expect(res.providerMessageId).toBe("msg_01abc")
    expect(res.responseId).toBe("msg_01abc")
  })

  it("is absent when the provider sends no id", async () => {
    const res = await drain([...textTurn(), { type: "message_stop" }])
    expect(res.providerMessageId).toBeUndefined()
    expect("providerMessageId" in res).toBe(false)
  })

  it("is absent when the stream ends without message_stop", async () => {
    const res = await drain(textTurn("msg_01abc"))
    expect(res.providerMessageId).toBeUndefined()
    expect(res.responseId).toBe("msg_01abc")
  })

  it("is absent on a salvaged terminal-less stream", async () => {
    const res = await drain([
      { type: "message_start", messageId: "resp_1", modelId: "m", initialUsage: usage },
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "partial" },
      {
        type: "stream_error",
        retryable: true,
        category: "api",
        upstreamType: "stream_closed_without_terminal",
      },
    ])
    expect(res.stopDetails?.type).toBe("stream_closed_without_terminal")
    expect(res.providerMessageId).toBeUndefined()
  })
})

describe("message codec providerMessageId", () => {
  it("round-trips stored <-> canonical on assistant messages", () => {
    const stored: Message = {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      providerMessageId: "msg_01abc",
    }
    const canon = messageToCanonical(stored)
    expect(canon.providerMessageId).toBe("msg_01abc")
    expect(messageFromCanonical(canon).providerMessageId).toBe("msg_01abc")
  })

  it("adds no key to messages without an id", () => {
    const canon = messageToCanonical({ role: "assistant", content: [{ type: "text", text: "hi" }] })
    expect("providerMessageId" in canon).toBe(false)
  })
})

describe("session persistence providerMessageId", () => {
  const baseOpenOpts = {
    model: "test-model",
    cwd: "/tmp/x",
    systemHash: "h",
    toolsHash: "h",
    agentVersion: "test",
  }

  it("is written to the jsonl and restored on resume; old records still load", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-pmid-"))
    const sid = "ma-test-pmid"
    const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
    store.appendUser("one")
    store.appendAssistant([{ type: "text", text: "old" }], "end_turn")
    store.appendUser("two")
    store.appendAssistant([{ type: "text", text: "new" }], "end_turn", undefined, undefined, {
      providerMessageId: "msg_01xyz",
    })

    const lines = readFileSync(store.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; providerMessageId?: string })
    const assistants = lines.filter((r) => r.kind === "assistant")
    expect(assistants.map((r) => r.providerMessageId)).toEqual([undefined, "msg_01xyz"])

    const loaded = loadSession(sid, dir)
    const restored = loaded.messages.filter((m) => m.role === "assistant")
    expect(restored).toHaveLength(2)
    expect("providerMessageId" in (restored[0] as object)).toBe(false)
    expect(restored[1]?.providerMessageId).toBe("msg_01xyz")
  })
})

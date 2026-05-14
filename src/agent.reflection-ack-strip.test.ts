import { describe, expect, it } from "bun:test"
import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { SendOptions, StreamedResponse } from "./client.ts"

/**
 * Agent-level contract for the reflection-ack stripper wiring (the unit
 * tests live in `src/reflection-ack-stripper.test.ts`). This file pins
 * the integration: when the model streams a `<ma::reflection-ack ... />`
 * tag in its text channel, the yielded chunks reaching the REPL sink
 * must NOT contain the raw XML, while the agent's internal
 * `parseReflectionAck` (which reads the full `StreamedResponse.text`
 * separately) MUST still see the tag and apply the silence-for counter.
 */
describe("Agent.run reflection-ack stream stripping", () => {
  const auth: AuthResult = { type: "api-key", token: "test-token" }

  function buildSendFn(chunks: string[], fullText: string) {
    return async function* (
      _opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      for (const c of chunks) yield c
      return {
        blocks: [{ type: "text", text: fullText }],
        text: fullText,
        stopReason: "end_turn",
      } as StreamedResponse
    }
  }

  it("strips a complete reflection-ack tag from the yielded stream", async () => {
    const fullText =
      'prose paragraph\n\n<ma::reflection-ack silence-for="2" reason="batch" />\n\nmore prose'
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: buildSendFn([fullText], fullText),
    })
    const collected: string[] = []
    const gen = agent.run("hi")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      collected.push(value as string)
    }
    const yielded = collected.join("")
    expect(yielded).not.toContain("<ma::reflection-ack")
    expect(yielded).not.toContain("silence-for=")
    expect(yielded).toContain("prose paragraph")
    expect(yielded).toContain("more prose")
  })

  it("strips the tag across SSE-style chunk boundaries (per-byte adversarial)", async () => {
    const fullText = 'before\n<ma::reflection-ack silence-for="3" reason="x" />\nafter'
    // Split into single-byte chunks — the most adversarial SSE granularity.
    const chunks = Array.from(fullText, (ch) => ch)
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: buildSendFn(chunks, fullText),
    })
    const collected: string[] = []
    const gen = agent.run("hi")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      collected.push(value as string)
    }
    const yielded = collected.join("")
    expect(yielded).not.toContain("<ma::reflection-ack")
    expect(yielded).not.toContain("<ma::")
    expect(yielded).toContain("before")
    expect(yielded).toContain("after")
  })

  it("preserves text without any reflection-ack tag (passthrough)", async () => {
    const fullText = "plain text response with no special tags"
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: buildSendFn([fullText], fullText),
    })
    const collected: string[] = []
    const gen = agent.run("hi")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      collected.push(value as string)
    }
    expect(collected.join("")).toBe(fullText)
  })

  it("Agent.send strips the tag too (no-tools single-shot path)", async () => {
    const fullText = 'reply text\n<ma::reflection-ack silence-for="1" />\ntrailing'
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: buildSendFn([fullText], fullText),
    })
    const collected: string[] = []
    const gen = agent.send("hi")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      collected.push(value as string)
    }
    const yielded = collected.join("")
    expect(yielded).not.toContain("<ma::reflection-ack")
    expect(yielded).toContain("reply text")
    expect(yielded).toContain("trailing")
  })

  it("partial / incomplete tag at end-of-stream is flushed verbatim (never silently dropped)", async () => {
    // The model emits an opener but the stream ends before `/>` arrives.
    // Per the stripper's flush() contract, the held bytes emerge as-is so
    // the user can see something went wrong rather than have prose vanish.
    const fullText = 'fine prose <ma::reflection-ack silence-for="2"'
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: buildSendFn([fullText], fullText),
    })
    const collected: string[] = []
    const gen = agent.run("hi")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      collected.push(value as string)
    }
    expect(collected.join("")).toBe(fullText)
  })
})

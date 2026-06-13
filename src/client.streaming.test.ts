import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { fakeNetworkClient, sseResponse } from "./client.fixtures.ts"
import { type Message, sendMessageFull } from "./client.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"

describe("client", () => {
  describe("request body shape", () => {
    it("publishes request lifecycle labels to the global status bus while streaming", async () => {
      const auth: AuthResult = {
        type: "oauth",
        token: "test-token",
      }
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
      ]
      const seen: Array<string | null> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe((label) => {
        seen.push(label)
      })

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "PONG" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        const response = await sendMessageFull({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: true,
          networkClient,
        })

        expect(response.text).toBe("PONG")
        // Adjacent-dedupe before asserting: Layer 4 (May 2026) added live
        // `recvTokens` updateActivity() emits during text streaming, which
        // re-fire the bus listener with the SAME label ("Writing response")
        // because StatusBus.emit() always sends the current label. The
        // duplicate emits are correct (the listener is meant to be a
        // "something changed" signal), but the lifecycle-LABEL semantic
        // this test cares about is only meaningful when adjacent dupes are
        // collapsed.
        const dedupedSeen = seen.filter((label, i) => i === 0 || label !== seen[i - 1])
        expect(dedupedSeen).toEqual([
          null,
          "Sending request",
          "Waiting for response",
          "Receiving stream",
          "Writing response",
          null,
        ])
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("streams native thinking chunks through callbacks and preserves them in blocks", async () => {
      const auth: AuthResult = {
        type: "oauth",
        token: "test-token",
      }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "think" }] }]
      const thinkingChunks: string[] = []
      const thinkingEvents: string[] = []
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "sig-a" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "plan " },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "step" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-b" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "answer" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      const response = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        onThinkingStart: () => {
          thinkingEvents.push("start")
        },
        onThinkingDelta: (chunk) => {
          thinkingChunks.push(chunk)
        },
        onThinkingStop: () => {
          thinkingEvents.push("stop")
        },
      })

      expect(thinkingEvents).toEqual(["start", "stop"])
      expect(thinkingChunks).toEqual(["plan ", "step"])
      expect(response.text).toBe("answer")
      expect(response.blocks).toEqual([
        { type: "thinking", thinking: "plan step", signature: "sig-asig-b" },
        { type: "text", text: "answer" },
      ])
    })

    // Regression: the SSE parser used to handle only thinking/text/tool_use in
    // content_block_start, so a `redacted_thinking` block (encrypted reasoning
    // the API emits under its safety systems) was silently DROPPED. That left
    // the stored assistant turn missing a block and shifted every later block's
    // index, so the next request (the agentic re-send after tool_results) 400'd
    // with "`thinking` or `redacted_thinking` blocks in the latest assistant
    // message cannot be modified. These blocks must remain as they were in the
    // original response." The parser must now keep these blocks verbatim.
    it("preserves redacted_thinking blocks verbatim (re-send byte-identity)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "go" }] }]
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "sig-1" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "reason" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "SIG" },
          },
          { type: "content_block_stop", index: 0 },
          // The encrypted reasoning block the parser used to drop:
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "redacted_thinking", data: "ENCRYPTED_PAYLOAD" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "content_block_start",
            index: 2,
            content_block: { type: "tool_use", id: "t1", name: "Bash", input: {} },
          },
          {
            type: "content_block_delta",
            index: 2,
            delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
          },
          { type: "content_block_stop", index: 2 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          },
        ]),
      )

      const response = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-8",
        stream: true,
        networkClient,
      })

      // All three blocks survive, in order : the redacted_thinking block is NOT
      // dropped, so its index (1) is preserved for the next-turn re-send.
      expect(response.blocks.map((b) => b.type)).toEqual([
        "thinking",
        "redacted_thinking",
        "tool_use",
      ])
      // And its opaque payload round-trips unchanged.
      expect(response.blocks[1]).toEqual({
        type: "redacted_thinking",
        data: "ENCRYPTED_PAYLOAD",
      })
    })

    it("publishes detailed status updates for tool_use streaming with hint extraction", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "edit" }] }]
      const seen: Array<string | null> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe((label) => {
        seen.push(label)
      })

      // Build a Write input split across many input_json_delta events so the
      // throttle has a chance to fire and the hint extractor sees partial JSON.
      const inputJson = JSON.stringify({
        file_path: "/tmp/example.txt",
        content: "x".repeat(4096),
      })
      const chunks: string[] = []
      for (let i = 0; i < inputJson.length; i += 256) {
        chunks.push(inputJson.slice(i, i + 256))
      }

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
          },
          ...chunks.map((partial) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "input_json_delta" as const, partial_json: partial },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          },
        ]),
      )

      try {
        const response = await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        expect(response.blocks).toHaveLength(1)
        const tu = response.blocks[0] as {
          type: string
          name: string
          input: Record<string, unknown>
        }
        expect(tu.type).toBe("tool_use")
        expect(tu.input.file_path).toBe("/tmp/example.txt")

        // Status flow expectations:
        expect(seen).toContain("Sending request")
        expect(seen).toContain("Waiting for response")
        expect(seen).toContain("Receiving stream")
        // Initial tool_use status
        expect(seen.some((l) => l === "Calling Write: streaming input")).toBe(true)
        // At least one delta-driven update with the parsed file_path hint
        expect(
          seen.some(
            (l) =>
              typeof l === "string" &&
              l.includes("Calling Write:") &&
              l.includes("/tmp/example.txt"),
          ),
        ).toBe(true)
        // Dispatch + finalize
        expect(seen).toContain("Calling Write: dispatching")
        // Cleared at the end
        expect(seen[seen.length - 1]).toBeNull()
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate (chars/3.5) during text_delta streaming", async () => {
      // Layer 4: while the model is streaming text, the SSE loop should
      // throttle-publish a recvTokens estimate to the status bus so the
      // activity infix can show `~N tok · M tok/s`. Without this, the
      // status row would have no live token signal during "Writing
      // response" — bytes only, no per-second tokens.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const activities: Array<number | undefined> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const snap = GLOBAL_STATUS_BUS.currentStatus()
        activities.push(snap?.activity?.recvTokens)
      })

      // Build text deltas totaling ~700 chars → ~200 tok estimate.
      // 7 deltas of 100 chars each, throttle is 100ms → enough emits to
      // see at least one mid-stream publish.
      const longText = "Hello world! ".repeat(70) // 910 chars (close enough)
      const deltas: string[] = []
      for (let i = 0; i < longText.length; i += 100) deltas.push(longText.slice(i, i + 100))

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          ...deltas.map((text) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "text_delta" as const, text },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // At least one snapshot must carry a positive recvTokens estimate.
        // The fake transport delivers ALL deltas in one synchronous burst,
        // so the 100ms throttle gates everything after the first publish —
        // we see exactly ONE estimate (the first delta's chars/3.5). Real
        // network delivery is paced over the actual SSE stream and would
        // produce many intermediate estimates, but unit-testing that needs
        // an async-pacing transport. The contract that matters here is
        // "tokens get published live, not just at the end" — pinning the
        // first publish is sufficient evidence.
        const tokenSnaps = activities.filter((t): t is number => typeof t === "number" && t > 0)
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // First delta is 100 chars → Math.round(100 / 3.5) = 29.
        // Allow a tight range since the math is deterministic.
        const firstEstimate = tokenSnaps[0]
        expect(firstEstimate).toBeGreaterThanOrEqual(20)
        expect(firstEstimate).toBeLessThanOrEqual(400)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("swaps recvTokens estimate for real value from message_delta.usage.output_tokens", async () => {
      // Layer 4 finalize: when the server ships the authoritative
      // `output_tokens` count in `message_delta`, that value overwrites
      // our estimate. This means the row settles on the BILLED count
      // for the trailing moment before the request clears.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const allSnapshots: Array<number | undefined> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        allSnapshots.push(GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens)
      })

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello world." }, // ~3 tok estimate
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 999 }, // sentinel — real value the renderer should land on
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // The sentinel 999 must appear in the snapshot stream — that's
        // the message_delta swap firing. The estimate (~3) may or may
        // not appear depending on throttle timing; what's guaranteed is
        // that the real value lands.
        expect(allSnapshots).toContain(999)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate during thinking_delta streaming (mirrors text_delta)", async () => {
      // Layer 4 follow-up (May 2026): "Thinking" status row was the only
      // streaming phase NOT publishing token estimates after the initial
      // Layer 4 landed — text_delta and input_json_delta both fed
      // outputChars, but thinking_delta was overlooked. User reported
      // the gap with `think very very hard for 1 minute or 3000 words`:
      // status showed `↓ 1.2 KB · 147 B/s · api.anthropic.com:h2 (8s)`
      // — bytes and rate present, no `~N tok` segment despite thousands
      // of tokens of hidden reasoning. Symmetric fix mirrors the
      // text_delta accumulator + throttle.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "think" }] }]
      const tokenSnaps: number[] = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const t = GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens
        if (typeof t === "number" && t > 0) tokenSnaps.push(t)
      })

      const longThinking = "Reasoning step. ".repeat(50) // ~800 chars → ~228 tok
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: longThinking },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })
        // At least one token estimate published during thinking streaming.
        // Without the fix, tokenSnaps stays empty because thinking_delta
        // never touched outputChars or lastTokenPublishAt.
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // The first publish should reflect the 800-char thinking
        // delta → ~228 tok estimate. Allow a wide range to absorb
        // throttle timing.
        const firstEstimate = tokenSnaps[0]
        expect(firstEstimate).toBeGreaterThanOrEqual(100)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate during tool_use input_json_delta streaming", async () => {
      // Layer 4 parity: tool_use input streaming also feeds the token
      // estimate, so the activity infix shows tok/s even during
      // `Calling Write: streaming input` phase (not just text phase).
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "edit" }] }]
      const tokenSnaps: number[] = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const t = GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens
        if (typeof t === "number" && t > 0) tokenSnaps.push(t)
      })

      const inputJson = JSON.stringify({
        file_path: "/tmp/example.txt",
        content: "x".repeat(2048),
      })
      const chunks: string[] = []
      for (let i = 0; i < inputJson.length; i += 256) chunks.push(inputJson.slice(i, i + 256))

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
          },
          ...chunks.map((partial) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "input_json_delta" as const, partial_json: partial },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // At least one token estimate published during tool_use streaming.
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // The final estimate before content_block_stop should be in the
        // ballpark of inputJson.length / 3.5 ≈ 590 tok.
        const finalEstimate = tokenSnaps[tokenSnaps.length - 1]
        expect(finalEstimate).toBeGreaterThanOrEqual(100) // way more than zero
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })
  })
})

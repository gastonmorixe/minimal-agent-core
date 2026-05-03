import { describe, expect, it } from "bun:test"
import { type AuthResult, getAuth } from "./auth.ts"
import { type Message, sendMessageFull, sendMessageSync } from "./client.ts"
import { buildSystemPrompt, SYSTEM_PROMPT } from "./headers.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

function sseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"))
        controller.close()
      },
    }),
  })
}

describe("client", () => {
  describe("request body shape", () => {
    it("SYSTEM_PROMPT has 3 blocks: billing, identity, instructions", () => {
      expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(3)
      expect(SYSTEM_PROMPT[0].text).toContain("x-anthropic-billing-header")
      expect(SYSTEM_PROMPT[0].text).toContain("cc_version=2.1.118")
      expect(SYSTEM_PROMPT[1].text).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      )
      // cache_control is on system[2] (instructions), NOT system[1] (identity)
      expect(SYSTEM_PROMPT[1]).not.toHaveProperty("cache_control")
      expect(SYSTEM_PROMPT[2].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
        scope: "global",
      })
    })

    it("buildSystemPrompt with session context produces 4 blocks", () => {
      const blocks = buildSystemPrompt({ sessionContext: "test context" })
      expect(blocks).toHaveLength(4)
      expect(blocks[3].text).toBe("test context")
      // system[3] now carries cache_control (ttl:"1h", no scope) per 2.1.118
      expect(blocks[3].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    })

    it("conversation request body matches 2.1.118 wire shape", async () => {
      // Empirical verification of tasks #3-#7: capture the actual JSON body
      // sent to /v1/messages and assert it carries (a) cache_control with
      // ttl:"1h" on system[2] and system[3], (b) a rolling cache_control on
      // the trailing message block, (c) top-level context_management, and
      // (d) output_config.effort defaulting to "medium" for opus.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const sysCtx = "x".repeat(2000) // non-empty session context
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "last block" },
          ],
        },
      ]

      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      // withRollingCacheBreakpoint lives in agent.ts but we replicate its
      // marking here by passing pre-marked messages; the same effect.
      const { withRollingCacheBreakpoint } = await import("./agent.ts")
      const sys = buildSystemPrompt({ sessionContext: sysCtx })
      await sendMessageFull({
        auth,
        messages: withRollingCacheBreakpoint(messages),
        model: "claude-opus-4-7",
        system: sys,
        stream: true,
        networkClient,
      })

      expect(capturedBody).not.toBeNull()
      const body = JSON.parse(capturedBody!)

      // (a) system[2] and system[3] both carry cache_control with ttl:"1h"
      expect(body.system[2].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
        scope: "global",
      })
      expect(body.system[3].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      })

      // (b) trailing message has cache_control on the LAST block only
      const tail = body.messages[body.messages.length - 1].content
      expect(tail[tail.length - 1].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      })
      // earlier blocks of the trailing message do NOT carry cache_control
      expect(tail[0].cache_control).toBeUndefined()

      // (c) context_management is present (default for "conversation")
      expect(body.context_management).toEqual({
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      })

      // (d) output_config.effort defaults to "medium" for opus
      expect(body.output_config).toEqual({ effort: "medium" })

      // (e) total active cache_control breakpoints stays ≤ 4
      const countBreakpoints = (obj: unknown): number => {
        let n = 0
        const walk = (v: unknown) => {
          if (!v || typeof v !== "object") return
          if (Array.isArray(v)) return v.forEach(walk)
          for (const [k, val] of Object.entries(v)) {
            if (k === "cache_control" && val) n++
            else walk(val)
          }
        }
        walk(obj)
        return n
      }
      const total = countBreakpoints(body)
      expect(total).toBeLessThanOrEqual(4)
      expect(total).toBe(3) // sys[2], sys[3], rolling tail
    })

    it("omits context_management.clear_thinking for haiku (thinking disabled)", async () => {
      // Regression: clear_thinking_20251015 requires `thinking` to be enabled
      // or adaptive. Haiku has no thinking, so the API rejects the request
      // with a 400 if we send the strategy. Verify we drop it.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "claude-haiku-4-5-20251001",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      // Haiku: no `thinking` field, and therefore no context_management
      expect(body.thinking).toBeUndefined()
      expect(body.context_management).toBeUndefined()
    })

    it("includes context_management.clear_thinking when thinking is set (opus/sonnet)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.context_management).toEqual({
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      })
    })

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
        expect(seen).toEqual([
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
        const tu = response.blocks[0] as { type: string; name: string; input: Record<string, unknown> }
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
            (l) => typeof l === "string" && l.includes("Calling Write:") && l.includes("/tmp/example.txt"),
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

    it("forwards SendOptions.signal to networkClient.request", async () => {
      let captured: NetworkRequest | null = null
      const networkClient = fakeNetworkClient((req) => {
        captured = req
        return sseResponse([
          { type: "message_start", message: { id: "x", model: "claude", usage: {} } },
          { type: "message_stop" },
        ])
      })
      const ac = new AbortController()
      const auth: AuthResult = { token: "tok", refresh: undefined }
      await sendMessageFull({
        auth,
        messages: [{ role: "user", content: "hi" }],
        networkClient,
        signal: ac.signal,
      })
      expect(captured).not.toBeNull()
      // The captured network request must carry the SAME signal instance
      // we passed in — cancellation has to walk all the way through to
      // the fetch/http2 transport for Esc/Ctrl+C abort to actually tear
      // down the in-flight HTTP/2 stream.
      expect((captured as unknown as NetworkRequest).signal).toBe(ac.signal)
    })
  })

  describe("e2e", () => {
    const skip = !process.env.E2E

    it.skipIf(skip)(
      "sends a haiku request and gets a response",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: true,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("PONG")
      },
      30_000,
    )

    it.skipIf(skip)(
      "sends a non-streaming request",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: HELLO" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: false,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("HELLO")
      },
      30_000,
    )
  })
})

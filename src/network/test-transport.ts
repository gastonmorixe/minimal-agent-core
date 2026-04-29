import { NetworkResponse, type NetworkRequest, type NetworkTransport } from "./types.ts"

/**
 * Test-only transport for spawned CLI smoke tests.
 *
 * It is intentionally not wired into production unless NODE_ENV/BUN_ENV is
 * "test", so a real user cannot accidentally replace the API transport.
 */
export class TestTransport implements NetworkTransport {
  readonly id = "test"

  async request(_req: NetworkRequest): Promise<NetworkResponse> {
    const text = process.env.MINIMAL_AGENT_TEST_RESPONSE ?? "PONG"
    const encoder = new TextEncoder()
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_test",
          model: "test-model",
          usage: { cache_creation_input_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
      },
      { type: "message_stop" },
    ]

    return new NetworkResponse({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      transport: { id: this.id, protocol: "h2", reused: true },
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
}

/**
 * Shared test fixtures for the `client` test files (`client.test.ts`,
 * `client.streaming.test.ts`, `client.quota.test.ts`,
 * `client.errors.test.ts`). Not a test file itself.
 */

import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"

/** Handler signature for the fake transport. */
export type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

/** NetworkClient whose only transport delegates to `handler`. */
export function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

/** SSE 200 response streaming `events` then `[DONE]`; auto-appends message_stop. */
export function sseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  // Auto-append message_stop before [DONE] unless the caller already
  // provided one. Mirrors real Anthropic streams — every well-formed
  // response ends with message_stop. The stream watchdog in
  // sendMessageOnce throws stream_truncated if absent, so tests that
  // forget message_stop hang indefinitely (or until the watchdog timer
  // fires). Tests that WANT to exercise the truncation path should use
  // a different helper (see client.stream-watchdog.test.ts).
  const hasMessageStop = events.some(
    (e) => typeof e === "object" && e !== null && (e as { type?: string }).type === "message_stop",
  )
  // Some tests pass `{ type: "error" }` to exercise the mid-stream error
  // path — that throws before reaching the truncation check, so the
  // absence of message_stop is fine there. We still skip injection for
  // single-event streams whose only event is `error` so the test's wire
  // shape stays faithful.
  const onlyError =
    events.length === 1 &&
    typeof events[0] === "object" &&
    events[0] !== null &&
    (events[0] as { type?: string }).type === "error"
  const allEvents = hasMessageStop || onlyError ? events : [...events, { type: "message_stop" }]
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of allEvents) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"))
        controller.close()
      },
    }),
  })
}

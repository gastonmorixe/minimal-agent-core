/**
 * Driver for `streaming-status-tmux.test.ts`.
 *
 * Runs the real line-mode status renderer plus `sendMessageFull` against a
 * fake SSE transport that streams a chunky `tool_use` Write block. Kept under
 * `src/test-utils/fixtures` so the tmux smoke test does not depend on ignored
 * local files under `tmp/`.
 */
import type { AuthResult } from "../../auth.ts"
import { type Message, sendMessageFull } from "../../client.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "../../network/index.ts"
import { GLOBAL_STATUS_BUS } from "../../status.ts"
import { StatusRenderer } from "../../ui/status/line-renderer.ts"

;(process.stdout as { isTTY?: boolean }).isTTY = true
const renderer = new StatusRenderer(GLOBAL_STATUS_BUS, process.stdout)
renderer.start()

const inputJson = JSON.stringify({
  file_path: "/Users/gaston/Projects/example/big-config.yaml",
  content: "# config\n".repeat(2048),
})
const chunks: string[] = []
for (let i = 0; i < inputJson.length; i += 512) {
  chunks.push(inputJson.slice(i, i + 512))
}

const events: unknown[] = [
  { type: "message_start", message: { usage: {} } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
  },
  ...chunks.map((c) => ({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: c },
  })),
  { type: "content_block_stop", index: 0 },
  { type: "__pause", ms: 500 },
  { type: "message_delta", delta: { stop_reason: "tool_use" } },
  { type: "message_stop" },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let cursor = 0

const transport: NetworkTransport = {
  id: "fake",
  request: async () =>
    new NetworkResponse({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      transport: { id: "fake", protocol: "h2" },
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (cursor >= events.length) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n"))
            controller.close()
            return
          }
          await sleep(60)
          const event = events[cursor] as { type: string; ms?: number }
          if (event?.type === "__pause") {
            cursor++
            await sleep(event.ms ?? 200)
            controller.enqueue(new TextEncoder().encode(""))
            return
          }
          const nextEvent = events[cursor++]
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(nextEvent)}\n`))
        },
      }),
    }),
}

const auth: AuthResult = { type: "oauth", token: "x" }
const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

await sendMessageFull({
  auth,
  messages,
  model: "model-primary",
  stream: true,
  networkClient: new NetworkClient({ primary: transport }),
})

await sleep(800)
renderer.stop()
process.stdout.write("\nDONE\n")

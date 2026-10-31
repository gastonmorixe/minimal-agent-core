/**
 * Child process for the exit-tail spawn test. It runs the real
 * `runNonInteractivePrompt` on the stream-json route with the real
 * `process.stdout` and the real exit path (no injected `stdout` or `exit`).
 *
 * The session streams one large text, then the next request fails with a
 * permanent error. So the run pauses (outcome `waiting`), and the route
 * ends with exit code 1 right after the last line. Usage:
 *   bun run stream-json-exit-child.ts <textBytes>
 *
 * @module host/startup/fixtures/stream-json-exit-child
 */

import type { AuthResult } from "../../../auth/auth.ts"
import type { StreamedResponse } from "../../../llm/transport/types.ts"
import { createRuntime } from "../../../runtime/runtime.ts"
import type { ToolExecResult, ToolExecutor } from "../../../sdk/ports.ts"
import type { ReplAgentLike } from "../../repl.ts"
import { runNonInteractivePrompt } from "../run-non-interactive.ts"

const size = Number(process.argv[2] ?? "1000000")
const text = "x".repeat(size)
const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class OkExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "ok", isError: false }
  }
}

let round = 0
// Round 1 streams the large text and asks for a tool, so the loop sends a
// second request. Round 2 throws a permanent error, which pauses the run.
const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
  round++
  if (round === 1) {
    yield text
    return {
      blocks: [
        { type: "text" as const, text },
        { type: "tool_use" as const, id: "call-1", name: "Probe", input: {} },
      ],
      text,
      stopReason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as StreamedResponse
  }
  throw Object.assign(new Error("permanent upstream failure"), { errorClass: "permanent" })
}

// The legacy-path agent never runs on the event-stream route.
const neverAgent = {
  run(): never {
    throw new Error("legacy-path agent.run must not be called")
  },
} as unknown as ReplAgentLike

await runNonInteractivePrompt({
  agent: neverAgent,
  prompt: "go",
  formatterCmd: undefined,
  showHeader: false,
  wantJsonOutput: false,
  outputSchema: undefined,
  loader: null,
  cwd: process.cwd(),
  outputFormat: "stream-json",
  openEventStreamSession: () =>
    Promise.resolve(
      createRuntime().openSession({
        auth: AUTH,
        model: "test-model",
        toolRegistry: {
          list: () => [{ name: "Probe", description: "probe", input_schema: {} }],
        },
        toolExecutor: new OkExecutor(),
        transcriptSink: { write: () => {} },
        sendFn,
        id: "exit-tail-sid",
      }),
    ),
})

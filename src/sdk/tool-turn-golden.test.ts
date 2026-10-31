/**
 * Golden for a tool turn on the JSON route (spec S18, S19): one round that
 * runs a tool, then a text answer, serialized through the real
 * {@link JsonlEventSink} (default `kinds`: the nine legacy kinds only, so
 * `user_message` and `run_finished` do not appear here). The bytes are
 * exact. Written before S19 added the tool facts; the S19 commit updated it
 * by ADDING `toolName` to `item_started` and `inputSummary` /
 * `outputSummary` / `durationMs` to `tool_result` — no key was removed, and
 * no new line appeared, which is the S19 check.
 *
 * @module sdk/tool-turn-golden.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import { JsonlEventSink } from "./events.ts"
import type { ToolExecResult } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** A clock that never moves, so durations are stable. */
const STILL_CLOCK: RetryClock = { now: () => 1_000, sleep: async () => {} }

/** Round 1 asks for `Grep`, round 2 answers in text. */
function toolTurnSend() {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "call-1",
            name: "Grep",
            input: { pattern: "TODO", path: "src" },
          },
        ],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      }
    }
    yield "found it"
    return {
      blocks: [{ type: "text" as const, text: "found it" }],
      text: "found it",
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 4 },
    }
  }
}

async function runToolTurn(): Promise<string> {
  const out: string[] = []
  const result: ToolExecResult = {
    content: "src/a.ts:1: TODO one\nsrc/b.ts:9: TODO two",
    isError: false,
  }
  const core = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: {
      list: () => [{ name: "Grep", description: "search", input_schema: {} }],
    },
    toolExecutor: { execute: async () => result },
    transcriptSink: { write: () => {} },
    sendFn: toolTurnSend(),
    eventSink: new JsonlEventSink((line) => out.push(line)),
    retry: { clock: STILL_CLOCK },
  })
  const gen = core.run("find the todos")
  while (!(await gen.next()).done) {
    // drain
  }
  return out.join("")
}

describe("tool-turn golden (JSON route)", () => {
  it("serializes a tool turn to the exact JSONL bytes", async () => {
    expect(await runToolTurn()).toBe(
      [
        `{"type":"turn_started","turn":1}`,
        `{"type":"item_started","itemType":"tool_use","id":"call-1","label":"Grep","toolName":"Grep","input":{"pattern":"TODO","path":"src"}}`,
        `{"type":"item_completed","itemType":"tool_use","id":"call-1","text":"Grep"}`,
        `{"type":"tool_result","id":"call-1","name":"Grep","isError":false,"inputSummary":"{\\"pattern\\":\\"TODO\\",\\"path\\":\\"src\\"}","outputSummary":"src/a.ts:1: TODO one (+1 line)","durationMs":0}`,
        `{"type":"turn_completed","turn":1,"stopReason":"tool_use","usage":{"inputTokens":10,"outputTokens":3}}`,
        `{"type":"turn_started","turn":2}`,
        `{"type":"item_started","itemType":"text","id":"2:0"}`,
        `{"type":"item_completed","itemType":"text","id":"2:0","text":"found it"}`,
        `{"type":"turn_completed","turn":2,"stopReason":"end_turn","usage":{"inputTokens":20,"outputTokens":4}}`,
        "",
      ].join("\n"),
    )
  })
})

/**
 * Integration test for the tool-header time-hint suffix.
 *
 * Wires a real `Agent` with a `ToolTimeTracker`, drives one tool round,
 * and asserts the rendered `╭` header line ends with ` · <time>` in the
 * expected format. Format-only assertions (regex) keep the test stable
 * across wall-clocks; we don't try to mock `Date.now()` because the
 * suffix is appended deep inside the run loop.
 *
 * The opt-in design (no tracker → no suffix) is also pinned here so a
 * future refactor can't silently flip the default.
 */

import { describe, expect, it } from "bun:test"

import type { StreamedResponse } from "../client/types.ts"
import { ToolTimeTracker } from "../tool-time.ts"

import { Agent } from "./agent.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "")
}

/**
 * Build a `sendFn` that emits one Bash `true` tool_use round, then a
 * trivial end-turn. Lets us exercise writeToolHeader with the real
 * executeTool path (which spawns `bash -c true` synchronously-fast).
 */
function singleBashRoundSendFn(): import("../llm/transport/types.ts").TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<unknown, StreamedResponse> {
    if (round === 0) {
      round++
      yield ""
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "toolu_test_round0",
            name: "Bash",
            input: { command: "true" },
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
    // biome-ignore lint/suspicious/noExplicitAny: test seam
  } as any as import("../llm/transport/types.ts").TransportFn
}

const TIME_RE = /(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d{2}:\d{2}:\d{2}/
const HMS_RE = /\d{2}:\d{2}:\d{2}/

describe("Agent tool header — time-hint suffix", () => {
  it("appends ` · Mon DD HH:MM:SS` on the first tool when tracker is wired", async () => {
    const agent = new Agent({
      auth: { type: "api-key", token: "test-token" },
      model: "test-model",
      sendFn: singleBashRoundSendFn(),
      toolTimeTracker: new ToolTimeTracker(),
    })
    const transcript: string[] = []
    for await (const _ of agent.run("hi", {
      onTranscriptLine: (line) => transcript.push(line),
    })) {
      // drain
    }
    const headerLine = transcript.find((l) => l.includes("╭"))
    expect(headerLine).toBeDefined()
    const plain = stripAnsi(headerLine ?? "")
    // First tool of a fresh tracker → cold-start, date prefix included.
    expect(plain).toMatch(new RegExp(` · ${TIME_RE.source}$`))
  })

  it("emits NO time suffix when toolTimeTracker is omitted (default)", async () => {
    const agent = new Agent({
      auth: { type: "api-key", token: "test-token" },
      model: "test-model",
      sendFn: singleBashRoundSendFn(),
      // no toolTimeTracker
    })
    const transcript: string[] = []
    for await (const _ of agent.run("hi", {
      onTranscriptLine: (line) => transcript.push(line),
    })) {
      // drain
    }
    const headerLine = transcript.find((l) => l.includes("╭"))
    expect(headerLine).toBeDefined()
    const plain = stripAnsi(headerLine ?? "")
    // Header must end with the bash command, not a time hint.
    expect(plain).toMatch(/\$ true$/)
    expect(plain).not.toMatch(HMS_RE)
  })

  it("uses HH:MM:SS only on the second tool of the same day (drops date)", async () => {
    // Two tool rounds back-to-back: first is "Mon DD HH:MM:SS" (cold),
    // second is bare "HH:MM:SS" (same calendar day).
    let round = 0
    const sendFn = async function* (): AsyncGenerator<unknown, StreamedResponse> {
      if (round === 0) {
        round++
        yield ""
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "toolu_test_two_a",
              name: "Bash",
              input: { command: "true" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      if (round === 1) {
        round++
        yield ""
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "toolu_test_two_b",
              name: "Bash",
              input: { command: "true" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "done"
      return {
        blocks: [{ type: "text" as const, text: "done" }],
        text: "done",
        stopReason: "end_turn",
      } as StreamedResponse
      // biome-ignore lint/suspicious/noExplicitAny: test seam
    } as any as import("../llm/transport/types.ts").TransportFn

    const agent = new Agent({
      auth: { type: "api-key", token: "test-token" },
      model: "test-model",
      sendFn,
      toolTimeTracker: new ToolTimeTracker(),
    })
    const transcript: string[] = []
    for await (const _ of agent.run("hi", {
      onTranscriptLine: (line) => transcript.push(line),
    })) {
      // drain
    }
    const headers = transcript.filter((l) => l.includes("╭")).map(stripAnsi)
    expect(headers.length).toBe(2)
    // Cold-start: includes "Mon DD".
    expect(headers[0]).toMatch(new RegExp(` · ${TIME_RE.source}$`))
    // Same-day repeat: bare HH:MM:SS, NO month name.
    expect(headers[1]).toMatch(/ · \d{2}:\d{2}:\d{2}$/)
    expect(headers[1]).not.toMatch(/(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/)
  })
})

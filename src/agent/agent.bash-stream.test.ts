/**
 * Live-streaming Bash output: regression guard for "the TUI shows nothing
 * for 20 seconds while bash is producing output every 0.25s". The agent
 * must forward stdout chunks to the host view as they arrive, not buffer
 * them until process exit. The rows that the CLI builds from the chunks are
 * pinned in the CLI tool transcript golden.
 */
import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import type { ToolViewEvent } from "./tool-view-port.ts"

describe("AgentCore.run live-streams Bash stdout to the host view", () => {
  it("emits output events incrementally while bash is still running", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Bash",
              // Print three lines, ~250ms apart. Total ~500ms.
              input: {
                command: "echo line-A; sleep 0.25; echo line-B; sleep 0.25; echo line-C",
              },
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
    }

    const auth: AuthResult = { type: "api-key", token: "test-token" }
    const stamps: { t: number; line: string }[] = []
    const t0 = Date.now()
    const agent = await buildTestCore({
      auth,
      sendFn,
      toolView: {
        onToolEvent: (e) => {
          if (e.type === "output") stamps.push({ t: Date.now() - t0, line: e.chunk })
        },
      },
    })
    const gen = agent.run("go")

    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const bodyRows = stamps

    // line-A appears in the FIRST body row.
    const aIdx = bodyRows.findIndex((s) => s.line.includes("line-A"))
    const cIdx = bodyRows.findIndex((s) => s.line.includes("line-C"))
    expect(aIdx).toBeGreaterThanOrEqual(0)
    expect(cIdx).toBeGreaterThanOrEqual(0)

    // Critical streaming assertion: line-A arrives well before line-C.
    // Without streaming, both would arrive at the same final timestamp
    // (process exit). The two echos are 0.5s apart in bash so we expect
    // at least ~200ms gap; bound it loosely to avoid flake.
    const dt = bodyRows[cIdx].t - bodyRows[aIdx].t
    expect(dt).toBeGreaterThan(200)
  }, 15_000)

  it("sends the output events between `started` and `executed`", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "call-1",
              name: "Bash",
              input: { command: "echo only-line" },
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
    }
    const events: ToolViewEvent[] = []
    const agent = await buildTestCore({
      auth: { type: "api-key", token: "t" } as AuthResult,
      model: "test",
      sendFn,
      toolView: { onToolEvent: (e) => void events.push(e) },
    })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    expect(events.map((e) => e.type)).toEqual(["started", "output", "executed", "outcome"])
    const output = events[1]
    expect(output?.type === "output" ? output.chunk : null).toBe("only-line\n")
  }, 10_000)
})

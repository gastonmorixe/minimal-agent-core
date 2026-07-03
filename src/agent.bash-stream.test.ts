/**
 * Live-streaming Bash output: regression guard for "the TUI shows nothing
 * for 20 seconds while bash is producing output every 0.25s". The agent
 * must forward stdout chunks to the transcript as they arrive, not buffer
 * them until process exit.
 */
import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { StreamedResponse } from "./client/types.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

describe("Agent.run live-streams Bash stdout to transcript", () => {
  it("emits `│ <line>` rows incrementally while bash is still running", async () => {
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
    const agent = new Agent({ auth, model: "test-model", sendFn })

    const stamps: { t: number; line: string }[] = []
    const t0 = Date.now()
    const gen = agent.run("go", {
      onTranscriptLine: (line: string) => {
        stamps.push({ t: Date.now() - t0, line: stripAnsi(line) })
      },
    })

    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // We should see header (╭) + 3 body rows (last row is ╰) for line-A,
    // line-B, line-C. Filter to just the bordered tool block.
    const bodyRows = stamps.filter((s) => s.line.includes("│") || s.line.includes("╰"))

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

  it("close glyph (╰) is the last row of the streamed body", async () => {
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
    const agent = new Agent({
      auth: { type: "api-key", token: "t" } as AuthResult,
      model: "test",
      sendFn,
    })
    const lines: string[] = []
    const gen = agent.run("go", {
      onTranscriptLine: (line: string) => lines.push(stripAnsi(line)),
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    // For a single-line clean run we expect: header (╭), close (╰ only-line),
    // and NO separate footer — the buffered-last-line trick replaces the
    // last `│` with `╰`.
    const closeRow = lines.find((l) => l.includes("╰"))
    expect(closeRow).toBeDefined()
    expect(closeRow!).toContain("only-line")
    // No row should have `│ only-line` (would mean we wrote the body
    // first and then a separate close glyph below).
    const dupBody = lines.find((l) => l.includes("│") && l.includes("only-line"))
    expect(dupBody).toBeUndefined()
  }, 10_000)

  it("header→body separator is `│` for Bash (no start-truncation)", async () => {
    // Regression for the gutter glyph between header and body. The `┊`
    // (LIGHT QUADRUPLE DASH VERTICAL, U+250A) is reserved for genuine
    // truncation discontinuities : (a) body starts mid-source (Read with
    // `offset > 0`, info.startLine > 0), or (b) tail elided before the
    // footer at the bottom of the block. Bash stdout always starts at
    // the first byte the child writes, so the top-of-body separator is
    // the solid `│`.
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
              input: { command: "echo body-line" },
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
    const agent = new Agent({
      auth: { type: "api-key", token: "t" } as AuthResult,
      model: "test",
      sendFn,
    })
    const lines: string[] = []
    const gen = agent.run("go", {
      onTranscriptLine: (line: string) => lines.push(stripAnsi(line)),
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Connector row should be a bare `│` (with leading indent), sitting
    // immediately after the `╭ <header>` line.
    const headerIdx = lines.findIndex((l) => l.includes("╭"))
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    const connector = lines[headerIdx + 1]
    expect(connector).toMatch(/^\s*│\s*$/)
    // Negative check: no bare `┊` row anywhere in the block. Bash output
    // never start-truncates, and this short single-line run also doesn't
    // tail-elide, so the only `┊`-eligible spots stay dormant.
    const bareDot = lines.find((l) => /^\s*┊\s*$/.test(l))
    expect(bareDot).toBeUndefined()
  }, 10_000)
})

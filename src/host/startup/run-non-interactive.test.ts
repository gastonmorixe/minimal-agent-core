/**
 * Unit tests for the non-interactive output router
 * (`src/host/startup/run-non-interactive.ts`), focused on the Phase-2b
 * structured event-stream route (`--output-format json` / `stream-json`).
 *
 * The event-stream path drives a real {@link AgentCore} (built by the injected
 * factory, mirroring the frozen `buildAgentCore(deps)` seam) whose
 * {@link JsonlEventSink} serializes each {@link AgentEvent} to one JSONL line.
 * These tests assert:
 *   - json / stream-json route through the injected core factory and emit the
 *     exact JSONL event sequence to the injected stdout (id-join intact);
 *   - stream-json flushes one write per event (live);
 *   - text does NOT take the event route (the factory is never built);
 *   - json WITHOUT a factory falls back to the legacy path (no regression);
 *   - json + `--output-schema` stays on the legacy buffered path.
 *
 * The G3 CLI-stdout gate (a real subprocess `--output-format json` run) lives
 * in `src/e2e/output-mode.e2e.test.ts`; this file pins the host wiring at the
 * unit level.
 *
 * @module host/startup/run-non-interactive.test
 */

import { describe, expect, it } from "bun:test"

import type { Agent } from "../../agent/agent.ts"
import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import { AgentCore } from "../../sdk/agent-core.ts"
import type { EventSink } from "../../sdk/events.ts"
import type { ToolExecResult, ToolExecutor, ToolRegistry, TranscriptSink } from "../../sdk/ports.ts"

import {
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "./run-non-interactive.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const EMPTY_REGISTRY: ToolRegistry = { list: () => [] }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "", isError: false }
  }
}

class DiscardTranscript implements TranscriptSink {
  write(): void {}
}

/**
 * Build a real AgentCore that emits a single text turn `text` and routes its
 * events through `eventSink`. Mirrors the minimal config the frozen
 * `events-jsonl.integration.test.ts` uses. When `chunks` are given the sendFn
 * yields them in order (to exercise the delta path); otherwise it yields `text`.
 */
function makeCore(eventSink: EventSink, text: string, chunks?: string[]): AgentCore {
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    for (const c of chunks ?? [text]) yield c
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as StreamedResponse
  }
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: new StubExecutor(),
    transcriptSink: new DiscardTranscript(),
    sendFn,
    eventSink,
  })
}

/** An Agent whose `run` throws if called — proves the legacy path was skipped. */
function neverAgent(): Agent {
  return {
    run(): never {
      throw new Error("legacy Agent.run must not be called on the event-stream route")
    },
  } as unknown as Agent
}

/** A fake Agent that records `run` calls and yields the given chunks. */
function recordingAgent(chunks: string[]): { agent: Agent; calls: () => number } {
  let n = 0
  const agent = {
    run(_prompt: string): AsyncGenerator<string, StreamedResponse, undefined> {
      n++
      return (async function* () {
        for (const c of chunks) yield c
        return {
          blocks: [{ type: "text" as const, text: chunks.join("") }],
          text: chunks.join(""),
          stopReason: "end_turn",
        } as StreamedResponse
      })()
    },
  } as unknown as Agent
  return { agent, calls: () => n }
}

/** Run `fn` with `process.stdout.write` captured; returns the captured text. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const orig = process.stdout.write.bind(process.stdout)
  let buf = ""
  ;(process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    buf += String(c)
    return true
  }
  try {
    await fn()
  } finally {
    ;(process.stdout as unknown as { write: typeof orig }).write = orig
  }
  return buf
}

function baseInput(over: Partial<RunNonInteractivePromptInput>): RunNonInteractivePromptInput {
  return {
    agent: neverAgent(),
    prompt: "go",
    formatterCmd: undefined,
    showHeader: false,
    wantJsonOutput: false,
    outputSchema: undefined,
    loader: null,
    cwd: process.cwd(),
    ...over,
  }
}

describe("runNonInteractivePrompt — structured event-stream route", () => {
  it("json: builds the core and emits the exact JSONL event sequence to stdout", async () => {
    const out: string[] = []
    let built = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        buildCore: (sink) => {
          built++
          return makeCore(sink, "hi")
        },
        stdout: (s) => out.push(s),
      }),
    )

    expect(built).toBe(1)
    const events = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    expect(events).toEqual([
      { type: "turn_started", turn: 1 },
      { type: "item_started", itemType: "text", id: "1:0" },
      { type: "item_completed", itemType: "text", id: "1:0", text: "hi" },
      {
        type: "turn_completed",
        turn: 1,
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ])
  })

  it("json: awaits an async core factory (real buildAgentCore returns a Promise)", async () => {
    const out: string[] = []
    let built = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        // Mirror the real seam: buildAgentCore(deps) is async.
        buildCore: async (sink) => {
          built++
          await Promise.resolve()
          return makeCore(sink, "hi")
        },
        stdout: (s) => out.push(s),
      }),
    )
    expect(built).toBe(1)
    const events = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    expect(events[0]).toEqual({ type: "turn_started", turn: 1 })
    expect(events.at(-1)?.type).toBe("turn_completed")
  })

  it("stream-json: routes to the event stream and flushes one write per event", async () => {
    const out: string[] = []
    let built = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        buildCore: (sink) => {
          built++
          return makeCore(sink, "yo")
        },
        stdout: (s) => out.push(s),
      }),
    )

    expect(built).toBe(1)
    // One write per event (live flush), each a complete JSONL line. stream-json
    // includes the realtime text_delta, so a single-chunk "yo" turn produces:
    // turn_started, text_delta, item_started, item_completed, turn_completed.
    expect(out.length).toBe(5)
    expect(out.every((l) => l.endsWith("\n"))).toBe(true)
    const events = out.map((l) => JSON.parse(l))
    expect(events[0]).toEqual({ type: "turn_started", turn: 1 })
    expect(events.some((e) => e.type === "text_delta")).toBe(true)
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    })
  })

  it("stream-json: emits text_delta events live (realtime deltas opted in)", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        buildCore: (sink) => makeCore(sink, "hello", ["he", "llo"]),
        stdout: (s) => out.push(s),
      }),
    )
    const events = out.map((l) => JSON.parse(l))
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.map((d) => d.text).join("")).toBe("hello")
  })

  it("json: does NOT emit text_delta events (buffered; deltas stay off)", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        buildCore: (sink) => makeCore(sink, "hello", ["he", "llo"]),
        stdout: (s) => out.push(s),
      }),
    )
    const events = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    expect(events.some((e) => e.type === "text_delta")).toBe(false)
    // The buffered json stream is exactly the Phase-2 turn/item shape.
    expect(events.map((e) => e.type)).toEqual([
      "turn_started",
      "item_started",
      "item_completed",
      "turn_completed",
    ])
  })

  it("text: does NOT take the event route (factory never built, legacy Agent runs)", async () => {
    let built = 0
    const rec = recordingAgent([])
    const captured = await captureStdout(() =>
      runNonInteractivePrompt(
        baseInput({
          agent: rec.agent,
          outputFormat: "text",
          buildCore: () => {
            built++
            return makeCore(new NoopSink(), "x")
          },
        }),
      ),
    )
    expect(built).toBe(0)
    expect(rec.calls()).toBe(1)
    // Legacy text path with no header + empty output writes just the trailing newline.
    expect(captured).toBe("\n")
  })

  it("json without a factory: falls back to the legacy path (no regression)", async () => {
    const rec = recordingAgent(["the answer"])
    const captured = await captureStdout(() =>
      runNonInteractivePrompt(
        baseInput({
          agent: rec.agent,
          outputFormat: "json",
          wantJsonOutput: true,
          // buildCore intentionally omitted.
        }),
      ),
    )
    expect(rec.calls()).toBe(1)
    // Legacy --json emits the final answer as one item_completed JSONL line.
    const lines = captured
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
    const last = JSON.parse(lines[lines.length - 1] as string)
    expect(last.type).toBe("item_completed")
    expect(last.text).toContain("the answer")
  })

  it("json + --output-schema: stays on the legacy buffered path (factory not built)", async () => {
    let built = 0
    const rec = recordingAgent(['{"answer":"ok"}'])
    const schema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    }
    let exitCode: number | undefined
    await captureStdout(() =>
      runNonInteractivePrompt(
        baseInput({
          agent: rec.agent,
          outputFormat: "json",
          outputSchema: schema,
          buildCore: () => {
            built++
            return makeCore(new NoopSink(), "x")
          },
          exit: ((code: number) => {
            exitCode = code
            throw new Error(`exit ${code}`)
          }) as (code: number) => never,
        }),
      ),
    )
    expect(built).toBe(0)
    expect(rec.calls()).toBe(1)
    // A conforming answer means no schema-failure exit.
    expect(exitCode).toBeUndefined()
  })
})

/** An EventSink that drops every event (used where the sink is irrelevant). */
class NoopSink implements EventSink {
  emit(): void {}
}

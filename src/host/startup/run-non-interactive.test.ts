/**
 * Unit tests for the non-interactive output router
 * (`src/host/startup/run-non-interactive.ts`), focused on the Phase-2b
 * structured event-stream route (`--output-format json` / `stream-json`).
 *
 * The event-stream path drives a real `Session` (built by the injected
 * factory, mirroring the `openAgentCoreSession(deps)` seam over
 * `createRuntime`/`openSession`) and serializes each kept `SessionEntry`
 * to one JSONL line, in the same wire format `JsonlEventSink` produces.
 * These tests assert:
 *   - json / stream-json route through the injected session factory and emit
 *     the exact JSONL event sequence to the injected stdout (id-join intact);
 *   - stream-json flushes one write per event (live);
 *   - text does NOT take the event route (the factory is never opened);
 *   - json WITHOUT a factory falls back to the legacy path (no regression);
 *   - json + `--output-schema` stays on the legacy buffered path.
 *
 * The G3 CLI-stdout gate (a real subprocess `--output-format json` run) lives
 * in `src/e2e/output-format-g3.e2e.test.ts`; this file pins the host wiring
 * at the unit level.
 *
 * @module host/startup/run-non-interactive.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import { createRuntime } from "../../runtime/runtime.ts"
import type { Session } from "../../runtime/session.ts"
import type {
  ToolDefinition,
  ToolExecResult,
  ToolExecutor,
  ToolRegistry,
  TranscriptSink,
} from "../../sdk/ports.ts"
import type { ReplAgentLike } from "../repl.ts"

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
 * Open a real `Session` that emits a single text turn `text`. Mirrors the
 * minimal config the frozen `events-jsonl.integration.test.ts` uses. When
 * `chunks` are given the sendFn yields them in order (to exercise the delta
 * path); otherwise it yields `text`.
 */
function openSession(text: string, chunks?: string[]): Session {
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    for (const c of chunks ?? [text]) yield c
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    } as StreamedResponse
  }
  return createRuntime().openSession({
    auth: AUTH,
    model: "test-model",
    toolRegistry: EMPTY_REGISTRY,
    toolExecutor: new StubExecutor(),
    transcriptSink: new DiscardTranscript(),
    sendFn,
  })
}

/** A ReplAgentLike whose `run` throws if called — proves the legacy path was skipped. */
function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy-path agent.run must not be called on the event-stream route")
    },
  } as unknown as ReplAgentLike
}

/** A fake ReplAgentLike that records `run` calls and yields the given chunks. */
function recordingAgent(chunks: string[]): { agent: ReplAgentLike; calls: () => number } {
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
  } as unknown as ReplAgentLike
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

/** Parse the JSONL chunks written so far into event objects. */
function parseLines(out: readonly string[]): unknown[] {
  return out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
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

describe("runNonInteractivePrompt — structured route fatal error", () => {
  it("emits the error event with code/hint and exits 1", async () => {
    const out: string[] = []
    const exits: number[] = []
    // biome-ignore lint/correctness/useYield: throws before the first chunk
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw Object.assign(new Error("needs login"), { code: "p.login", hint: "run: login" })
    }
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        openEventStreamSession: () =>
          Promise.resolve(
            createRuntime().openSession({
              auth: AUTH,
              model: "test-model",
              toolRegistry: EMPTY_REGISTRY,
              toolExecutor: new StubExecutor(),
              transcriptSink: new DiscardTranscript(),
              sendFn,
            }),
          ),
        stdout: (s) => out.push(s),
        exit: ((code: number) => {
          exits.push(code)
        }) as (code: number) => never,
      }),
    )
    const events = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    // stream-json closes with run_finished. The error event comes just before it.
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "failed" })
    expect(events.at(-2)).toEqual({
      type: "error",
      message: "needs login",
      code: "p.login",
      hint: "run: login",
    })
    expect(exits).toEqual([1])
  })

  it("stream-json fatal error: run_finished failed is on stdout before exit is called", async () => {
    const out: string[] = []
    // Snapshot of the stdout lines at the moment exit is called.
    const atExit: unknown[][] = []
    // biome-ignore lint/correctness/useYield: throws before the first chunk
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw Object.assign(new Error("needs login"), { code: "p.login", hint: "run: login" })
    }
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        openEventStreamSession: () =>
          Promise.resolve(
            createRuntime().openSession({
              auth: AUTH,
              model: "test-model",
              toolRegistry: EMPTY_REGISTRY,
              toolExecutor: new StubExecutor(),
              transcriptSink: new DiscardTranscript(),
              sendFn,
            }),
          ),
        stdout: (s) => out.push(s),
        exit: ((_code: number) => {
          atExit.push(parseLines(out))
        }) as (code: number) => never,
      }),
    )
    expect(atExit.length).toBe(1)
    const snap = atExit[0] as Array<Record<string, unknown>>
    expect(snap.at(-1)).toEqual({ type: "run_finished", outcome: "failed" })
    expect(snap.at(-2)?.type).toBe("error")
  })

  it("stream-json waiting run: run_finished waiting is on stdout before exit is called", async () => {
    const out: string[] = []
    const atExit: unknown[][] = []
    const exits: number[] = []
    // A permanent error pauses the run (outcome waiting), it does not throw.
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw Object.assign(new Error("fatal upstream failure"), { errorClass: "permanent" })
    }
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        openEventStreamSession: () =>
          Promise.resolve(
            createRuntime().openSession({
              auth: AUTH,
              model: "test-model",
              toolRegistry: EMPTY_REGISTRY,
              toolExecutor: new StubExecutor(),
              transcriptSink: new DiscardTranscript(),
              sendFn,
            }),
          ),
        stdout: (s) => out.push(s),
        exit: ((code: number) => {
          exits.push(code)
          atExit.push(parseLines(out))
        }) as (code: number) => never,
      }),
    )
    expect(exits).toEqual([1])
    const snap = atExit[0] as Array<Record<string, unknown>>
    expect(snap.at(-1)).toEqual({ type: "run_finished", outcome: "waiting" })
    expect(snap.some((e) => e.type === "error")).toBe(true)
  })
})

describe("runNonInteractivePrompt — run_finished closing line", () => {
  it("stream-json success: the last line is run_finished completed, after turn_completed", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        openEventStreamSession: () => Promise.resolve(openSession("hi")),
        stdout: (s) => out.push(s),
      }),
    )
    const events = parseLines(out) as Array<Record<string, unknown>>
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "completed" })
    expect(events.at(-2)?.type).toBe("turn_completed")
  })

  it("json success: no run_finished line (the json route stays on the frozen nine)", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        openEventStreamSession: () => Promise.resolve(openSession("hi")),
        stdout: (s) => out.push(s),
      }),
    )
    const events = parseLines(out) as Array<Record<string, unknown>>
    expect(events.some((e) => e.type === "run_finished")).toBe(false)
    expect(events.at(-1)?.type).toBe("turn_completed")
  })
})

describe("runNonInteractivePrompt — structured event-stream route", () => {
  it("json: opens the session and emits the exact JSONL event sequence to stdout", async () => {
    const out: string[] = []
    let opened = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        openEventStreamSession: () => {
          opened++
          return Promise.resolve(openSession("hi"))
        },
        stdout: (s) => out.push(s),
      }),
    )

    expect(opened).toBe(1)
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

  it("json: awaits an async session factory (real openAgentCoreSession returns a Promise)", async () => {
    const out: string[] = []
    let opened = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        // Mirror the real seam: openAgentCoreSession(deps) is async.
        openEventStreamSession: async () => {
          opened++
          await Promise.resolve()
          return openSession("hi")
        },
        stdout: (s) => out.push(s),
      }),
    )
    expect(opened).toBe(1)
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
    let opened = 0
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        openEventStreamSession: () => {
          opened++
          return Promise.resolve(openSession("yo"))
        },
        stdout: (s) => out.push(s),
      }),
    )

    expect(opened).toBe(1)
    // One write per event (live flush), each a complete JSONL line. stream-json
    // includes the realtime text_delta, so a single-chunk "yo" turn produces:
    // turn_started, text_delta, item_started, item_completed, turn_completed,
    // and the closing run_finished line.
    expect(out.length).toBe(6)
    expect(out.every((l) => l.endsWith("\n"))).toBe(true)
    const events = out.map((l) => JSON.parse(l))
    expect(events[0]).toEqual({ type: "turn_started", turn: 1 })
    expect(events.some((e) => e.type === "text_delta")).toBe(true)
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "completed" })
    expect(events.at(-2)).toEqual({
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
        openEventStreamSession: () => Promise.resolve(openSession("hello", ["he", "llo"])),
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
        openEventStreamSession: () => Promise.resolve(openSession("hello", ["he", "llo"])),
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

  it("json: a tool-calling turn preserves the id-join and leaves out tool_output (opt-in only)", async () => {
    // Session's own event log always captures EVERY AgentEvent kind,
    // including the opt-in tool_output (ALL_EVENT_KINDS, agent E's S48
    // complete-trace design) -- this exercises that the route's own
    // subscription-boundary filter still keeps the wire down to
    // LEGACY_EVENT_KINDS, same as JsonlEventSink's default always did.
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "call-xyz", name: "DoThing", input: {} }],
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
    const toolRegistry: ToolRegistry = {
      list: (): ToolDefinition[] => [{ name: "DoThing", description: "d", input_schema: {} }],
    }
    const toolExecutor: ToolExecutor = {
      async execute(): Promise<ToolExecResult> {
        return { content: "tool output text", isError: false }
      },
    }
    const session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      toolRegistry,
      toolExecutor,
      transcriptSink: new DiscardTranscript(),
      sendFn,
    })
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        openEventStreamSession: () => Promise.resolve(session),
        stdout: (s) => out.push(s),
      }),
    )
    const events = out
      .join("")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l))
    // The frozen wire format never carries tool_output (opt-in, kept out of
    // LEGACY_EVENT_KINDS) even though the session's own log captured it.
    expect(events.some((e) => e.type === "tool_output")).toBe(false)
    const toolStart = events.find((e) => e.type === "item_started" && e.itemType === "tool_use")
    const toolResult = events.find((e) => e.type === "tool_result")
    expect(toolStart).toBeDefined()
    expect(toolResult).toBeDefined()
    expect(toolResult?.id).toBe("call-xyz")
    expect(toolResult?.id).toBe(toolStart?.id)
    expect(toolResult?.name).toBe("DoThing")
    expect(toolResult?.isError).toBe(false)
    expect(events.at(-1)?.type).toBe("turn_completed")
  })

  it("text: does NOT take the event route (factory never opened, legacy-path agent runs)", async () => {
    let opened = 0
    const rec = recordingAgent([])
    const captured = await captureStdout(() =>
      runNonInteractivePrompt(
        baseInput({
          agent: rec.agent,
          outputFormat: "text",
          openEventStreamSession: () => {
            opened++
            return Promise.resolve(openSession("x"))
          },
        }),
      ),
    )
    expect(opened).toBe(0)
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
          // openEventStreamSession intentionally omitted.
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

  it("json + --output-schema: stays on the legacy buffered path (factory not opened)", async () => {
    let opened = 0
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
          openEventStreamSession: () => {
            opened++
            return Promise.resolve(openSession("x"))
          },
          exit: ((code: number) => {
            exitCode = code
            throw new Error(`exit ${code}`)
          }) as (code: number) => never,
        }),
      ),
    )
    expect(opened).toBe(0)
    expect(rec.calls()).toBe(1)
    // A conforming answer means no schema-failure exit.
    expect(exitCode).toBeUndefined()
  })
})

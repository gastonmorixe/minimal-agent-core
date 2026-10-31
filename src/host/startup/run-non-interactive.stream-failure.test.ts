/**
 * Tests for the stream-json failure lines on the non-interactive route. A
 * failure after argv parse must still end stdout with an `error` line and a
 * `run_finished` line with outcome `failed`. The json and text routes and
 * the stderr text do not change.
 *
 * @module host/startup/run-non-interactive.stream-failure.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import { createRuntime } from "../../runtime/runtime.ts"
import type { Session } from "../../runtime/session.ts"
import type { ToolExecResult, ToolExecutor, ToolRegistry, TranscriptSink } from "../../sdk/ports.ts"
import type { ReplAgentLike } from "../repl.ts"

import {
  type RunNonInteractivePromptInput,
  runNonInteractivePrompt,
} from "./run-non-interactive.ts"
import {
  resetStreamJsonWriterForTests,
  setStreamJsonWrite,
  writeStreamJsonFailure,
} from "./stream-json-writer.ts"

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

/** Open a real `Session` that answers with one text turn. */
function openSession(text: string, id: string): Session {
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    yield text
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
    id,
  })
}

/** A ReplAgentLike whose `run` throws. It proves the legacy path did not run. */
function neverAgent(): ReplAgentLike {
  return {
    run(): never {
      throw new Error("legacy-path agent.run must not be called")
    },
  } as unknown as ReplAgentLike
}

/** Run `fn` with `process.stdout.write` captured. Returns the captured text. */
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

/** Parse the JSONL chunks written so far into objects. */
function parseLines(out: readonly string[]): unknown[] {
  return out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

/** Drop the stream-json envelope keys so a test can compare the event part. */
function eventPart(line: unknown): Record<string, unknown> {
  const { sessionId: _s, seq: _q, ts: _t, ...rest } = (line ?? {}) as Record<string, unknown>
  return rest
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

// The stream-json writer is a process-wide singleton. Each test starts clean.
beforeEach(() => resetStreamJsonWriterForTests())

/** A plugin loader whose `turn.willStart` chain halts the prompt. */
function haltingLoader(): NonNullable<RunNonInteractivePromptInput["loader"]> {
  return {
    hooks: () => ({
      emitChain: async <T>(_name: string, payload: T) => ({ payload, halted: true }),
    }),
  } as unknown as NonNullable<RunNonInteractivePromptInput["loader"]>
}

/** Run `fn` with `process.stderr.write` captured. Returns the captured text. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const orig = process.stderr.write.bind(process.stderr)
  let buf = ""
  ;(process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
    buf += String(c)
    return true
  }
  try {
    await fn()
  } finally {
    ;(process.stderr as unknown as { write: typeof orig }).write = orig
  }
  return buf
}

describe("runNonInteractivePrompt: stream-json failure lines", () => {
  const STREAM_INFO = { sessionId: "sid-f", model: "test-model", cwd: "/work" }

  it("openSession rejects, then main().catch writes the failure: session_started, error, run_finished", async () => {
    const out: string[] = []
    const err = new Error("open failed")
    const run = runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        streamInfo: STREAM_INFO,
        openEventStreamSession: () => Promise.reject(err),
        stdout: (s) => out.push(s),
      }),
    )
    await expect(run).rejects.toThrow("open failed")
    // What main().catch does with the same error.
    writeStreamJsonFailure(err, { sessionId: "sid-f", streamInfo: STREAM_INFO })
    const lines = parseLines(out) as Array<Record<string, unknown>>
    expect(lines.length).toBe(3)
    expect(lines.map((l) => l.type)).toEqual(["session_started", "error", "run_finished"])
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2])
    expect(lines[1]?.message).toBe("open failed")
    expect(lines[2]?.outcome).toBe("failed")
    for (const l of lines) expect(l.sessionId).toBe("sid-f")
  })

  it("turn.willStart halt on stream-json: error then run_finished failed, exit 1, same stderr", async () => {
    const out: string[] = []
    const exits: number[] = []
    const stderr = await captureStderr(async () => {
      await runNonInteractivePrompt(
        baseInput({
          outputFormat: "stream-json",
          streamInfo: STREAM_INFO,
          loader: haltingLoader(),
          openEventStreamSession: () => Promise.reject(new Error("must not open")),
          stdout: (s) => out.push(s),
          exit: ((code: number) => {
            exits.push(code)
            throw new Error(`exit ${code}`)
          }) as (code: number) => never,
        }),
      ).catch(() => {})
    })
    expect(exits).toEqual([1])
    expect(stderr).toBe("turn.willStart: prompt blocked by lifecycle policy hook.\n")
    const lines = parseLines(out) as Array<Record<string, unknown>>
    expect(lines.map((l) => l.type)).toEqual(["session_started", "error", "run_finished"])
    expect(lines.map((l) => l.seq)).toEqual([0, 1, 2])
    expect(lines[1]).toMatchObject({
      message: "turn.willStart: prompt blocked by lifecycle policy hook.",
      code: "turn.blocked",
    })
    expect(lines[2]?.outcome).toBe("failed")
  })

  it("turn.willStart halt on stream-json without streamInfo: exactly error then run_finished", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        loader: haltingLoader(),
        openEventStreamSession: () => Promise.reject(new Error("must not open")),
        stdout: (s) => out.push(s),
        exit: ((code: number) => {
          throw new Error(`exit ${code}`)
        }) as (code: number) => never,
      }),
    ).catch(() => {})
    const lines = parseLines(out) as Array<Record<string, unknown>>
    expect(lines.map((l) => [l.type, l.seq])).toEqual([
      ["error", 0],
      ["run_finished", 1],
    ])
  })

  for (const fmt of ["json", "text"] as const) {
    it(`turn.willStart halt on ${fmt}: nothing on stdout, exit 1, same stderr`, async () => {
      const out: string[] = []
      const exits: number[] = []
      let captured = ""
      const stderr = await captureStderr(async () => {
        captured = await captureStdout(async () => {
          await runNonInteractivePrompt(
            baseInput({
              outputFormat: fmt,
              streamInfo: STREAM_INFO,
              loader: haltingLoader(),
              stdout: (s) => out.push(s),
              exit: ((code: number) => {
                exits.push(code)
                throw new Error(`exit ${code}`)
              }) as (code: number) => never,
            }),
          ).catch(() => {})
        })
      })
      expect(exits).toEqual([1])
      expect(stderr).toBe("turn.willStart: prompt blocked by lifecycle policy hook.\n")
      expect(out).toEqual([])
      expect(captured).toBe("")
    })
  }

  it("json route does not use the writer: a later failure starts at seq 0", async () => {
    const out: string[] = []
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "json",
        streamInfo: STREAM_INFO,
        openEventStreamSession: () => Promise.resolve(openSession("hi", "sid-f")),
        stdout: (s) => out.push(s),
      }),
    )
    for (const l of parseLines(out) as Array<Record<string, unknown>>) {
      expect("seq" in l).toBe(false)
    }
    // The writer state is untouched: no seq used, no flags set.
    const probe: string[] = []
    setStreamJsonWrite((s) => probe.push(s))
    writeStreamJsonFailure(new Error("x"), { sessionId: "sid-f" })
    expect((parseLines(probe) as Array<Record<string, unknown>>).map((l) => l.seq)).toEqual([0, 1])
  })

  it("failure inside session.run: a later writeStreamJsonFailure adds no lines", async () => {
    const out: string[] = []
    const err = Object.assign(new Error("needs login"), { code: "p.login" })
    // biome-ignore lint/correctness/useYield: throws before the first chunk
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw err
    }
    await runNonInteractivePrompt(
      baseInput({
        outputFormat: "stream-json",
        streamInfo: STREAM_INFO,
        openEventStreamSession: () =>
          Promise.resolve(
            createRuntime().openSession({
              auth: AUTH,
              model: "test-model",
              toolRegistry: EMPTY_REGISTRY,
              toolExecutor: new StubExecutor(),
              transcriptSink: new DiscardTranscript(),
              sendFn,
              id: "sid-f",
            }),
          ),
        stdout: (s) => out.push(s),
        exit: (() => undefined) as unknown as (code: number) => never,
      }),
    )
    const before = parseLines(out).length
    writeStreamJsonFailure(err, { sessionId: "sid-f", streamInfo: STREAM_INFO })
    const lines = parseLines(out) as Array<Record<string, unknown>>
    expect(lines.length).toBe(before)
    expect(eventPart(lines.at(-1))).toEqual({ type: "run_finished", outcome: "failed" })
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i))
  })
})

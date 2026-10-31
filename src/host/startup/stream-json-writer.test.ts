/**
 * Unit tests for the stream-json stdout writer. They check the seq counter,
 * the once-only `session_started` line, and the failure lines.
 *
 * @module host/startup/stream-json-writer.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import {
  resetStreamJsonWriterForTests,
  sessionStartedLine,
  setStreamJsonWrite,
  writeStreamJsonEvent,
  writeStreamJsonFailure,
  writeStreamJsonSessionStarted,
} from "./stream-json-writer.ts"

const INFO = { sessionId: "sid-w", model: "m", cwd: "/work" }

let out: string[] = []

function lines(): Array<Record<string, unknown>> {
  return out
    .join("")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

beforeEach(() => {
  resetStreamJsonWriterForTests()
  out = []
  setStreamJsonWrite((s) => out.push(s))
})

describe("writeStreamJsonFailure", () => {
  it("no prior line and no streamInfo: error seq 0, then run_finished failed seq 1", () => {
    writeStreamJsonFailure(Object.assign(new Error("boom"), { code: "x.y" }), {
      sessionId: "sid-w",
    })
    const got = lines()
    expect(got.map((l) => [l.type, l.seq, l.sessionId])).toEqual([
      ["error", 0, "sid-w"],
      ["run_finished", 1, "sid-w"],
    ])
    expect(got[0]).toMatchObject({ message: "boom", code: "x.y" })
    expect(got[1]?.outcome).toBe("failed")
    expect(typeof got[1]?.ts).toBe("number")
  })

  it("streamInfo and nothing written: session_started 0, error 1, run_finished 2", () => {
    writeStreamJsonFailure(new Error("boom"), { sessionId: "sid-w", streamInfo: INFO })
    expect(lines().map((l) => [l.type, l.seq])).toEqual([
      ["session_started", 0],
      ["error", 1],
      ["run_finished", 2],
    ])
  })

  it("after session_started: error 1, run_finished 2, no second session_started", () => {
    writeStreamJsonSessionStarted(INFO)
    writeStreamJsonFailure(new Error("boom"), { sessionId: "sid-w", streamInfo: INFO })
    expect(lines().map((l) => [l.type, l.seq])).toEqual([
      ["session_started", 0],
      ["error", 1],
      ["run_finished", 2],
    ])
  })

  it("after run_finished: writes nothing more", () => {
    writeStreamJsonEvent({ type: "run_finished", outcome: "failed" }, { sessionId: "s", ts: 1 })
    writeStreamJsonFailure(new Error("boom"), { sessionId: "s", streamInfo: INFO })
    expect(lines().map((l) => l.type)).toEqual(["run_finished"])
  })

  it("an abort: no error line, run_finished aborted (same as AgentCore.run)", () => {
    const abort = Object.assign(new Error("stop"), { name: "AbortError" })
    writeStreamJsonFailure(abort, { sessionId: "s" })
    const got = lines()
    expect(got.map((l) => l.type)).toEqual(["run_finished"])
    expect(got[0]?.outcome).toBe("aborted")
  })

  it("a non-Error throw: the message is its string form", () => {
    writeStreamJsonFailure("plain", { sessionId: "s" })
    expect(lines()[0]).toMatchObject({ type: "error", message: "plain" })
  })
})

describe("sessionStartedLine", () => {
  it("puts resumedFrom right after sessionId, null when unset", () => {
    const line = sessionStartedLine(INFO)
    expect(Object.keys(line)).toEqual([
      "type",
      "streamVersion",
      "sessionId",
      "resumedFrom",
      "model",
      "provider",
      "effort",
      "cwd",
      "version",
      "outputFormat",
    ])
    expect(line.resumedFrom).toBeNull()
  })

  it("resumedFrom given: the line carries the string", () => {
    expect(sessionStartedLine({ ...INFO, resumedFrom: "sid-src" }).resumedFrom).toBe("sid-src")
  })
})

describe("resetStreamJsonWriterForTests", () => {
  it("clears seq and both flags", () => {
    writeStreamJsonSessionStarted(INFO)
    writeStreamJsonEvent({ type: "run_finished", outcome: "completed" }, { sessionId: "s", ts: 1 })
    resetStreamJsonWriterForTests()
    out = []
    setStreamJsonWrite((s) => out.push(s))
    writeStreamJsonFailure(new Error("boom"), { sessionId: "sid-w", streamInfo: INFO })
    expect(lines().map((l) => [l.type, l.seq])).toEqual([
      ["session_started", 0],
      ["error", 1],
      ["run_finished", 2],
    ])
  })
})

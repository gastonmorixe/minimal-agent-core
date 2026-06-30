/**
 * Tests for the Phase 4 non-interactive output adapter (host shell).
 *
 * Verifies the stream-routing decisions against the frozen 6-variant
 * AgentEvent schema in src/sdk/events.ts: json → JSONL on stdout, human →
 * progress on stderr + final answer on stdout (only when stdout is not a TTY).
 */
import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "../sdk/events.ts"

import { enforceOutputSchema, PrintOutput, resolvePrintModeOptions } from "./print-output.ts"

/** A capturing WriteStream for assertions. */
function cap(isTTY = false) {
  const chunks: string[] = []
  return {
    isTTY,
    write(s: string) {
      chunks.push(s)
      return true
    },
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").filter(Boolean),
  }
}

const turnStarted: AgentEvent = { type: "turn_started", turn: 0 }
const toolResult: AgentEvent = { type: "tool_result", id: "t1", name: "Bash", isError: false }
const turnDone: AgentEvent = {
  type: "turn_completed",
  turn: 0,
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 5 },
}

describe("resolvePrintModeOptions", () => {
  test("--json wins regardless of TTY", () => {
    expect(resolvePrintModeOptions({ jsonFlag: true, stdoutIsTTY: true }).mode).toBe("json")
    expect(resolvePrintModeOptions({ jsonFlag: true, stdoutIsTTY: false }).mode).toBe("json")
  })
  test("no --json is human mode", () => {
    expect(resolvePrintModeOptions({ jsonFlag: false, stdoutIsTTY: false }).mode).toBe("human")
  })
  test("carries the output schema when present", () => {
    const schema = { type: "object" }
    expect(
      resolvePrintModeOptions({ jsonFlag: false, stdoutIsTTY: false, outputSchema: schema })
        .outputSchema,
    ).toBe(schema)
  })
})

describe("PrintOutput — json mode", () => {
  test("emits every event as a JSONL line on stdout, nothing on stderr", () => {
    const out = cap()
    const err = cap()
    const p = new PrintOutput({ mode: "json" }, { stdout: out, stderr: err })
    p.emit(turnStarted)
    p.emit(toolResult)
    p.emit(turnDone)
    expect(err.text()).toBe("")
    const lines = out.lines()
    expect(lines.length).toBe(3)
    expect(JSON.parse(lines[0])).toMatchObject({ type: "turn_started", turn: 0 })
    expect(JSON.parse(lines[1])).toMatchObject({ type: "tool_result", id: "t1", name: "Bash" })
  })

  test("finish writes a terminal item_completed event to stdout (even on a TTY)", () => {
    const out = cap(true)
    const err = cap()
    const p = new PrintOutput({ mode: "json" }, { stdout: out, stderr: err })
    p.finish("the answer")
    const lines = out.lines()
    expect(lines.length).toBe(1)
    const ev = JSON.parse(lines[0])
    expect(ev).toMatchObject({ type: "item_completed", itemType: "text", text: "the answer" })
  })
})

describe("PrintOutput — human mode", () => {
  test("routes progress lines to stderr, never stdout", () => {
    const out = cap()
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err })
    p.emit(turnStarted)
    p.emit(toolResult)
    expect(out.text()).toBe("")
    expect(err.text()).toContain("turn 0 started")
    expect(err.text()).toContain("Bash → ok")
  })

  test("skips empty progress renders (no blank stderr lines)", () => {
    const out = cap()
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err })
    // a completed text item renders empty in human mode
    p.emit({ type: "item_completed", itemType: "text", id: "x", text: "hi" })
    expect(err.text()).toBe("")
  })

  test("finish prints the final answer to stdout when stdout is NOT a TTY (piped)", () => {
    const out = cap(false)
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err, stdoutIsTTY: false })
    // formatFinalMessage strips only TRAILING whitespace (leading is preserved
    // so intentional indentation survives), then ensures one trailing newline.
    p.finish("final answer  \n\n")
    expect(out.text()).toBe("final answer\n")
  })

  test("finish suppresses the final answer when stdout IS a TTY (no double-print)", () => {
    const out = cap(true)
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err, stdoutIsTTY: true })
    p.finish("final answer")
    expect(out.text()).toBe("")
  })

  test("an empty final answer prints nothing", () => {
    const out = cap(false)
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err, stdoutIsTTY: false })
    p.finish("   \n")
    expect(out.text()).toBe("")
  })
})

describe("PrintOutput — stream isolation", () => {
  test("json mode writes NOTHING to stderr (stdout is the only machine stream)", () => {
    const out = cap()
    const err = cap()
    const p = new PrintOutput({ mode: "json" }, { stdout: out, stderr: err })
    p.emit(turnStarted)
    p.emit(toolResult)
    p.emit(turnDone)
    p.finish("answer")
    expect(err.text()).toBe("")
  })

  test("human mode writes NOTHING to stdout from progress (only the final answer)", () => {
    const out = cap(false)
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err, stdoutIsTTY: false })
    p.emit(turnStarted)
    p.emit(toolResult)
    p.emit(turnDone)
    // stdout still empty before finish: progress never leaks into the pipe
    expect(out.text()).toBe("")
  })

  test("finish is idempotent — a second call does not double-print", () => {
    const out = cap(false)
    const err = cap()
    const p = new PrintOutput({ mode: "human" }, { stdout: out, stderr: err, stdoutIsTTY: false })
    p.finish("answer")
    p.finish("answer")
    expect(out.text()).toBe("answer\n")
  })
})

describe("enforceOutputSchema — validate-and-exit decision", () => {
  const objSchema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }

  // e1: a conforming answer is accepted (host exits 0).
  test("valid JSON matching the schema → ok, no diagnostics", () => {
    const r = enforceOutputSchema('{"ok": true}', objSchema)
    expect(r.ok).toBe(true)
    expect(r.diagnostics).toEqual([])
  })

  // e2: well-formed JSON that violates the schema → reject (host exits 1).
  test("JSON that violates the schema → not ok, with diagnostics", () => {
    const r = enforceOutputSchema('{"ok": "not a boolean"}', objSchema)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.length).toBeGreaterThan(0)
    expect(r.diagnostics[0]).toContain("--output-schema")
  })

  // e3: a non-JSON answer when --output-schema is set → reject (host exits 1).
  test("non-JSON answer → not ok (the schema flag implies JSON output)", () => {
    const r = enforceOutputSchema("this is plain prose, not json", objSchema)
    expect(r.ok).toBe(false)
    expect(r.diagnostics.length).toBeGreaterThan(0)
  })

  // a bare scalar parses as JSON but fails an object schema → reject.
  test("bare scalar (parses, wrong type) → not ok", () => {
    const r = enforceOutputSchema("42", objSchema)
    expect(r.ok).toBe(false)
  })
})

describe("PrintOutput — schema passthrough", () => {
  test("schema() returns the carried output schema", () => {
    const schema = { type: "object", properties: {} }
    const p = new PrintOutput(
      { mode: "json", outputSchema: schema },
      { stdout: cap(), stderr: cap() },
    )
    expect(p.schema()).toBe(schema)
  })
  test("schema() is undefined when none was provided", () => {
    const p = new PrintOutput({ mode: "human" }, { stdout: cap(), stderr: cap() })
    expect(p.schema()).toBeUndefined()
  })
})

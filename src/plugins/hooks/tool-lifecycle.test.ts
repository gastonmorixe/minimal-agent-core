/**
 * Tests for the tool-lifecycle hook payload contract + its accumulator
 * helpers. This is the GENERIC seam any plugin can attach to (diagnostics
 * is the first consumer, but the shape is tool-agnostic).
 */
import { describe, expect, it } from "bun:test"

import { HookBus } from "./hook-bus.ts"
import {
  addFinding,
  addNote,
  type Finding,
  makeToolDidInvokePayload,
  type ToolDidInvokePayload,
} from "./tool-lifecycle.ts"

describe("makeToolDidInvokePayload", () => {
  it("seeds empty accumulators", () => {
    const p = makeToolDidInvokePayload({
      tool: "Edit",
      input: { file_path: "/x.ts" },
      cwd: "/repo",
      ok: true,
      filePath: "/x.ts",
    })
    expect(p.tool).toBe("Edit")
    expect(p.filePath).toBe("/x.ts")
    expect(p.ok).toBe(true)
    expect(p.findings).toEqual([])
    expect(p.notes).toEqual([])
  })
})

describe("addFinding / addNote", () => {
  it("appends a finding immutably-ish (mutates the array in place)", () => {
    const p = makeToolDidInvokePayload({ tool: "Write", input: {}, cwd: "/r", ok: true })
    const f: Finding = { source: "biome", severity: "error", message: "bad", line: 3, col: 1 }
    addFinding(p, f)
    expect(p.findings).toHaveLength(1)
    expect(p.findings[0]).toEqual(f)
  })

  it("ignores a malformed finding (missing message)", () => {
    const p = makeToolDidInvokePayload({ tool: "Write", input: {}, cwd: "/r", ok: true })
    addFinding(p, { source: "x", severity: "error", message: "" })
    expect(p.findings).toHaveLength(0)
  })

  it("appends a note string", () => {
    const p = makeToolDidInvokePayload({ tool: "Edit", input: {}, cwd: "/r", ok: true })
    addNote(p, "2 errors in foo.ts")
    expect(p.notes).toEqual(["2 errors in foo.ts"])
  })
})

describe("chain integration: a plugin-like listener augments the payload", () => {
  it("a chain listener can push findings and the emitter reads them back", async () => {
    const bus = new HookBus()
    bus.declare("tool.didInvoke", "chain")
    // simulate a plugin handler that adds a finding
    bus.on(
      "tool.didInvoke",
      (payload: ToolDidInvokePayload) => {
        addFinding(payload, {
          source: "tsgo",
          severity: "error",
          code: "TS2322",
          message: "Type 'string' is not assignable to type 'number'.",
          line: 12,
          col: 5,
        })
        addNote(payload, "1 type error")
        return { payload }
      },
      { source: "diagnostics", priority: 50 },
    )
    const seed = makeToolDidInvokePayload({
      tool: "Edit",
      input: { file_path: "/x.ts" },
      cwd: "/repo",
      ok: true,
      filePath: "/x.ts",
    })
    const res = await bus.emitChain("tool.didInvoke", seed)
    expect(res.halted).toBe(false)
    expect(res.payload.findings).toHaveLength(1)
    expect(res.payload.findings[0]?.code).toBe("TS2322")
    expect(res.payload.notes).toEqual(["1 type error"])
  })
})

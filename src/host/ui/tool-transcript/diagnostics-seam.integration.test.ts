/**
 * Integration test for the tool-lifecycle diagnostics SEAM, exercising the
 * exact data path the agent uses (without standing up a model/transport):
 *
 *   makeToolDidInvokePayload  →  Hooks.emitChain("tool.didInvoke")
 *     →  plugin-like chain listener pushes findings + notes
 *     →  renderFindingsPanel(findings)  +  formatDiagnosticsAnnotation(notes)
 *     →  formatToolPreview strips the annotation from the human view
 *
 * This is the contract the agent's private `runToolDidInvokeChain` relies on.
 */
import { describe, expect, it } from "bun:test"

import { Hooks } from "../../../plugins/hooks/hooks.ts"
import {
  addFinding,
  addNote,
  makeToolDidInvokePayload,
  type ToolDidInvokePayload,
} from "../../../plugins/hooks/tool-lifecycle.ts"

import { formatDiagnosticsAnnotation, formatToolPreview, renderFindingsPanel } from "./format.ts"

const noLog = () => {}
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("diagnostics seam end-to-end (no transport)", () => {
  it("a chain listener augments an Edit result; agent-side render + annotation work", async () => {
    const hooks = new Hooks({ logger: noLog })

    // Mimic the diagnostics plugin: subscribe on the chain, add findings+notes.
    hooks.on(
      "tool.didInvoke",
      (payload: ToolDidInvokePayload) => {
        if (payload.tool === "Edit" || payload.tool === "Write") {
          addFinding(payload, {
            source: "tsgo",
            severity: "error",
            code: "TS2322",
            message: "Type 'string' is not assignable to type 'number'.",
            line: 12,
            col: 5,
          })
          addNote(payload, "12:5 error TS2322 Type 'string' is not assignable to type 'number'.")
        }
        return { payload }
      },
      { caller: "plugin", source: "diagnostics", priority: 50 },
    )

    // Agent side: build payload, emit, read union back.
    const seed = makeToolDidInvokePayload({
      tool: "Edit",
      input: { file_path: "/repo/x.ts" },
      cwd: "/repo",
      ok: true,
      filePath: "/repo/x.ts",
    })
    const { payload } = await hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", seed)

    expect(payload.findings).toHaveLength(1)
    expect(payload.notes).toHaveLength(1)

    // Agent renders the panel (human) ...
    const panel = renderFindingsPanel(payload.findings).map(stripAnsi)
    expect(panel.some((l) => l.includes("12:5") && l.includes("TS2322"))).toBe(true)
    expect(panel.some((l) => /1 error/.test(l))).toBe(true)
    expect(panel.at(-1)?.startsWith("  ╰")).toBe(true)

    // ... and appends the annotation (model).
    const content =
      "File edited: /repo/x.ts (1 replacement(s))" + formatDiagnosticsAnnotation(payload.notes)
    expect(content).toContain("<ma::agent::diagnostics")

    // The annotation is invisible to the human preview.
    const preview = formatToolPreview(content, false, undefined, { tool: "Edit" })
      .map(stripAnsi)
      .join("\n")
    expect(preview).not.toContain("ma::agent::diagnostics")
    expect(preview).not.toContain("TS2322")
  })

  it("no subscriber → emit returns the seed untouched (empty accumulators)", async () => {
    const hooks = new Hooks({ logger: noLog })
    const seed = makeToolDidInvokePayload({ tool: "Edit", input: {}, cwd: "/r", ok: true })
    const { payload } = await hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", seed)
    expect(payload.findings).toEqual([])
    expect(payload.notes).toEqual([])
    expect(renderFindingsPanel(payload.findings)).toEqual([])
    expect(formatDiagnosticsAnnotation(payload.notes)).toBe("")
  })

  it("a throwing listener is absorbed; agent still gets a usable payload", async () => {
    const hooks = new Hooks({ logger: noLog })
    hooks.on(
      "tool.didInvoke",
      () => {
        throw new Error("plugin blew up")
      },
      { caller: "plugin", source: "bad", priority: 50 },
    )
    const seed = makeToolDidInvokePayload({ tool: "Write", input: {}, cwd: "/r", ok: true })
    const { payload } = await hooks.emitChain<ToolDidInvokePayload>("tool.didInvoke", seed)
    expect(payload.findings).toEqual([])
  })
})

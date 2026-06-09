/**
 * Tests for the agent-side diagnostics renderer. The AGENT owns the TUI:
 * it turns plugin-provided structured {@link Finding}s into transcript lines
 * (reusing the tool-block gutter + palette) and turns model-facing notes into
 * a `<ma::agent::diagnostics>` annotation that rides the tool_result content.
 *
 * Pure functions: no IO, no spawning. We assert structure + that the
 * annotation is stripped by the existing preview pipeline.
 */
import { describe, expect, it } from "bun:test"

import type { Finding } from "../plugins/hooks/tool-lifecycle.ts"

import {
  formatDiagnosticsAnnotation,
  formatToolPreview,
  renderFindingsPanel,
} from "./tool-format.ts"

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("renderFindingsPanel", () => {
  it("returns no lines for an empty findings list", () => {
    expect(renderFindingsPanel([])).toEqual([])
  })

  it("renders one row per finding with a closing summary", () => {
    const findings: Finding[] = [
      {
        source: "tsgo",
        severity: "error",
        code: "TS2322",
        message: "Type 'string' not assignable to 'number'.",
        line: 12,
        col: 5,
      },
      {
        source: "oxlint",
        severity: "warning",
        code: "no-unused-vars",
        message: "'x' is never used.",
        line: 7,
        col: 1,
      },
    ]
    const lines = renderFindingsPanel(findings).map(stripAnsi)
    // a row for each finding
    expect(lines.some((l) => l.includes("12:5") && l.includes("TS2322"))).toBe(true)
    expect(lines.some((l) => l.includes("7:1") && l.includes("no-unused-vars"))).toBe(true)
    // a summary line with counts
    expect(lines.some((l) => /1 error/.test(l) && /1 warning/.test(l))).toBe(true)
    // uses the tool-block gutter glyphs
    expect(lines.every((l) => /^\s{2}[│╰┊]/.test(l))).toBe(true)
  })

  it("caps the number of rendered rows and shows an overflow marker", () => {
    const many: Finding[] = Array.from({ length: 12 }, (_, i) => ({
      source: "tsgo",
      severity: "error" as const,
      code: `TS${1000 + i}`,
      message: `err ${i}`,
      line: i + 1,
      col: 1,
    }))
    const lines = renderFindingsPanel(many, { cols: 100, maxRows: 6 }).map(stripAnsi)
    // 6 detail rows + overflow + summary is far fewer than 12 rows
    expect(lines.filter((l) => /TS\d/.test(l)).length).toBe(6)
    expect(lines.some((l) => /\+6 more/.test(l))).toBe(true)
  })

  it("orders errors before warnings before info", () => {
    const findings: Finding[] = [
      { source: "a", severity: "info", message: "i", line: 1, col: 1 },
      { source: "b", severity: "error", message: "e", line: 2, col: 1 },
      { source: "c", severity: "warning", message: "w", line: 3, col: 1 },
    ]
    const lines = renderFindingsPanel(findings).map(stripAnsi)
    const detail = lines.filter((l) => /:\d/.test(l))
    // first detail row is the error
    expect(detail[0]).toContain("2:1")
  })
})

describe("formatDiagnosticsAnnotation", () => {
  it("returns empty string for no notes", () => {
    expect(formatDiagnosticsAnnotation([])).toBe("")
  })

  it("wraps notes in a <ma::agent::diagnostics> block", () => {
    const out = formatDiagnosticsAnnotation([
      "12:5 error TS2322 Type 'string' not assignable to 'number'.",
      "7:1 warning no-unused-vars 'x' is never used.",
    ])
    expect(out.startsWith("\n\n<ma::agent::diagnostics")).toBe(true)
    expect(out.includes("</ma::agent::diagnostics>")).toBe(true)
    expect(out).toContain("TS2322")
  })
})

describe("audience split: the annotation is stripped from the human preview", () => {
  it("formatToolPreview removes a trailing <ma::agent::diagnostics> block", () => {
    const body = "File edited: /x.ts (1 replacement(s))"
    const content = body + formatDiagnosticsAnnotation(["12:5 error TS2322 nope"])
    const lines = formatToolPreview(content, false, undefined, { tool: "Edit" }).map(stripAnsi)
    const joined = lines.join("\n")
    expect(joined).not.toContain("ma::agent::diagnostics")
    expect(joined).not.toContain("TS2322")
  })
})

/**
 * Tests for the model-facing note formatter + the finding filter (severity
 * floor, dedup, cap). Compact reporting keeps diagnostics from polluting the
 * model's context (severity allowlist + dedup + cap, per 2026 practice).
 */
import { describe, expect, it } from "bun:test"

import { filterFindings, formatNote } from "./format-notes.ts"
import type { Finding } from "./types.ts"

const f = (over: Partial<Finding>): Finding => ({
  source: "tsgo",
  severity: "error",
  message: "m",
  ...over,
})

describe("formatNote", () => {
  it("produces a compact `line:col severity code message` line", () => {
    expect(formatNote(f({ line: 12, col: 5, code: "TS2322", message: "bad type" }))).toBe(
      "12:5 error TS2322 bad type",
    )
  })

  it("omits the location when absent", () => {
    expect(formatNote(f({ code: "format", message: "not formatted", severity: "warning" }))).toBe(
      "warning format not formatted",
    )
  })

  it("omits the code when absent", () => {
    expect(formatNote(f({ line: 3, col: 1, message: "x" }))).toBe("3:1 error x")
  })

  it("prefixes [ad-hoc] for out-of-scope findings", () => {
    const finding = f({ line: 10, col: 3, code: "TS2532", message: "undefined", scope: "ad-hoc" })
    expect(formatNote(finding)).toBe("[ad-hoc] 10:3 error TS2532 undefined")
  })

  it("no prefix when scope is project", () => {
    expect(formatNote(f({ line: 1, col: 1, message: "err", scope: "project" }))).toBe(
      "1:1 error err",
    )
  })

  it("no prefix when scope is absent", () => {
    expect(formatNote(f({ line: 1, col: 1, message: "err" }))).toBe("1:1 error err")
  })
})

describe("filterFindings", () => {
  it("drops findings below the severity floor", () => {
    const findings = [
      f({ severity: "error", message: "e" }),
      f({ severity: "warning", message: "w" }),
      f({ severity: "info", message: "i" }),
    ]
    const out = filterFindings(findings, { severityFloor: "warning", max: 50 })
    expect(out.map((d) => d.severity)).toEqual(["error", "warning"])
  })

  it("dedups identical findings (same source/line/col/code/message)", () => {
    const dup = f({ line: 1, col: 1, code: "TS1", message: "same" })
    const out = filterFindings([dup, { ...dup }, dup], { severityFloor: "info", max: 50 })
    expect(out).toHaveLength(1)
  })

  it("caps the count, errors kept before warnings", () => {
    const findings = [
      f({ severity: "warning", message: "w1" }),
      f({ severity: "error", message: "e1" }),
      f({ severity: "warning", message: "w2" }),
      f({ severity: "error", message: "e2" }),
    ]
    const out = filterFindings(findings, { severityFloor: "info", max: 2 })
    expect(out).toHaveLength(2)
    expect(out.every((d) => d.severity === "error")).toBe(true)
  })

  it("treats severityFloor 'error' as errors-only", () => {
    const out = filterFindings([f({ severity: "error" }), f({ severity: "warning" })], {
      severityFloor: "error",
      max: 50,
    })
    expect(out).toHaveLength(1)
  })
})

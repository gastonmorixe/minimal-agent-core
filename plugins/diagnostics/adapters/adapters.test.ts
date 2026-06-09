/**
 * Tests for the per-tool JSON → {@link Finding}[] adapters (Adapter pattern).
 * Each tool emits a different JSON shape; the adapter normalizes it. We feed
 * REAL captured output shapes (see private research) so the parsing matches
 * production, with no spawning.
 */
import { describe, expect, it } from "bun:test"

import { adaptBiome } from "./biome.ts"
import { adaptLspDiagnostics } from "./lsp.ts"
import { adaptOxlint } from "./oxlint.ts"

describe("adaptOxlint", () => {
  it("maps oxlint diagnostics to Findings (code, severity, line/col)", () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          message: "`debugger` statement is not allowed",
          code: "eslint(no-debugger)",
          severity: "error",
          help: "Remove the debugger statement",
          filename: "src/x.ts",
          labels: [{ span: { offset: 53, length: 9, line: 3, column: 1 } }],
        },
        {
          message: "Variable 'unused' is declared but never used.",
          code: "eslint(no-unused-vars)",
          severity: "warning",
          filename: "src/x.ts",
          labels: [{ span: { line: 4, column: 7 } }],
        },
      ],
    })
    const out = adaptOxlint(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      source: "oxlint",
      severity: "error",
      code: "eslint(no-debugger)",
      line: 3,
      col: 1,
    })
    expect(out[1]?.severity).toBe("warning")
  })

  it("returns [] on empty diagnostics and on malformed JSON", () => {
    expect(adaptOxlint(JSON.stringify({ diagnostics: [] }))).toEqual([])
    expect(adaptOxlint("not json")).toEqual([])
    expect(adaptOxlint("")).toEqual([])
  })
})

describe("adaptBiome", () => {
  it("maps biome diagnostics to Findings (category, location.start)", () => {
    const raw = JSON.stringify({
      summary: { errors: 1, warnings: 0 },
      diagnostics: [
        {
          severity: "error",
          category: "assist/source/organizeImports",
          description: "The imports and exports are not sorted.",
          location: {
            path: "src/x.ts",
            start: { line: 5, column: 1 },
            end: { line: 5, column: 10 },
          },
        },
      ],
    })
    const out = adaptBiome(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      source: "biome",
      severity: "error",
      code: "assist/source/organizeImports",
      line: 5,
      col: 1,
    })
    expect(out[0]?.message.length).toBeGreaterThan(0)
  })

  it("handles biome message-as-array shape", () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          severity: "warning",
          category: "lint/suspicious/noExplicitAny",
          message: [{ content: "Unexpected " }, { content: "any." }],
          location: { path: "src/x.ts", start: { line: 8, column: 5 } },
        },
      ],
    })
    const out = adaptBiome(raw)
    expect(out[0]?.message).toBe("Unexpected any.")
    expect(out[0]?.severity).toBe("warning")
  })

  it("omits a whole-file 0:0 location (not a valid 1-based position)", () => {
    const raw = JSON.stringify({
      diagnostics: [
        {
          severity: "error",
          category: "format",
          message: "Formatter would have printed the following content:",
          location: {
            path: "src/x.ts",
            start: { line: 0, column: 0 },
            end: { line: 0, column: 0 },
          },
        },
      ],
    })
    const out = adaptBiome(raw)
    expect(out[0]?.line).toBeUndefined()
    expect(out[0]?.col).toBeUndefined()
    expect(out[0]?.code).toBe("format")
  })

  it("returns [] on malformed JSON", () => {
    expect(adaptBiome("garbage")).toEqual([])
    expect(adaptBiome("")).toEqual([])
  })
})

describe("adaptLspDiagnostics", () => {
  it("maps LSP Diagnostic[] (0-based range → 1-based line/col)", () => {
    const items = [
      {
        range: { start: { line: 11, character: 4 }, end: { line: 11, character: 8 } },
        severity: 1,
        code: 2322,
        message: "Type 'string' is not assignable to type 'number'.",
      },
      {
        range: { start: { line: 6, character: 0 }, end: { line: 6, character: 3 } },
        severity: 2,
        code: "no-unused",
        message: "unused",
      },
    ]
    const out = adaptLspDiagnostics(items, "tsgo")
    expect(out[0]).toMatchObject({
      source: "tsgo",
      severity: "error",
      code: "TS2322",
      line: 12, // 0-based 11 → 1-based 12
      col: 5, // 0-based 4 → 1-based 5
    })
    expect(out[1]?.severity).toBe("warning")
    expect(out[1]?.code).toBe("no-unused")
  })

  it("prefixes only numeric TS codes with TS; leaves string codes alone", () => {
    const out = adaptLspDiagnostics(
      [{ range: { start: { line: 0, character: 0 } }, severity: 1, code: 6133, message: "x" }],
      "tsgo",
    )
    expect(out[0]?.code).toBe("TS6133")
  })

  it("returns [] for a non-array input", () => {
    expect(adaptLspDiagnostics(undefined as unknown as [], "tsgo")).toEqual([])
  })
})

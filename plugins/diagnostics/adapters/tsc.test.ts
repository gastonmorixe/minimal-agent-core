/**
 * Tests for {@link adaptTscOutput}: parse tsc --noEmit output into Findings.
 */
import { describe, expect, it } from "bun:test"

import { adaptTscOutput } from "./tsc.ts"

describe("adaptTscOutput", () => {
  it("parses a single error line", () => {
    const out = `src/file.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.`
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      source: "tsc",
      severity: "error",
      line: 10,
      col: 5,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
    })
  })

  it("parses a warning line", () => {
    const out = `src/lib.ts(3,1): warning TS6133: 'x' is declared but its value is never read.`
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].code).toBe("TS6133")
  })

  it("folds continuation lines into the preceding message", () => {
    const out = [
      `src/app.ts(71,42): error TS2345: Argument of type 'number | undefined' is not assignable to parameter of type 'number'.`,
      `  Type 'undefined' is not assignable to type 'number'.`,
    ].join("\n")
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toContain("Type 'undefined' is not assignable to type 'number'.")
    expect(findings[0].message).toContain("Argument of type")
  })

  it("returns empty array for blank input", () => {
    expect(adaptTscOutput("")).toEqual([])
    expect(adaptTscOutput("\n\n")).toEqual([])
  })

  it("skips garbled lines", () => {
    const out = [
      `garbage line that makes no sense`,
      `src/file.ts(1,1): error TS9999: real message`,
    ].join("\n")
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(1)
    expect(findings[0].code).toBe("TS9999")
  })

  it("skips tsc summary lines (no match)", () => {
    const out = [`src/file.ts(1,1): error TS2322: bad`, `Found 1 error in src/file.ts`].join("\n")
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(1)
  })

  it("filters to a specific file path", () => {
    const out = [
      `src/a.ts(1,1): error TS1001: bad a`,
      `src/b.ts(2,2): error TS2002: bad b`,
      `src/c.ts(3,3): error TS3003: bad c`,
    ].join("\n")
    const findings = adaptTscOutput(out, "tsc", "src/b.ts")
    expect(findings).toHaveLength(1)
    expect(findings[0].message).toBe("bad b")
  })

  it("matches file path by suffix (relative vs absolute)", () => {
    const out = [
      `steps/01-vectors-and-dot-product.ts(35,12): error TS2532: possibly undefined`,
    ].join("\n")

    const byRelative = adaptTscOutput(out, "tsc", "01-vectors-and-dot-product.ts")
    expect(byRelative).toHaveLength(1)

    const byFull = adaptTscOutput(out, "tsc", "steps/01-vectors-and-dot-product.ts")
    expect(byFull).toHaveLength(1)
  })

  it("handles mixed error and warning lines", () => {
    const out = [
      `src/a.ts(1,1): error TS1001: broken`,
      `src/a.ts(5,3): warning TS6133: unused`,
    ].join("\n")
    const findings = adaptTscOutput(out)
    expect(findings).toHaveLength(2)
    expect(findings[0].severity).toBe("error")
    expect(findings[1].severity).toBe("warning")
  })

  it("accepts a custom source label", () => {
    const out = `x.ts(1,1): error TS1: msg`
    expect(adaptTscOutput(out, "mytsc")[0].source).toBe("mytsc")
  })
})

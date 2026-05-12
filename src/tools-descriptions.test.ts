/**
 * Static-prompt guardrails: every tool whose output is bounded by the
 * universal clamp (`src/tools/truncation.ts`) must announce the cap in
 * its `description` so the model can preempt with paging/bounding params
 * instead of discovering the limit reactively via the truncation notice.
 *
 * This is "Layer 1" of the size-feedback design — see the design doc /
 * conversation. Layer 2 is the in-band `[truncated: ...]` notice
 * (already implemented in `src/tools/truncation.ts`); Layer 3 is the
 * streak tracker (`src/tools/feedback-tracker.ts`).
 *
 * If you change the size caps, update both `truncation.ts` and the
 * descriptions — the test below asserts the documented numbers match
 * the constants so they don't drift.
 */
import { describe, expect, it } from "bun:test"
import { TOOL_DEFINITIONS } from "./tools.ts"
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./tools/truncation.ts"

function descOf(name: string): string {
  const t = TOOL_DEFINITIONS.find((d) => d.name === name)
  if (!t) throw new Error(`No tool named ${name}`)
  return t.description
}

describe("tool descriptions — output cap is documented", () => {
  it("Bash mentions the byte/line cap", () => {
    const d = descOf("Bash")
    // Cap mentioned in human-readable form. We intentionally match a loose
    // shape (~64KB) rather than the exact byte literal — the description
    // is for a model reader, not a parser.
    expect(d).toMatch(/64\s*KB/i)
    expect(d).toMatch(/1000\s*lines/i)
  })

  it("Bash hints at output-bounding alternatives", () => {
    const d = descOf("Bash")
    // We don't enforce specific verbs — just that *some* bounding
    // alternative is present so the model doesn't go in blind.
    expect(d).toMatch(/head|tail|sed|grep/i)
  })

  it("Read mentions the cap and the paging params", () => {
    const d = descOf("Read")
    expect(d).toMatch(/64\s*KB/i)
    expect(d).toMatch(/offset/)
    expect(d).toMatch(/limit/)
  })

  it("Grep mentions the cap and dense-output alternatives", () => {
    const d = descOf("Grep")
    expect(d).toMatch(/64\s*KB/i)
    expect(d).toMatch(/files_with_matches|count/)
    // At least one narrowing knob.
    expect(d).toMatch(/glob|head_limit|-[ABC]/)
  })

  it("documented cap matches the constants in truncation.ts", () => {
    // Drift guard: if someone bumps the constants, this test fails fast
    // with a clear message instead of silently letting the descriptions
    // lie to the model.
    expect(MAX_TOOL_OUTPUT_BYTES).toBe(64_000)
    expect(MAX_TOOL_OUTPUT_LINES).toBe(1_000)
  })
})

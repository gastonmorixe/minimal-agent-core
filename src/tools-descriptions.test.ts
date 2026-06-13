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

import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./tools/truncation.ts"
import { TOOL_DEFINITIONS } from "./tools.ts"

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

  it("Bash discloses the TUI-side preview cap distinct from the API cap", () => {
    const d = descOf("Bash")
    // The user-facing transcript preview is ~10 lines; tooling must
    // tell the model so it doesn't assume "model-visible == user-visible".
    expect(d).toMatch(/10\s*LINES|10\s*lines/)
    expect(d).toMatch(/transcript|user/i)
  })

  it("Bash steers the model away from using it as a user-visible render channel", () => {
    const d = descOf("Bash")
    expect(d).toMatch(/visual|ASCII|ANSI|preview/i)
    expect(d).toMatch(/text reply|response|reply/i)
  })

  it("Bash mentions the runtime <ma::agent::output-preview> annotation", () => {
    const d = descOf("Bash")
    expect(d).toMatch(/<ma::agent::output-preview/)
  })

  it("Read discloses the TUI-side preview cap distinct from the API cap", () => {
    const d = descOf("Read")
    expect(d).toMatch(/15\s*lines/i)
    expect(d).toMatch(/transcript|user/i)
  })

  it("Grep discloses the TUI-side preview cap distinct from the API cap", () => {
    const d = descOf("Grep")
    expect(d).toMatch(/12\s*lines/i)
    expect(d).toMatch(/transcript|user/i)
  })

  it("Read mentions the cap and the paging params", () => {
    const d = descOf("Read")
    expect(d).toMatch(/64\s*KB/i)
    expect(d).toMatch(/offset/)
    expect(d).toMatch(/limit/)
  })

  it("Read tells the model it can view images (not decode them as text)", () => {
    const d = descOf("Read")
    // The whole point of the multimodal Read fix: the model must KNOW that
    // reading an image path shows it the pixels, so it stops concluding it
    // "can't read images" and stops trying to decode PNG bytes as text.
    expect(d).toMatch(/image/i)
    expect(d).toMatch(/PNG|JPEG|screenshot/i)
    expect(d).toMatch(/downscal|resiz|fit/i)
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

describe("tool descriptions — search routing directives", () => {
  // These directives were measured to cut Bash-`find`/`grep` mis-routing from
  // ~30-41% to ~0% on opus-4-8 with no over-routing of real shell work. See
  // private/work/tool-routing-study/ and docs/changes/
  // 2026-05-30-tool-routing-search-directives.md. Keep them so a future prompt
  // edit can't silently drop the steer.
  it("Grep tells the model to never invoke grep/rg via Bash", () => {
    const d = descOf("Grep")
    expect(d).toMatch(/never|do not/i)
    expect(d).toMatch(/\bgrep\b/)
    expect(d).toMatch(/\brg\b/)
  })

  it("Glob tells the model to never use find/fd/ls via Bash", () => {
    const d = descOf("Glob")
    expect(d).toMatch(/never|do not/i)
    expect(d).toMatch(/\bfind\b/)
  })

  it("Bash steers search/read/count to the dedicated tools", () => {
    const d = descOf("Bash")
    // Names the dedicated tools as the right call for search/read.
    expect(d).toMatch(/Grep/)
    expect(d).toMatch(/Glob/)
    // And no longer suggests bounding output with `grep`.
    expect(d).not.toMatch(/or `grep`/)
  })
})

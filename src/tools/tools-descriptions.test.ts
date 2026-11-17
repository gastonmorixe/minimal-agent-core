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

import {
  fixtureToolTextProviders,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { buildToolDefinitions } from "./tools.ts"
import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./truncation.ts"

// The tool text of the real core-tools plugin, not a core fallback.
const DEFINITIONS = textFixturesPresent() ? buildToolDefinitions(fixtureToolTextProviders()) : []

function descOf(name: string): string {
  const t = DEFINITIONS.find((d) => d.name === name)
  if (!t) throw new Error(`No tool named ${name}`)
  return t.description ?? ""
}

describe.skipIf(!textFixturesPresent())("tool descriptions — output cap is documented", () => {
  // The TUI-preview pins (Bash 10 lines, Read 15, Grep 12, the
  // <ma::agent::output-preview> annotation and the "not a render channel"
  // advice) were removed on 2026-11-17. The user capped every tool and param
  // description at 500 characters and kept only the most important part.
  // That guidance did not fit, and it was dropped by that decision.
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

  it("Read tells the model it can view images (not decode them as text)", () => {
    const d = descOf("Read")
    // The whole point of the multimodal Read fix: the model must KNOW that
    // reading an image path shows it the pixels, so it stops concluding it
    // "can't read images" and stops trying to decode PNG bytes as text.
    expect(d).toMatch(/image/i)
    expect(d).toMatch(/PNG|JPEG|screenshot/i)
    expect(d).toMatch(/not text/i)
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

describe.skipIf(!textFixturesPresent())("tool descriptions — search routing directives", () => {
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

  it("Glob documents pattern/path plus Cursor aliases", () => {
    // The 500-character cap (2026-11-17) moved the alias facts from the tool
    // description to the param descriptions, where the model reads them with
    // the param.
    const t = DEFINITIONS.find((x) => x.name === "Glob")
    const props = (t?.input_schema as { properties?: Record<string, { description?: string }> })
      ?.properties
    expect(Object.keys(props ?? {})).toEqual(
      expect.arrayContaining(["pattern", "glob_pattern", "path", "target_directory"]),
    )
    expect(props?.pattern?.description).toMatch(/`glob_pattern`/)
    expect(props?.glob_pattern?.description).toMatch(/`pattern`/)
    expect(props?.target_directory?.description).toMatch(/`path`/)
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

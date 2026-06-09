/**
 * Overage tail on the provider-neutral path.
 *
 * The live footer feeds the renderer neutral `QuotaWindow[]` plus an
 * `overage` DTO (from `QuotaSnapshot.overage`). These tests pin that the
 * `overage off` readout surfaces under the `showOverage` opt-in rules:
 * only the inactive ("off") state renders, and only when opted in.
 * (Header parsing into the DTO is provider-side — see
 * `plugins/llm-anthropic/session-info.overage.test.ts`.)
 *
 * @module quota-status/render.overage.test
 */

import { describe, expect, it } from "bun:test"

import type { QuotaWindow } from "../../src/llm/provider-plugin.ts"
import type { SessionTokens } from "../../src/session-tokens.ts"
import { stripAnsi } from "../../src/term-width.ts"

import { renderQuotaFooter } from "./render.ts"

const TOKENS: SessionTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  contextSize: 0,
} as SessionTokens

const WINDOWS: QuotaWindow[] = [{ id: "5h", utilization: 0.1 }]

// Wide terminal so the compression ladder never drops the (early-dropping)
// overage tail — these tests are about presence/absence, not width pressure.
const WIDE = 300

describe("renderQuotaFooter — overage on the neutral path", () => {
  it("surfaces 'overage off' when overage is inactive AND showOverage is on", () => {
    const out = stripAnsi(
      renderQuotaFooter(WINDOWS, TOKENS, {
        cols: WIDE,
        showOverage: true,
        overage: { active: false },
      })!,
    )
    expect(out).toContain("overage")
    expect(out).toContain("off")
  })

  it("hides overage by default (showOverage falsey) even when inactive", () => {
    const out = stripAnsi(
      renderQuotaFooter(WINDOWS, TOKENS, {
        cols: WIDE,
        overage: { active: false },
      })!,
    )
    expect(out).not.toContain("overage")
  })

  it("hides overage when showOverage is on but overage is active/engaged", () => {
    const out = stripAnsi(
      renderQuotaFooter(WINDOWS, TOKENS, {
        cols: WIDE,
        showOverage: true,
        overage: { active: true },
      })!,
    )
    expect(out).not.toContain("overage")
  })

  it("hides overage when no overage DTO is supplied (provider didn't report it)", () => {
    const out = stripAnsi(
      renderQuotaFooter(WINDOWS, TOKENS, {
        cols: WIDE,
        showOverage: true,
      })!,
    )
    expect(out).not.toContain("overage")
  })

  it("renders the 'overage off' tail with the established bytes (faintWhite label, red value)", () => {
    // Byte-level pin of the tail's visual, preserving the guarantee the
    // retired legacy-vs-neutral identity test gave: the rendering must not
    // drift. faintWhite = `\x1b[2;37m…\x1b[22;39m`; red = `\x1b[31m…\x1b[39m`.
    const out = renderQuotaFooter(WINDOWS, TOKENS, {
      cols: WIDE,
      showOverage: true,
      showSession: false,
      overage: { active: false },
    })!
    expect(out).toContain("\x1b[2;37moverage\x1b[22;39m \x1b[31moff\x1b[39m")
  })

  it("the neutral default-order output is unchanged when showOverage is off", () => {
    // No overage tail must mean byte-identical output regardless of whether an
    // overage DTO is present — the opt-in is the only gate.
    const withoutDto = renderQuotaFooter(WINDOWS, TOKENS, { cols: WIDE })!
    const withInactiveDto = renderQuotaFooter(WINDOWS, TOKENS, {
      cols: WIDE,
      overage: { active: false },
    })!
    expect(withInactiveDto).toBe(withoutDto)
  })
})

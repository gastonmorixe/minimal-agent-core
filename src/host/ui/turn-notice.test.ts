import { describe, expect, it } from "bun:test"

import { renderTurnNotice } from "./turn-notice.ts"

/**
 * Host-side rendering for {@link TurnNotice} values. The core detects each
 * out-of-band condition and hands the semantic value to the host; this
 * module paints it. These assertions live under `src/host/` (not next to
 * the core seam test) because a core test file must not import the host
 * tree : that would trip the core→host import ratchet. Host files are
 * blessed for host imports, so the presentation assertions belong here.
 *
 * The core-side seam (detect + dispatch + style-free fallback) is pinned
 * in `src/agent.turn-notice-hook.test.ts`.
 */
describe("renderTurnNotice (TUI treatment per kind)", () => {
  it("paints a red REFUSAL banner with ANSI, category, and message", () => {
    const banner = renderTurnNotice({
      kind: "refusal",
      severity: "error",
      category: "policy_violation",
      message: "flagged content",
    })
    expect(banner).toContain("REFUSAL")
    expect(banner).toContain("(policy_violation)")
    expect(banner).toContain("flagged content")
    expect(banner).toContain("incomplete")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting presence of SGR
    expect(banner).toMatch(/\x1b\[/)
  })

  it("uses the CONTENT FILTER label for content_filter", () => {
    const banner = renderTurnNotice({
      kind: "content_filter",
      severity: "error",
      category: null,
      message: null,
    })
    expect(banner).toContain("CONTENT FILTER")
  })

  it("renders a yellow bang line for max_tokens_continuing", () => {
    const line = renderTurnNotice({
      kind: "max_tokens_continuing",
      severity: "warn",
      attempt: 2,
      cap: 5,
    })
    expect(line).toContain("auto-continuing (2/5)")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting presence of SGR
    expect(line).toMatch(/\x1b\[/)
  })

  it("renders the salvaged and capped max_tokens variants", () => {
    expect(renderTurnNotice({ kind: "max_tokens_salvaged", severity: "warn" })).toContain(
      "salvaged",
    )
    expect(renderTurnNotice({ kind: "max_tokens_capped", severity: "warn", cap: 5 })).toContain(
      "5 times in a row",
    )
  })

  it("renders the tool_rounds_capped variant", () => {
    expect(renderTurnNotice({ kind: "tool_rounds_capped", severity: "warn", cap: 50 })).toContain(
      "50 tool rounds",
    )
  })

  it("renders stream_interrupted_salvaged with complete-tool count", () => {
    const line = renderTurnNotice({
      kind: "stream_interrupted_salvaged",
      severity: "warn",
      completedToolCalls: 2,
    })
    expect(line).toContain("2 complete tool")
    expect(line).toContain("will not replay")
  })

  it("renders stream_interrupted_continuing and capped variants", () => {
    expect(
      renderTurnNotice({
        kind: "stream_interrupted_continuing",
        severity: "warn",
        attempt: 1,
        cap: 1,
      }),
    ).toContain("auto-continuing from local state (1/1)")
    expect(
      renderTurnNotice({ kind: "stream_interrupted_capped", severity: "warn", cap: 1 }),
    ).toContain("1 times in a row")
  })

  it("renders a dim marker for reflection_ack (with and without reason)", () => {
    const withReason = renderTurnNotice({
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 3,
      reason: "long refactor",
      fromToolFallback: false,
    })
    expect(withReason).toContain("silencing next 3 checkpoints")
    expect(withReason).toContain("long refactor")

    const fromTool = renderTurnNotice({
      kind: "reflection_ack",
      severity: "info",
      silenceFor: 1,
      reason: "",
      fromToolFallback: true,
    })
    expect(fromTool).toContain("silencing next 1 checkpoint")
    expect(fromTool).toContain("from tool_use fallback")
  })
})

/**
 * `resolveAnthropicSystemPrompt` characterization.
 *
 * Moved from `src/llm/system-prompt.test.ts` (Wave A unit A-5, PLAN.md):
 * the plan-auth billing header + exact Claude-Code identity are Anthropic
 * wire knowledge validated by their server, so the pins live with the
 * provider, not in core. The byte expectations are unchanged from the
 * pre-move suite (pure move; charter: characterization green before AND
 * after). The neutral identity is passed as DATA (no src/ import — I3):
 * the resolver treats it as an opaque string to keep or drop.
 *
 * @module llm/providers/anthropic/system-prompt.test
 */

import { describe, expect, it } from "bun:test"

import { CLAUDE_CODE_IDENTITY, resolveAnthropicSystemPrompt } from "./system-prompt.ts"

type Ctx = Parameters<typeof resolveAnthropicSystemPrompt>[0]

/** Stand-in for core's NEUTRAL_IDENTITY (same leading phrase the real one carries). */
const NEUTRAL_IDENTITY_STAND_IN = "You are Minimal Agent, an interactive CLI agent."

describe("resolveAnthropicSystemPrompt", () => {
  const body: Ctx["body"] = [
    {
      type: "text",
      text: "INSTRUCTIONS",
      cache_control: { type: "ephemeral", ttl: "1h", scope: "global" },
    },
  ]

  it("OAuth (plan auth): billing block + exact Claude-Code identity, neutral identity dropped", () => {
    const out = resolveAnthropicSystemPrompt({
      identity: NEUTRAL_IDENTITY_STAND_IN,
      body,
      authKind: "oauth",
      modelId: "claude-opus-4-7",
    })
    expect(out).toHaveLength(3)
    expect(out[0].text).toMatch(
      /^x-anthropic-billing-header: cc_version=\d+\.\d+\.\S+; cc_entrypoint=cli; cch=00000;$/,
    )
    expect(out[1].text).toBe(CLAUDE_CODE_IDENTITY)
    expect(out[1].text).not.toContain("Minimal Agent")
    expect(out[2].text).toBe("INSTRUCTIONS")
  })

  it("api-key: keeps neutral identity, NO billing header", () => {
    const out = resolveAnthropicSystemPrompt({
      identity: NEUTRAL_IDENTITY_STAND_IN,
      body,
      authKind: "api-key",
      modelId: "claude-opus-4-7",
    })
    expect(out).toHaveLength(2)
    expect(out[0].text).toBe(NEUTRAL_IDENTITY_STAND_IN)
    expect(out.some((b) => b.text.startsWith("x-anthropic-billing-header"))).toBe(false)
  })
})

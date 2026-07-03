import { describe, expect, it } from "bun:test"

import { detectStopNotice, formatTurnNoticePlain, type TurnNotice } from "./agent/turn-notice.ts"
import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth/auth.ts"
import type { SendOptions, StreamedResponse } from "./client/types.ts"

/**
 * TurnNotice seam (CORE side). Out-of-band conditions the agent loop
 * surfaces (provider refusal / content filter, output-budget events,
 * reflection-ack confirmations) used to be ANSI-styled `writeTranscript`
 * calls inside the core loop. They now route through ONE hook,
 * `onNotice`, carrying a semantic {@link TurnNotice} value. Contract,
 * pinned here across the two CORE layers:
 *
 *   1. `detectStopNotice` (core, pure): stop reason + details →
 *      StopNotice | null. No ANSI, no I/O.
 *   2. `Agent.run` dispatch: fires `onNotice` with each notice when the
 *      host wired it; falls back to a style-free one-liner through
 *      `onTranscriptLine` when it didn't. Never both.
 *
 * The HOST renderer (`renderTurnNotice`) is pinned separately in
 * `src/host/ui/turn-notice.test.ts` : a core test file must not import
 * the host tree (the core→host import ratchet), so the presentation
 * assertions live host-side where such imports are blessed.
 */

const auth: AuthResult = { type: "api-key", token: "test-token" }

function makeSendFn(response: Partial<StreamedResponse>, rounds?: Partial<StreamedResponse>[]) {
  let call = 0
  return async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const r = rounds ? (rounds[call] ?? rounds[rounds.length - 1]) : response
    call++
    yield r.text ?? ""
    return {
      blocks: r.blocks ?? (r.text ? [{ type: "text", text: r.text }] : []),
      text: r.text ?? "",
      stopReason: r.stopReason ?? null,
      stopDetails: r.stopDetails,
    } as StreamedResponse
  }
}

async function runAgent(
  response: Partial<StreamedResponse>,
  hooks: { withHook: boolean },
): Promise<{ lines: string[]; notices: TurnNotice[] }> {
  const lines: string[] = []
  const notices: TurnNotice[] = []
  const agent = new Agent({ auth, model: "test-model", sendFn: makeSendFn(response) })
  const gen = agent.run("hi", {
    onTranscriptLine: (line: string) => {
      lines.push(line)
    },
    ...(hooks.withHook
      ? {
          onNotice: (notice: TurnNotice) => {
            notices.push(notice)
          },
        }
      : {}),
  })
  while (true) {
    const { done } = await gen.next()
    if (done) break
  }
  return { lines, notices }
}

describe("detectStopNotice (pure core projection)", () => {
  it("maps refusal with details to a notice", () => {
    const n = detectStopNotice("refusal", { type: "policy_violation", message: "flagged" })
    expect(n).toEqual({
      kind: "refusal",
      severity: "error",
      category: "policy_violation",
      message: "flagged",
    })
  })

  it("suppresses a category that merely repeats the stop reason", () => {
    expect(detectStopNotice("refusal", { type: "refusal" })).toEqual({
      kind: "refusal",
      severity: "error",
      category: null,
      message: null,
    })
  })

  it("maps content_filter without details", () => {
    expect(detectStopNotice("content_filter", null)).toEqual({
      kind: "content_filter",
      severity: "error",
      category: null,
      message: null,
    })
  })

  it("returns null for every normal termination (incl. max_tokens: loop handles it)", () => {
    for (const reason of ["end_turn", "tool_use", "max_tokens", "pause_turn", null]) {
      expect(detectStopNotice(reason)).toBeNull()
    }
  })
})

describe("Agent.run onNotice dispatch (refusal path)", () => {
  it("fires the hook with the semantic notice (no transcript fallback)", async () => {
    const { lines, notices } = await runAgent(
      { stopReason: "refusal", stopDetails: { type: "refusal" } },
      { withHook: true },
    )
    expect(notices).toEqual([{ kind: "refusal", severity: "error", category: null, message: null }])
    expect(lines.find((l) => l.includes("safety layer"))).toBeUndefined()
  })

  it("falls back to a plain, ANSI-free transcript line when no hook is wired", async () => {
    const { lines } = await runAgent(
      { stopReason: "refusal", stopDetails: { type: "policy_violation", message: "flagged" } },
      { withHook: false },
    )
    const fallback = lines.find((l) => l.includes("safety layer"))
    expect(fallback).toBeDefined()
    expect(fallback).toContain("[refusal]")
    expect(fallback).toContain("(policy_violation)")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of SGR
    expect(fallback).not.toMatch(/\x1b\[/)
  })

  it("stays silent on a normal end_turn", async () => {
    const { lines, notices } = await runAgent(
      { text: "hello", stopReason: "end_turn" },
      { withHook: true },
    )
    expect(notices).toEqual([])
    expect(lines.find((l) => l.includes("safety layer"))).toBeUndefined()
  })
})

describe("Agent.run onNotice dispatch (max_tokens path)", () => {
  it("emits max_tokens_continuing then completes when the retry ends cleanly", async () => {
    const notices: TurnNotice[] = []
    const agent = new Agent({
      auth,
      model: "test-model",
      sendFn: makeSendFn({}, [
        // round 1: truncated, no tool blocks → auto-continue
        { text: "", stopReason: "max_tokens" },
        // round 2: clean finish
        { text: "done", stopReason: "end_turn" },
      ]),
    })
    const gen = agent.run("hi", {
      onTranscriptLine: () => {},
      onNotice: (n) => {
        notices.push(n)
      },
    })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({
      kind: "max_tokens_continuing",
      severity: "warn",
      attempt: 1,
    })
  })
})

describe("formatTurnNoticePlain (core, style-free fallback)", () => {
  it("is ANSI-free for every kind", () => {
    const kinds: TurnNotice[] = [
      { kind: "refusal", severity: "error", category: null, message: null },
      { kind: "content_filter", severity: "error", category: null, message: null },
      { kind: "max_tokens_salvaged", severity: "warn" },
      { kind: "max_tokens_continuing", severity: "warn", attempt: 1, cap: 5 },
      { kind: "max_tokens_capped", severity: "warn", cap: 5 },
      { kind: "tool_rounds_capped", severity: "warn", cap: 50 },
      {
        kind: "reflection_ack",
        severity: "info",
        silenceFor: 1,
        reason: "",
        fromToolFallback: true,
      },
    ]
    for (const n of kinds) {
      const plain = formatTurnNoticePlain(n)
      expect(plain.length).toBeGreaterThan(0)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting absence of SGR
      expect(plain).not.toMatch(/\x1b\[/)
    }
  })
})

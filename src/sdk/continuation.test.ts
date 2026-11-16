/**
 * Follow-up 15a: a continuation round (max_tokens or an interrupted stream
 * with no tool call) never sends an empty text block. Bare core (no text
 * provider) ends the turn truncated instead. With a provider the messages
 * are the same as before the fix.
 */

import { describe, expect, it } from "bun:test"

import type {
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import {
  fixtureSyntheticTextProviders,
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { AgentCore } from "./agent-core.ts"
import { planContinuation } from "./continuation.ts"
import type { TurnOutcome } from "./stop-policy.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const USER_TEXT = "hi"

type Cut = "max_tokens" | "interrupted"

/** Round 1 is cut (empty or partial), round 2 ends the turn. */
function cutResponse(cut: Cut, empty: boolean): StreamedResponse {
  const blocks = empty ? [] : [{ type: "text" as const, text: "partial" }]
  return {
    blocks,
    text: empty ? "" : "partial",
    ...(cut === "max_tokens"
      ? { stopReason: "max_tokens" }
      : {
          stopReason: "end_turn",
          stopDetails: { type: "stream_closed_without_terminal", message: "cut" },
        }),
  } as StreamedResponse
}

interface RunResult {
  requests: Message[][]
  outcome: TurnOutcome | undefined
  messages: Message[]
}

async function runCut(
  cut: Cut,
  empty: boolean,
  providers?: SyntheticTextProvider[],
): Promise<RunResult> {
  const requests: Message[][] = []
  let outcome: TurnOutcome | undefined
  const sendFn = async function* (opts: {
    messages: Message[]
  }): AsyncGenerator<string, StreamedResponse, undefined> {
    // The cache marker is not part of this check: drop it.
    const json = JSON.stringify(opts.messages, (k, v) => (k === "cache_control" ? undefined : v))
    requests.push(JSON.parse(json) as Message[])
    if (requests.length === 1) return cutResponse(cut, empty)
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const core = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    sendFn: sendFn as never,
    eventSink: {
      emit: (e) => {
        if (e.type === "run_finished") outcome = e.outcome
      },
    },
    ...(providers ? { syntheticTextProviders: providers } : {}),
  })
  const gen = core.run(USER_TEXT)
  while (!(await gen.next()).done) {
    // drain
  }
  return { requests, outcome, messages: core.messages }
}

/** Every text block in `messages` (string content counts as one block). */
function textBlocks(messages: readonly Message[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (typeof m.content === "string") out.push(m.content)
    else for (const b of m.content) if (b.type === "text") out.push(b.text)
  }
  return out
}

/** A provider with fixed text per kind. */
function provider(texts: Partial<Record<SyntheticKind, string>>): SyntheticTextProvider {
  return {
    kinds: Object.keys(texts) as SyntheticKind[],
    text: (kind) => texts[kind] ?? "",
  }
}

const RESOLVER_EMPTY: SyntheticTextResolver = { resolve: () => "" }

describe("planContinuation", () => {
  it("stops when the continue text is empty", () => {
    for (const maxTokens of [true, false]) {
      for (const responseEmpty of [true, false]) {
        expect(planContinuation(RESOLVER_EMPTY, maxTokens, responseEmpty)).toEqual({
          kind: "stop",
        })
      }
    }
  })

  it("drops only the placeholder when its text is empty", () => {
    const r: SyntheticTextResolver = {
      resolve: (k) => (k === "continue.max_tokens" ? "go on" : ""),
    }
    expect(planContinuation(r, true, true)).toEqual({
      kind: "continue",
      placeholder: null,
      nudge: [{ type: "text", text: "go on" }],
    })
  })

  it("adds a placeholder only after an empty response", () => {
    const r: SyntheticTextResolver = { resolve: (k) => `<${k}>` }
    expect(planContinuation(r, false, true)).toEqual({
      kind: "continue",
      placeholder: [{ type: "text", text: "<assistant.placeholder>" }],
      nudge: [{ type: "text", text: "<continue.stream_interrupted>" }],
    })
    expect(planContinuation(r, true, false)).toEqual({
      kind: "continue",
      placeholder: null,
      nudge: [{ type: "text", text: "<continue.max_tokens>" }],
    })
  })
})

describe("bare core continuation (no text provider)", () => {
  for (const cut of ["max_tokens", "interrupted"] as const) {
    for (const empty of [true, false]) {
      it(`${cut}, ${empty ? "empty" : "partial"} response: no empty block, turn ends truncated`, async () => {
        const { requests, outcome, messages } = await runCut(cut, empty)
        expect(requests.length).toBe(1)
        expect(outcome).toBe("truncated")
        for (const req of requests) expect(textBlocks(req)).not.toContain("")
        expect(textBlocks(messages)).not.toContain("")
        // No empty message, and the history ends on the model reply or the user.
        for (const m of messages) expect(m.content.length).toBeGreaterThan(0)
        expect(messages.map((m) => m.role)).toEqual(empty ? ["user"] : ["user", "assistant"])
      })
    }
  }

  it("continue text but no placeholder text: no empty assistant message", async () => {
    const { requests, outcome } = await runCut("max_tokens", true, [
      provider({ "continue.max_tokens": "NUDGE" }),
    ])
    expect(outcome).toBe("completed")
    expect(requests.length).toBe(2)
    const second = requests[1] as Message[]
    expect(textBlocks(second)).not.toContain("")
    // Two user turns in a row: the providers join them (see 15a.md).
    expect(second.map((m) => m.role)).toEqual(["user", "user"])
    expect(textBlocks(second)).toEqual([USER_TEXT, "NUDGE"])
  })
})

describe("continuation with a text provider (bytes unchanged)", () => {
  const TEXTS = {
    "assistant.placeholder": "PLACEHOLDER",
    "continue.max_tokens": "MAX",
    "continue.stream_interrupted": "INTERRUPTED",
  } as const

  for (const cut of ["max_tokens", "interrupted"] as const) {
    const nudge =
      cut === "max_tokens" ? TEXTS["continue.max_tokens"] : TEXTS["continue.stream_interrupted"]

    it(`${cut}, empty response: placeholder then nudge`, async () => {
      const { requests, outcome } = await runCut(cut, true, [provider(TEXTS)])
      expect(outcome).toBe("completed")
      expect(requests[1]).toEqual([
        { role: "user", content: [{ type: "text", text: USER_TEXT }] },
        { role: "assistant", content: [{ type: "text", text: "PLACEHOLDER" }] },
        { role: "user", content: [{ type: "text", text: nudge }] },
      ] as Message[])
    })

    it(`${cut}, partial response: nudge after the reply`, async () => {
      const { requests } = await runCut(cut, false, [provider(TEXTS)])
      expect(requests[1]).toEqual([
        { role: "user", content: [{ type: "text", text: USER_TEXT }] },
        { role: "assistant", content: [{ type: "text", text: "partial" }] },
        { role: "user", content: [{ type: "text", text: nudge }] },
      ] as Message[])
    })
  }
})

describe.skipIf(!textFixturesPresent())("continuation with the real turn-recovery text", () => {
  it("sends the plugin placeholder and continue bytes", async () => {
    const resolver = fixtureSyntheticTextResolver()
    for (const cut of ["max_tokens", "interrupted"] as const) {
      const { requests } = await runCut(cut, true, fixtureSyntheticTextProviders())
      const kind = cut === "max_tokens" ? "continue.max_tokens" : "continue.stream_interrupted"
      expect(requests[1]).toEqual([
        { role: "user", content: [{ type: "text", text: USER_TEXT }] },
        {
          role: "assistant",
          content: [{ type: "text", text: resolver.resolve("assistant.placeholder", {}) }],
        },
        { role: "user", content: [{ type: "text", text: resolver.resolve(kind, {}) }] },
      ] as Message[])
      expect(textBlocks(requests[1] as Message[])).not.toContain("")
    }
  })
})

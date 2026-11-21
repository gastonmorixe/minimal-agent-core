/**
 * `tool.didBatch` generic hook facts: the payload `round` (1-based, it
 * increments per tool round of a run and starts at 1 again for each new
 * run), and the listener `additionalContext`, which becomes user content of
 * the next model request.
 */

import { describe, expect, it } from "bun:test"

import { checkToolDidBatch } from "../agent/tool-batch-gate.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import { AgentCore } from "./agent-core.ts"
import type { LifecyclePort, ToolDidBatchPayload } from "./lifecycle.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** The real codec renders the `policy` tags (design step 6). */
const SB = fixtureSidebandOrNone()
/** One `policy` tag from the codec. */
const pol = (body: string): string => SB.render("policy", { body })
/** The open part of a `policy` tag (no tag literal in this file). */
const POLICY_OPEN = sidebandFixturePresent() ? pol("x").slice(0, pol("x").indexOf("x")) : "\u0000"

const toolTurn = (id: string): StreamedResponse =>
  ({
    blocks: [{ type: "tool_use", id, name: "Glob", input: { pattern: "zz-no-such-*" } }],
    text: "",
    stopReason: "tool_use",
  }) as StreamedResponse

const END: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
} as StreamedResponse

/** A core whose model asks for tools `toolRounds` times per run, then ends the run. */
function makeCore(toolRounds: number, lifecycle: LifecyclePort) {
  const requests: Message[][] = []
  let inRun = 0
  const sendFn: TransportFn = async function* (opts: SendOptions) {
    requests.push(structuredClone(opts.messages))
    inRun++
    if (inRun <= toolRounds) return toolTurn(`t${requests.length}`)
    inRun = 0
    return END
  }
  const core = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "ok", isError: false }) },
    sendFn,
    lifecycle,
    sideband: SB,
  })
  return { core, requests }
}

async function drain(core: AgentCore, text: string) {
  const gen = core.run(text)
  let r = await gen.next()
  while (!r.done) r = await gen.next()
  return r.value
}

const texts = (m: Message | undefined): string[] =>
  Array.isArray(m?.content)
    ? (m.content as ContentBlock[]).flatMap((b) => (b.type === "text" ? [b.text] : []))
    : []

describe("tool.didBatch round", () => {
  it("increments per tool round in a run and starts at 1 for each new run", async () => {
    const rounds: number[] = []
    const { core } = makeCore(3, {
      afterToolBatch: async (p: ToolDidBatchPayload) => {
        rounds.push(p.round)
        return { action: "allow", payload: p }
      },
    })
    expect((await drain(core, "first")).outcome).toBe("completed")
    expect(rounds).toEqual([1, 2, 3])
    expect((await drain(core, "second")).outcome).toBe("completed")
    expect(rounds).toEqual([1, 2, 3, 1, 2, 3])
  })

  it("the gate passes the round and the signal to the port", async () => {
    const seen: Array<{ round: number; signal?: AbortSignal }> = []
    const ac = new AbortController()
    const gate = await checkToolDidBatch(
      {
        afterToolBatch: async (p, signal) => {
          seen.push({ round: p.round, ...(signal ? { signal } : {}) })
          return { action: "allow", payload: p }
        },
      },
      { toolBlocks: [], toolResults: [], round: 7, signal: ac.signal },
    )
    expect(gate).toEqual({ halted: false, context: [] })
    expect(seen).toEqual([{ round: 7, signal: ac.signal }])
  })
})

describe.skipIf(!sidebandFixturePresent())("tool.didBatch additionalContext", () => {
  it("the gate wraps each entry in one policy text block", async () => {
    const gate = await checkToolDidBatch(
      {
        afterToolBatch: async (p) => ({
          action: "allow",
          payload: p,
          additionalContext: ["first note", "second note"],
        }),
      },
      { toolBlocks: [], toolResults: [], round: 1 },
      SB,
    )
    expect(gate).toEqual({
      halted: false,
      context: [
        {
          type: "text",
          text: `${pol("first note")}\n${pol("second note")}`,
        },
      ],
    })
  })

  it("reaches the next model request as user content, only after its round", async () => {
    const { core, requests } = makeCore(2, {
      afterToolBatch: async (p: ToolDidBatchPayload) => ({
        action: "allow",
        payload: p,
        additionalContext: [`note for round ${p.round}`],
      }),
    })
    expect((await drain(core, "go")).outcome).toBe("completed")
    // Request 1: the user prompt. Requests 2 and 3 follow tool rounds 1 and 2.
    expect(requests).toHaveLength(3)
    const lastUser = (req: Message[] | undefined) => req?.[req.length - 1]
    expect(lastUser(requests[0])?.role).toBe("user")
    expect(texts(lastUser(requests[0])).join("\n")).not.toContain(POLICY_OPEN)

    const r2 = lastUser(requests[1])
    expect(r2?.role).toBe("user")
    expect(texts(r2)).toContain(pol("note for round 1"))
    const r2Blocks = Array.isArray(r2?.content) ? (r2.content as ContentBlock[]) : []
    expect(r2Blocks.some((b) => b.type === "tool_result")).toBe(true)

    const r3 = lastUser(requests[2])
    expect(texts(r3)).toContain(pol("note for round 2"))
    expect(texts(r3).join("\n")).not.toContain("note for round 1")
  })

  it("an allow with no additionalContext adds no text block", async () => {
    const { core, requests } = makeCore(1, {
      afterToolBatch: async (p: ToolDidBatchPayload) => ({ action: "allow", payload: p }),
    })
    await drain(core, "go")
    const r2 = requests[1]?.[requests[1].length - 1]
    expect(texts(r2).join("\n")).not.toContain(POLICY_OPEN)
  })
})

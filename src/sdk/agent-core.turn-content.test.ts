import { describe, expect, it } from "bun:test"

import type {
  TurnContentCtx,
  TurnContentProviderDecl,
} from "../../plugin-api/src/types/turn-content.ts"
import { turnAbortedAttachmentText } from "../agent/PROMPTS.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

function toolThenDone(): TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "t1", name: "nope", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function userMessages(
  providers?: TurnContentProviderDecl[],
  abortedFirst = false,
): Promise<unknown[]> {
  const agent = await buildTestCore({
    auth,
    sendFn: toolThenDone(),
    ...(providers ? { turnContentProviders: providers } : {}),
  })
  if (abortedFirst) agent.notePreviousTurnAborted()
  const gen = agent.run("go")
  while (!(await gen.next()).done) {}
  return agent.messages.filter((m) => m.role === "user").map((m) => m.content)
}

describe("AgentCore turn content providers", () => {
  it("builds the literal core content with no provider", async () => {
    const plain = (await userMessages()) as unknown[][]
    expect(plain[0]).toEqual([{ type: "text", text: "go" }])
    const aborted = (await userMessages(undefined, true)) as unknown[][]
    expect(aborted[0]).toEqual([
      { type: "text", text: turnAbortedAttachmentText() },
      { type: "text", text: "go" },
    ])
    expect(await userMessages([{ order: 0, provide: () => [] }])).toEqual(plain)
  })

  it("appends provider blocks after the core slots at both seams", async () => {
    const seen: TurnContentCtx[] = []
    const base = (await userMessages()) as { type: string; text?: string }[][]
    const msgs = (await userMessages([
      {
        order: 0,
        provide: (c) => {
          seen.push(c)
          return [{ type: "text", text: `P-${c.seam}` }]
        },
      },
    ])) as { type: string; text?: string }[][]
    expect(msgs[0]).toEqual([...base[0]!, { type: "text", text: "P-initial" }])
    expect(msgs[1]).toEqual([...base[1]!, { type: "text", text: "P-round" }])
    expect(seen[0]).toMatchObject({ seam: "initial", round: 0, previousTurn: null })
    expect(seen[1]).toMatchObject({ seam: "round", salvaged: false, resumingFromCheckpoint: false })
    expect(seen[1]!.round).toBeGreaterThan(0)
  })

  it("reports previousTurn aborted after notePreviousTurnAborted", async () => {
    const seen: TurnContentCtx[] = []
    await userMessages([{ order: 0, provide: (c) => (seen.push(c), []) }], true)
    expect(seen[0]!.previousTurn).toBe("aborted")
  })
})

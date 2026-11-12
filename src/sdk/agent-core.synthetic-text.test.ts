import { describe, expect, it } from "bun:test"

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import { outputTruncatedAttachmentText } from "../agent/PROMPTS.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

function truncThenDone(): TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "text" as const, text: "partial" }],
        text: "partial",
        stopReason: "max_tokens",
      } as StreamedResponse
    }
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function nudgeText(providers?: SyntheticTextProvider[]): Promise<string[]> {
  const agent = await buildTestCore({
    auth,
    sendFn: truncThenDone(),
    ...(providers ? { syntheticTextProviders: providers } : {}),
  })
  const gen = agent.run("go")
  while (!(await gen.next()).done) {}
  const out: string[] = []
  for (const m of agent.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content)
      if (b.type === "text" && b.text.includes("ma::agent")) out.push(b.text)
  }
  return out
}

describe("AgentCore synthetic text wiring", () => {
  it("keeps today's continue text with no provider", async () => {
    expect(await nudgeText()).toEqual([outputTruncatedAttachmentText()])
  })

  it("uses the provider text for continue.max_tokens", async () => {
    const provider: SyntheticTextProvider = {
      kinds: ["continue.max_tokens"],
      text: () => "ma::agent::stub continue",
    }
    expect(await nudgeText([provider])).toEqual(["ma::agent::stub continue"])
  })
})

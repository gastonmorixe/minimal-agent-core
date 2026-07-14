/**
 * E2E-style compact flow on AgentCore (local path only).
 * Recovery integration lives under host/ (core must not import host).
 */
import { describe, expect, it } from "bun:test"

import type { Message } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { AgentCoreConfig, ToolExecutor, TranscriptSink } from "../sdk/ports.ts"

import { COMPACTION_USER_MARKER } from "./context-compact.ts"

const EMPTY_EXECUTOR: ToolExecutor = {
  async execute() {
    return { content: "", isError: false }
  },
}

const NOOP_SINK: TranscriptSink = { write() {} }

function minimalCore(messages: Message[]): AgentCore {
  const config: AgentCoreConfig = {
    auth: { type: "api-key", token: "t" },
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: EMPTY_EXECUTOR,
    transcriptSink: NOOP_SINK,
    sendFn: async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      return { blocks: [], text: "", stopReason: "end_turn" }
    },
    initialMessages: messages,
  }
  return new AgentCore(config)
}

describe("AgentCore.compact e2e (local)", () => {
  it("compacts seeded history via shared runner", async () => {
    const seed: Message[] = []
    for (let i = 0; i < 12; i++) {
      seed.push({ role: "user", content: `turn ${i}` })
      seed.push({ role: "assistant", content: `reply ${i}` })
    }
    const core = minimalCore(seed)
    expect(core.history().length).toBe(24)
    const stats = await core.compact({ reason: "manual", preferRemote: false })
    expect(stats.kind).toBe("local")
    expect(stats.messagesAfter).toBeLessThan(24)
    const hist = core.history()
    const first =
      typeof hist[0].content === "string"
        ? hist[0].content
        : hist[0].content.map((b) => (b.type === "text" ? b.text : "")).join("")
    expect(first).toContain(COMPACTION_USER_MARKER)
  })

  it("replaceMessages installs a custom history", () => {
    const core = minimalCore([{ role: "user", content: "old" }])
    core.replaceMessages([
      { role: "user", content: [{ type: "text", text: "new" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ])
    expect(core.history().length).toBe(2)
    expect(JSON.stringify(core.history()[0])).toContain("new")
  })
})

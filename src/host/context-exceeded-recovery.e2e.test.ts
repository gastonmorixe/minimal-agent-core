/**
 * Recovery helper + AgentCore compact integration (host-owned).
 */
import { afterEach, describe, expect, it } from "bun:test"

import type { Message } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { AgentCoreConfig, ToolExecutor, TranscriptSink } from "../sdk/ports.ts"

import { tryRecoverContextExceeded } from "./context-exceeded-recovery.ts"

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

describe("recovery + AgentCore compact integration", () => {
  const prev = process.env.MINIMAL_AGENT_AUTO_COMPACT
  afterEach(() => {
    if (prev === undefined) delete process.env.MINIMAL_AGENT_AUTO_COMPACT
    else process.env.MINIMAL_AGENT_AUTO_COMPACT = prev
  })

  it("auto-compact on exceeded yields retry text from core history", async () => {
    process.env.MINIMAL_AGENT_AUTO_COMPACT = "1"
    const core = minimalCore([
      { role: "assistant", content: "prior work" },
      { role: "user", content: "finish the remaining files" },
    ])
    const original = core.compact.bind(core)
    core.compact = async (opts) => original({ ...opts, preferRemote: false })

    const r = await tryRecoverContextExceeded(
      core,
      "context_length_exceeded — input exceeds the context window",
    )
    expect(r.shouldRetry).toBe(true)
    expect(r.retryText).toBe("finish the remaining files")
    expect(core.history().length).toBeLessThan(4)
  })
})

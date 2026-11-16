/**
 * E2E FAIL-2 regression: after `--resume`, the restored assistant
 * `providerMessageId` must reach `CanonicalRequest.messages` (Anthropic reads
 * it for `diagnostics.previous_message_id`). The send path runs history
 * through `withRollingCacheBreakpoint`, which used to rebuild each message as
 * `{ role, content }` and drop the id.
 *
 * Path under test: SessionStore jsonl → loadSession → AgentCore
 * (initialMessages) → sendFn opts.messages → sendOptionsToCanonical.
 *
 * @module sdk/provider-message-id.send-path.test
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import { sendOptionsToCanonical } from "../llm/codec/request-codec.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import { loadSession } from "../session/session-restore.ts"
import { SessionStore } from "../session/session-store.ts"
import { textCoreDeps, textFixturesPresent } from "../test-utils/text-fixture-providers.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentCoreConfig } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

describe.skipIf(!textFixturesPresent())("providerMessageId on the send path", () => {
  it("a restored assistant id reaches CanonicalRequest.messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-pmid-send-"))
    const sid = "ma-test-pmid-send"
    const store = SessionStore.open({
      model: "test-model",
      cwd: "/tmp/x",
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "test",
      sid,
      dir,
    })
    store.appendUser("one")
    store.appendAssistant([{ type: "text", text: "first" }], "end_turn", undefined, undefined, {
      providerMessageId: "msg_01restored",
    })
    const restored = loadSession(sid, dir).messages

    let req: CanonicalRequest | undefined
    const sendFn = async function* (opts: SendOptions) {
      req = sendOptionsToCanonical(opts)
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const config: AgentCoreConfig = {
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [] },
      toolExecutor: { execute: async () => ({ content: "", isError: false }) },
      ...textCoreDeps(),
      sendFn: sendFn as never,
      initialMessages: restored,
    }
    const core = new AgentCore(config)
    const gen = core.run("two")
    while (!(await gen.next()).done) {
      // drain
    }

    const assistant = req?.messages.find((m) => m.role === "assistant")
    expect(assistant?.providerMessageId).toBe("msg_01restored")
    // Metadata only: user messages never carry it.
    expect(req?.messages.filter((m) => "providerMessageId" in m)).toHaveLength(1)
  })
})

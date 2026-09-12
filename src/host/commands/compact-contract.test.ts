import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { runCompact } from "../../agent/run-compact.ts"
import type { Message } from "../../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import { clearProviderPlugins } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"
import { AgentCore } from "../../sdk/agent-core.ts"
import {
  compactDisplayBoundaries,
  foldRecordsForDisplay,
  foldRecordsForModel,
} from "../../session/session-restore.ts"
import type { CompactRecord, SessionRecord, SessionStore } from "../../session/session-store.ts"
import { SessionPersistenceAdapter } from "../sdk-adapters/session-persistence-adapter.ts"

import { buildCompactNoticeBlock } from "./compact.ts"

const MODEL = "compact-contract-model"
const PROVIDER = "compact-contract-provider"
const SUMMARY = "## Goal\nPreserve the complete checkpoint."

function fixtureCore(messages: Message[], appendCompact: (record: unknown) => void) {
  const store = {
    appendNote() {},
    appendCompact,
  } as unknown as SessionStore
  return new AgentCore({
    auth: { type: "api-key", token: "fixture" },
    model: MODEL,
    providerId: PROVIDER,
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: {
      async execute() {
        return { content: "", isError: false }
      },
    },
    transcriptSink: { write() {} },
    sessionPersistence: new SessionPersistenceAdapter(store),
    initialMessages: messages,
    sendFn: async function* () {
      return { blocks: [], text: "", stopReason: "end_turn" }
    },
  })
}

function toolPair(): Message[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "retained-read", name: "Read", input: { file_path: "a.ts" } },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "retained-read", content: "source text" }],
    },
  ]
}

function history(): Message[] {
  return Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: "original " + index }],
  }))
}

function checkpointRecord(record: unknown): CompactRecord {
  return JSON.parse(JSON.stringify({ ...(record as object), kind: "compact", ts: "t" }))
}

describe("compaction production contract", () => {
  let requestedStream: boolean | undefined

  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    requestedStream = undefined
    const provider = registerTestProvider({ id: PROVIDER, models: [{ id: MODEL }] })
    provider.adapter.run = async function* (request) {
      requestedStream = request.stream
      yield { type: "text_delta", index: 0, text: SUMMARY }
      yield { type: "message_stop" }
    }
  })

  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("requests streaming and forwards text before the core compact promise resolves", async () => {
    const core = fixtureCore(history(), () => {})
    const chunks: string[] = []
    let resolved = false
    let outputBeforeResolution = false
    const result = await core.compact({
      mode: "local",
      writeStream: (chunk) => {
        chunks.push(chunk)
        outputBeforeResolution = !resolved
      },
    })
    resolved = true
    expect(result.summaryText).toBe(SUMMARY)
    expect(requestedStream).toBe(true)
    expect(chunks.join("")).toBe(SUMMARY)
    expect(outputBeforeResolution).toBe(true)
  })

  it("persists through the real production adapter exactly once", async () => {
    const records: unknown[] = []
    const core = fixtureCore(history(), (record) => records.push(record))
    await core.compact({ mode: "local" })
    expect(records).toHaveLength(1)
    const restored = foldRecordsForModel([checkpointRecord(records[0])])
    expect(restored).toEqual(core.history())
  })

  it("keeps full retained tool blocks through checkpoint serialization and restore", async () => {
    const records: unknown[] = []
    const messages = toolPair()
    await runCompact({
      messages,
      model: MODEL,
      auth: { type: "api-key", token: "fixture" },
      reason: "manual",
      mode: "tail",
      appendCompact: (record) => records.push(record),
    })
    expect(records).toHaveLength(1)
    const restored = foldRecordsForModel([checkpointRecord(records[0])])
    expect(restored).toEqual(messages)
    expect(restored.slice(1)).toEqual(toolPair())
  })

  it("preserves live memory when checkpoint persistence throws", async () => {
    const messages = history()
    const original = structuredClone(messages)
    await expect(
      runCompact({
        messages,
        model: MODEL,
        auth: { type: "api-key", token: "fixture" },
        reason: "manual",
        mode: "tail",
        appendCompact: () => {
          throw new Error("fixture disk failure")
        },
      }),
    ).rejects.toThrow("fixture disk failure")
    expect(messages).toEqual(original)
  })

  it("does not mutate memory before the checkpoint writer returns", async () => {
    const messages = history()
    const original = structuredClone(messages)
    let memoryAtWrite: Message[] | undefined
    await runCompact({
      messages,
      model: MODEL,
      auth: { type: "api-key", token: "fixture" },
      reason: "manual",
      mode: "tail",
      appendCompact: () => {
        memoryAtWrite = structuredClone(messages)
      },
    })
    expect(memoryAtWrite).toEqual(original)
    expect(messages).not.toEqual(original)
  })
  it("forwards progress through the public core compact method", async () => {
    const core = fixtureCore(history(), () => {})
    const progress: number[] = []
    await core.compact({
      mode: "local",
      onProgress: ({ deltaTokens }) => progress.push(deltaTokens),
    })
    expect(progress.length).toBeGreaterThan(0)
    expect(progress.every((tokens) => tokens > 0)).toBe(true)
  })

  it("propagates production checkpoint write failure without changing core memory", async () => {
    const core = fixtureCore(history(), () => {
      throw new Error("fixture adapter write failure")
    })
    const original = structuredClone(core.history())
    await expect(core.compact({ mode: "local" })).rejects.toThrow("fixture adapter write failure")
    expect(core.history()).toEqual(original)
  })

  it("does not truncate long summary bodies before Markdown rendering", () => {
    const summary = Array.from(
      { length: 75 },
      (_, index) => "line " + index + " " + "context ".repeat(30),
    ).join("\n")
    const block = buildCompactNoticeBlock(
      {
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
        summaryText: summary,
      },
      { mode: "local", keepTail: 6 },
    )
    expect(block.body?.join("\n")).toBe(summary.trim())
  })
  it("renders the exact committed checkpoint body including focus", async () => {
    const records: unknown[] = []
    const core = fixtureCore(history(), (record) => records.push(record))
    const focus = "Preserve exact paths"
    const stats = await core.compact({ mode: "local", focus })
    const record = checkpointRecord(records[0])
    const content = record.replacementMessages[0].content
    const checkpoint =
      typeof content === "string"
        ? content
        : content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
    const notice = buildCompactNoticeBlock(stats, { mode: "local", keepTail: 6, focus })
    expect(notice.body?.join("\n")).toBe(checkpoint)
  })

  it("does not report a committed checkpoint as failed when its audit note throws", async () => {
    const messages = history()
    let writes = 0
    const result = await runCompact({
      messages,
      model: MODEL,
      auth: { type: "api-key", token: "fixture" },
      reason: "manual",
      mode: "tail",
      appendCompact: () => {
        writes += 1
      },
      appendNote: () => {
        throw new Error("fixture note failure")
      },
    })
    expect(writes).toBe(1)
    expect(result.messagesAfter).toBe(messages.length)
  })
  it("rejects a stale summary without dropping a prompt added during compaction", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const provider = registerTestProvider({ id: PROVIDER, models: [{ id: MODEL }] })
    provider.adapter.run = async function* () {
      started.resolve()
      await release.promise
      yield { type: "text_delta", index: 0, text: "Summary of the old history" }
      yield { type: "message_stop" }
    }
    const messages = history()
    const records: unknown[] = []
    const pending = runCompact({
      messages,
      model: MODEL,
      providerId: PROVIDER,
      auth: { type: "api-key", token: "fixture" },
      reason: "manual",
      mode: "local",
      keepTail: 0,
      appendCompact: (record) => records.push(record),
    })
    const outcome = pending.then(
      () => "committed",
      () => "rejected",
    )
    await started.promise
    messages.push({ role: "user", content: "A new prompt arrived" })
    const current = structuredClone(messages)
    release.resolve()
    expect(await outcome).toBe("rejected")
    expect(messages).toEqual(current)
    expect(records).toHaveLength(0)
  })
  it("positions the replay compact boundary at the real display-fold index", () => {
    const records: SessionRecord[] = [
      { kind: "user", ts: "t", content: "first", id: "u1" },
      {
        kind: "assistant",
        ts: "t",
        content: [{ type: "tool_use", id: "tu1", name: "Read", input: {} }],
        stopReason: "tool_use",
      },
      {
        kind: "tool_result",
        ts: "t",
        tool_use_id: "tu1",
        isError: false,
        content: [{ type: "text", text: "data" }],
      },
      {
        kind: "assistant",
        ts: "t",
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
      },
      {
        kind: "compact",
        ts: "t",
        reason: "manual",
        compactKind: "local",
        messagesBefore: 4,
        messagesAfter: 1,
        replacementMessages: [{ role: "user", content: [{ type: "text", text: "checkpoint" }] }],
      },
      { kind: "user", ts: "t", content: "after", id: "u2" },
    ]
    const compactIndex = records.findIndex((r) => r.kind === "compact")
    const boundaries = compactDisplayBoundaries(records)
    expect(boundaries).toHaveLength(1)
    expect(boundaries[0].afterMessageIndex).toBe(
      foldRecordsForDisplay(records.slice(0, compactIndex)).length,
    )
  })
})

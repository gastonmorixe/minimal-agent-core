/**
 * Compaction telemetry goes through the injected `pluginEvents` port (spec
 * S28, S47). The local summary stream sends `llm.outputDelta` and
 * `llm.outputEnd` to the port. It never reads the module plugin bus.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { getGlobalEventBus, setGlobalEventBus } from "../bus/global-bus.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents } from "../llm/test-fixtures.ts"
import { LLM_OUTPUT_DELTA, LLM_OUTPUT_END } from "../llm/transport/stream-delta.ts"
import { NetworkClient, NetworkResponse } from "../network/index.ts"
import { EventBus } from "../plugins/event-bus.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import { runCompact } from "./run-compact.ts"

const PROVIDER = "compact-events-prov"
const MODEL = "compact-events-model"

function hist(): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "user", content: `u${i}` })
    messages.push({ role: "assistant", content: `a${i}` })
  }
  return messages
}

function summaryEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_compact_events",
      modelId: MODEL,
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "message_stop" },
  ]
}

function summaryClient(): NetworkClient {
  return new NetworkClient({
    primary: {
      id: "fake",
      request: async () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream", "request-id": "req_compact_events" },
          transport: { id: "fake", protocol: "h2" },
          body: sseBodyFromEvents(summaryEvents("summary-text-for-events")),
        }),
    },
  })
}

function recordingPort(): { port: PluginEventsPort; events: string[] } {
  const events: string[] = []
  const port: PluginEventsPort = {
    emit: (event) => {
      events.push(event)
    },
  }
  return { port, events }
}

/** A module plugin bus that records every event it gets. */
function installGlobalBus(): string[] {
  const seen: string[] = []
  const bus = new EventBus()
  for (const ch of [LLM_OUTPUT_DELTA, LLM_OUTPUT_END]) {
    bus.on(ch, () => {
      seen.push(ch)
    })
  }
  setGlobalEventBus(bus)
  return seen
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("runCompact pluginEvents port (S28)", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    registerTestProvider({
      id: PROVIDER,
      displayName: "Compact Events Prov",
      shortCode: "cep",
      models: [{ id: MODEL }],
    })
  })

  afterEach(() => {
    setGlobalEventBus(null)
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("sends the local summary output events to the injected port only", async () => {
    const globalSeen = installGlobalBus()
    const { port, events } = recordingPort()
    const stats = await runCompact({
      lifecycle: NOOP_LIFECYCLE,
      messages: hist(),
      model: MODEL,
      providerId: PROVIDER,
      auth: { type: "api-key", token: "x" },
      reason: "manual",
      mode: "local",
      networkClient: summaryClient(),
      pluginEvents: port,
    })
    await flush()
    expect(stats.summaryText ?? "").toContain("summary-text-for-events")
    expect(events).toContain(LLM_OUTPUT_DELTA)
    expect(events.at(-1)).toBe(LLM_OUTPUT_END)
    expect(globalSeen).toEqual([])
    expect(getGlobalEventBus()).not.toBeNull()
  })

  it("with no port, compaction sends no event to the module bus", async () => {
    const globalSeen = installGlobalBus()
    await runCompact({
      lifecycle: NOOP_LIFECYCLE,
      messages: hist(),
      model: MODEL,
      providerId: PROVIDER,
      auth: { type: "api-key", token: "x" },
      reason: "manual",
      mode: "local",
      networkClient: summaryClient(),
    })
    await flush()
    expect(globalSeen).toEqual([])
  })

  it("AgentCore.compact forwards the construction-time pluginEvents port", async () => {
    const { port, events } = recordingPort()
    const core = await buildTestCore({
      auth: { type: "api-key", token: "x" },
      model: MODEL,
      providerId: PROVIDER,
      networkClient: summaryClient(),
      initialMessages: hist(),
      pluginEvents: port,
    })
    await core.compact({ mode: "local" })
    expect(events).toContain(LLM_OUTPUT_DELTA)
    expect(events.at(-1)).toBe(LLM_OUTPUT_END)
  })
})

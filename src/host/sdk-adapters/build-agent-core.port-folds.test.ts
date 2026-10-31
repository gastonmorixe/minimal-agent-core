/**
 * Correctness tests for the S34 exports-gap decision's 4
 * `build-agent-core.ts` PORT folds (the 5th, CommandRegistry's dispatch
 * fold, has its own test next to `plugins/loader/commands.ts`). Each test
 * drives a real `buildAgentCore` / `openAgentCoreSession` call end to end
 * (a real `AgentCore.run()` through a fake transport, not just a type
 * check) and asserts the internal wiring actually took effect.
 *
 * @module host/sdk-adapters/build-agent-core.port-folds.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  clearTurnAttachmentFactories,
  registerTurnAttachmentFactory,
} from "../../agent/turn-attachments.ts"
import type { AuthResult } from "../../auth/auth.ts"
import { defaultCapabilities } from "../../llm/capabilities.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../../llm/model-registry.ts"
import type { SendOptions, StreamedResponse } from "../../llm/transport/types.ts"
import {
  createContextCompactApi,
  takePendingCompact,
} from "../../plugins/host/providers/context-compact.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { ModelInfoSnapshot, SubagentModelRecommendation } from "../../plugins/types.ts"
import { computeStartupHashes } from "../startup/startup-hashes.ts"

import { buildAgentCore, openAgentCoreSession } from "./build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  for await (const chunk of gen) text += chunk
  return text
}

const OK_RESPONSE: StreamedResponse = {
  blocks: [{ type: "text", text: "ok" }],
  text: "ok",
  stopReason: "end_turn",
}

function fakeModel(id: string): ModelEntry {
  return {
    id,
    providerId: "build-agent-core-port-folds-test-prov",
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

function okSendFn(
  onSend?: (opts: SendOptions) => void,
): (opts: SendOptions) => AsyncGenerator<string, StreamedResponse, undefined> {
  return async function* (opts: SendOptions) {
    onSend?.(opts)
    yield "ok"
    return OK_RESPONSE
  }
}

describe("S34 PORT fold #1: turn-attachments instantiated internally", () => {
  afterEach(() => clearTurnAttachmentFactories())

  it("instantiates a registered factory's producer AND merges its drain with the explicit saveEcho, from a raw turnAttachmentContext", async () => {
    registerTurnAttachmentFactory("test/producer", () => ({
      toAttachment: () => ({ type: "text" as const, text: "MAGIC_PRODUCER_MARKER" }),
    }))
    registerTurnAttachmentFactory("test/drain", () => ({
      consumeAll: () => [{ type: "text" as const, text: "MAGIC_FACTORY_DRAIN_MARKER" }],
    }))

    let captured: SendOptions | undefined
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn((opts) => {
        captured = opts
      }),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      // Original contract fields stay populated (additive, not replaced):
      // a manually-pre-instantiated drain must still show up alongside the
      // ones the context instantiates.
      saveEcho: { consumeAll: () => [{ type: "text", text: "MAGIC_EXPLICIT_SAVEECHO_MARKER" }] },
      turnAttachments: [],
      turnAttachmentContext: { sessionId: "test-sid" },
    })
    await drain(core.run("go"))

    const sent = JSON.stringify(captured?.messages)
    expect(sent).toContain("MAGIC_PRODUCER_MARKER")
    expect(sent).toContain("MAGIC_FACTORY_DRAIN_MARKER")
    expect(sent).toContain("MAGIC_EXPLICIT_SAVEECHO_MARKER")
  })

  it("without turnAttachmentContext, behaves exactly like the original pre-instantiated contract (no factory reached)", async () => {
    registerTurnAttachmentFactory("test/unused", () => ({
      toAttachment: () => ({ type: "text" as const, text: "SHOULD_NOT_APPEAR" }),
    }))
    let captured: SendOptions | undefined
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn((opts) => {
        captured = opts
      }),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [{ toAttachment: () => ({ type: "text", text: "EXPLICIT_ONLY_MARKER" }) }],
      // turnAttachmentContext omitted on purpose.
    })
    await drain(core.run("go"))
    const sent = JSON.stringify(captured?.messages)
    expect(sent).toContain("EXPLICIT_ONLY_MARKER")
    expect(sent).not.toContain("SHOULD_NOT_APPEAR")
  })
})

describe("S34 PORT fold #4: compactSource wired by default, overridable", () => {
  it("defaults to the plugin host's pending-compact queue when no override is given", async () => {
    takePendingCompact() // drain any stray state from another test.
    const queued = createContextCompactApi().requestCompact({ reason: "manual", mode: "local" })
    expect(queued).toEqual({ queued: true })

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn(),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    let compactCalled = false
    const originalCompact = core.compact.bind(core)
    core.compact = async (opts?: Parameters<typeof originalCompact>[0]) => {
      compactCalled = true
      return originalCompact(opts)
    }
    await drain(core.run("go"))
    expect(compactCalled).toBe(true)
  })

  it("a caller-supplied compactSource overrides the plugin-host queue default", async () => {
    takePendingCompact() // ensure the plugin-host queue is empty (it must NOT be consulted).
    let takeCalls = 0
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn(),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      compactSource: {
        take: () => {
          takeCalls += 1
          return { reason: "manual", mode: "local" }
        },
      },
    })
    let compactCalled = false
    const originalCompact = core.compact.bind(core)
    core.compact = async (opts?: Parameters<typeof originalCompact>[0]) => {
      compactCalled = true
      return originalCompact(opts)
    }
    await drain(core.run("go"))
    expect(takeCalls).toBeGreaterThan(0)
    expect(compactCalled).toBe(true)
  })
})

describe("S34 PORT fold #2: ModelInfo data source wired internally when opted in", () => {
  afterEach(() => {
    clearModelRegistry()
  })

  it("wires setModelInfoSource with closures tracking the live model, and leaves it alone when not opted in", async () => {
    registerModel(fakeModel("switched-model"))
    const calls: Array<[unknown, unknown]> = []
    const fakeLoader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
      setModelInfoSource: (
        modelInfoProvider?: () => ModelInfoSnapshot | undefined,
        recommendSubagentModels?: () => SubagentModelRecommendation[],
      ) => {
        calls.push([modelInfoProvider, recommendSubagentModels])
      },
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn(),
      loader: fakeLoader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      wireModelInfoSource: true,
    })

    expect(calls.length).toBe(1)
    const [modelInfoProvider] = calls[0] as [() => ModelInfoSnapshot | undefined, unknown]
    expect(modelInfoProvider()?.modelId).toBe("test-model")
    // Live, not frozen at construction: a model switch is reflected.
    core.setModel("switched-model")
    expect(modelInfoProvider()?.modelId).toBe("switched-model")
  })

  it("does not call setModelInfoSource when wireModelInfoSource is unset (existing-caller behavior unchanged)", async () => {
    let called = false
    const fakeLoader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
      setModelInfoSource: () => {
        called = true
      },
    } as unknown as PluginLoader

    await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn(),
      loader: fakeLoader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    expect(called).toBe(false)
  })
})

describe("S34 PORT fold #3: openAgentCoreSession exposes startupHashes", () => {
  it("matches an equivalent direct computeStartupHashes call (same internal computation, not a second one)", async () => {
    const session = await openAgentCoreSession({
      auth: AUTH,
      model: "test-model",
      sendFn: okSendFn(),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    expect(typeof session.startupHashes.systemHash).toBe("string")
    expect(session.startupHashes.systemHash.length).toBeGreaterThan(0)
    expect(typeof session.startupHashes.toolsHash).toBe("string")

    const expected = await computeStartupHashes({
      loader: null,
      modeManager: null,
      selectedModelBase: "test-model",
      auth: AUTH,
      cacheTtl: "5m",
    })
    expect(session.startupHashes).toEqual(expected)
    await session.close?.()
  })
})

/**
 * The system prompt does not depend on the blob store.
 *
 * The request path (AgentCore, through `buildTurnSystemPrompt`) and the
 * startup hash (`computeStartupHashes`, via `openAgentCoreSession`) must give
 * the same system array with an enabled blob store, a disabled one, and none.
 * In every case the startup `systemHash` equals the hash of the sent array.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { setSystemPromptBase } from "../llm/system-prompt-base-registry.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"
import { createRuntime } from "../runtime/runtime.ts"
import type { ToolExecutor } from "../sdk/ports.ts"
import { BlobStore } from "../session/blob-store.ts"
import { shortHash } from "../session/session-store.ts"

import { computeStartupHashes, openAgentCoreSession } from "./assemble.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const ROOT = mkdtempSync(join(tmpdir(), "ma-blob-prompt-"))

/** A base provider with a data slot: core passes the ctx at each build. */
function holder(): SystemPromptBaseHolder {
  const h = createSystemPromptBaseHolder()
  registerSystemPromptBase(h, "stub-base", {
    slots: ["instructions"],
    identity: () => "STUB_IDENTITY",
    instructionParts: () => [{ slot: "instructions", text: "STUB_INSTRUCTIONS" }],
  })
  return h
}

let base: SystemPromptBaseHolder
let release: () => void

beforeEach(() => {
  // The request path reads the process holder; the hash reads the loader's.
  base = holder()
  release = setSystemPromptBase(base)
})
afterEach(() => release())
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

function loader(): PluginLoader {
  return {
    // An afterInstructions block makes the startup hash cover the system array.
    getPromptBlocksAsync: async () => ({ afterInstructions: "AFTER", sessionContext: null }),
    getPromptBlock: () => null,
    getExtraTools: () => [],
    getToolAliases: () => new Map<string, string>(),
    hasTool: () => false,
    systemPromptBase: () => base,
  } as unknown as PluginLoader
}

async function run(blobStore: BlobStore | null): Promise<{ sent: string; hash: string }> {
  let captured: unknown
  const sendFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    captured = opts.system
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const session = await openAgentCoreSession({
    auth: AUTH,
    model: "blob-prompt-unregistered-model",
    sendFn,
    loader: loader(),
    modeManager: null,
    store: null,
    blobStore,
    saveEcho: null,
    turnAttachments: [],
  })
  for await (const _entry of session.run("go")) {
    // drain
  }
  const hash = session.startupHashes.systemHash
  session.close()
  return { sent: JSON.stringify(captured), hash }
}

describe("the system prompt does not depend on the blob store", () => {
  it("blob store on, off and absent give the same sent array and startup hash", async () => {
    const on = await run(new BlobStore({ sid: "on", dir: join(ROOT, "on") }))
    const off = await run(
      new BlobStore({ sid: "off", dir: join(ROOT, "off"), config: { enabled: false } }),
    )
    const none = await run(null)
    expect(on.sent).toContain("STUB_INSTRUCTIONS")
    expect(off.sent).toBe(on.sent)
    expect(none.sent).toBe(on.sent)
    for (const r of [on, off, none]) expect(r.hash).toBe(shortHash(r.sent))
  })
})

/**
 * The port contract for a host that implements `ToolExecutor` itself (no
 * ToolExecutorAdapter): the startup hash matches the sent array.
 */
async function runCustom(executor: ToolExecutor): Promise<{ sent: string; hash: string }> {
  let captured: unknown
  const sendFn = async function* (
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    captured = opts.system
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const session = await createRuntime().openSession({
    auth: AUTH,
    model: "blob-prompt-unregistered-model",
    sendFn,
    toolExecutor: executor,
    promptContributors: [
      {
        afterInstructionsBlocks: () => [{ type: "text", text: "AFTER" }],
        systemPromptBase: () => base,
      },
    ],
    systemPrompt: "",
    maxTokens: 0,
    askUserFallback: "none",
  })
  for await (const _entry of session.run("go")) {
    // drain
  }
  session.close()
  const hash = (
    await computeStartupHashes({
      loader: loader(),
      modeManager: null,
      selectedModelBase: "blob-prompt-unregistered-model",
      auth: AUTH,
      cacheTtl: "1h",
    })
  ).systemHash
  return { sent: JSON.stringify(captured), hash }
}

const execute: ToolExecutor["execute"] = async () => ({ content: "", isError: false })

describe("custom ToolExecutor", () => {
  it("the startup hash matches the sent array", async () => {
    const { sent, hash } = await runCustom({ execute })
    expect(sent).toContain("STUB_INSTRUCTIONS")
    expect(hash).toBe(shortHash(sent))
  })
})

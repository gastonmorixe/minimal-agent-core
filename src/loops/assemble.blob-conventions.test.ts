/**
 * Follow-up 15b: the tool-output-conventions slot follows the real blob store.
 *
 * The request path (AgentCore, through `buildTurnSystemPrompt`) and the
 * startup hash (`computeStartupHashes`, via `openAgentCoreSession`) must read
 * the same blob-store value. With an enabled blob store the slot text is in
 * the sent system array; with none (or a disabled one) it is absent. In
 * every case the startup `systemHash` equals the hash of the sent array.
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
import { BlobStore } from "../session/blob-store.ts"
import { shortHash } from "../session/session-store.ts"

import { openAgentCoreSession } from "./assemble.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const CONVENTIONS = "TOOL_OUTPUT_CONVENTIONS_MARKER"
const ROOT = mkdtempSync(join(tmpdir(), "ma-blob-conventions-"))

/** A base provider that emits the conventions slot only when ctx says so. */
function holder(): SystemPromptBaseHolder {
  const h = createSystemPromptBaseHolder()
  registerSystemPromptBase(h, "stub-base", {
    // Data slots: core passes ctx (with blobStoreEnabled) at each build.
    slots: ["instructions", "toolOutputConventions"],
    identity: () => "STUB_IDENTITY",
    instructionParts: (ctx) => [
      { slot: "instructions", text: "STUB_INSTRUCTIONS" },
      ...(ctx?.blobStoreEnabled
        ? [{ slot: "toolOutputConventions" as const, text: CONVENTIONS }]
        : []),
    ],
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
    model: "blob-conventions-unregistered-model",
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

describe("tool-output-conventions slot follows the blob store (15b)", () => {
  it("blob store on: the slot is sent and the startup hash matches the sent array", async () => {
    const store = new BlobStore({ sid: "on", dir: join(ROOT, "on") })
    const { sent, hash } = await run(store)
    expect(sent).toContain(CONVENTIONS)
    expect(hash).toBe(shortHash(sent))
  })

  it("no blob store: the slot is absent and the startup hash matches the sent array", async () => {
    const { sent, hash } = await run(null)
    expect(sent).toContain("STUB_INSTRUCTIONS")
    expect(sent).not.toContain(CONVENTIONS)
    expect(hash).toBe(shortHash(sent))
  })

  it("disabled blob store: the slot is absent and the startup hash matches", async () => {
    const store = new BlobStore({ sid: "off", dir: join(ROOT, "off"), config: { enabled: false } })
    const { sent, hash } = await run(store)
    expect(sent).not.toContain(CONVENTIONS)
    expect(hash).toBe(shortHash(sent))
  })

  it("on and off give different startup hashes", async () => {
    const on = await run(new BlobStore({ sid: "on2", dir: join(ROOT, "on2") }))
    const off = await run(null)
    expect(on.hash).not.toBe(off.hash)
  })
})

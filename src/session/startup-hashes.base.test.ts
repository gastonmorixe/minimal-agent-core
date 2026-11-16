import { describe, expect, test } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import {
  createSystemPromptBaseHolder,
  registerSystemPromptBase,
  type SystemPromptBaseHolder,
} from "../plugins/system-prompt-base.ts"

import { computeStartupHashes } from "./startup-hashes.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

function holderOf(identity: string, instructions: string): SystemPromptBaseHolder {
  const holder = createSystemPromptBaseHolder()
  registerSystemPromptBase(holder, "stub", {
    identity: () => identity,
    instructionParts: () => [{ slot: "instructions", text: instructions }],
  })
  return holder
}

function loaderWith(holder?: SystemPromptBaseHolder): PluginLoader {
  return {
    getPromptBlocksAsync: async () => ({ afterInstructions: "x", sessionContext: null }),
    getPromptBlock: () => null,
    getExtraTools: () => [],
    ...(holder ? { systemPromptBase: () => holder } : {}),
  } as unknown as PluginLoader
}

async function systemHash(loader: PluginLoader): Promise<string> {
  const hashes = await computeStartupHashes({
    loader,
    modeManager: null,
    selectedModelBase: "base-hash-unregistered-model",
    auth: AUTH,
    cacheTtl: "5m",
  })
  return hashes.systemHash
}

describe("startup hash with the base holder of the loader", () => {
  test("an empty holder equals no holder (core holds no base text)", async () => {
    const plain = await systemHash(loaderWith())
    const withHolder = await systemHash(loaderWith(createSystemPromptBaseHolder()))
    expect(withHolder).toBe(plain)
  })

  test("a holder with different text changes the hash", async () => {
    const plain = await systemHash(loaderWith())
    const other = await systemHash(loaderWith(holderOf("HOLDER-IDENTITY", "HOLDER-INSTRUCTIONS")))
    expect(other).not.toBe(plain)
  })
})

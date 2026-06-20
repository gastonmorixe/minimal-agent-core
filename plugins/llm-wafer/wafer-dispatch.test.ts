/**
 * End-to-end dispatch disambiguation test.
 *
 * Proves that when both OpenCode and Wafer register the same bare model ID
 * (`deepseek-v4-flash`), the dispatch path (`run()`) resolves the correct
 * provider's adapter when `CanonicalRequest.providerId` is set.
 *
 * Uses a fake NetworkClient to suppress real HTTP calls.
 *
 * @module llm/providers/wafer/wafer-dispatch.test
 */

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  findModelForProvider,
} from "../../src/llm/model-registry.ts"
import { run } from "../../src/llm/run.ts"

import { bootstrapWafer } from "./adapter.ts"

async function bootstrapOpencode(): Promise<void> {
  const mod = await import("../llm-opencode/adapter.ts")
  mod.bootstrapOpencode()
}

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
}

/**
 * Fake network client that returns an error for ANY request. This
 * ensures the test never hits the real network, and the error message
 * comes from the adapter's own error path (taggedHttpError or equivalent
 * in OpenCode's case — either way the error carries the provider name).
 */
function fakeNet() {
  return {
    async request() {
      return {
        ok: false,
        status: 503,
        text: async () => '{"error":{"code":"server_error"}}',
        headers: new Headers(),
      }
    },
  } as unknown as import("../../src/network/index.ts").NetworkClient
}

describe("dispatch disambiguation: providerId on CanonicalRequest", () => {
  it("run() with providerId:'opencode' routes to OpenCode, not Wafer", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    const ocModel = findModelForProvider("deepseek-v4-flash", "opencode")
    const wfModel = findModelForProvider("deepseek-v4-flash", "wafer")
    expect(ocModel?.providerId).toBe("opencode")
    expect(wfModel?.providerId).toBe("wafer")

    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
      providerId: "opencode",
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "test-key" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // OpenCode adapter must be used, NOT Wafer
    expect(errorMessage).not.toMatch(/wafer/i)
  })

  it("run() with providerId:'wafer' routes to Wafer, not OpenCode", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
      providerId: "wafer",
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test-wf",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // Wafer adapter must be used, NOT OpenCode
    expect(errorMessage).toMatch(/wafer/i)
    expect(errorMessage).not.toMatch(/opencode/i)
  })

  it("run() without providerId uses global (last-registered, backwards compat)", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
      // No providerId
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "test" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test-legacy",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // Without providerId, falls back to global = last-registered = Wafer
    expect(errorMessage).toMatch(/wafer/i)
  })

  it("modelInfoSnapshot resolves correct provider via scoped lookup", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    const { buildModelInfoSnapshot } = await import("../../src/llm/model-info.ts")

    const ocSnapshot = buildModelInfoSnapshot("deepseek-v4-flash", "opencode")
    expect(ocSnapshot.providerId).toBe("opencode")
    expect(ocSnapshot.resolved).toBe(true)

    const wfSnapshot = buildModelInfoSnapshot("deepseek-v4-flash", "wafer")
    expect(wfSnapshot.providerId).toBe("wafer")
    expect(wfSnapshot.resolved).toBe(true)

    // Without providerId: falls back to global (last = Wafer)
    const unScoped = buildModelInfoSnapshot("deepseek-v4-flash")
    expect(unScoped.providerId).toBe("wafer")
  })

  it("modelShortLabel resolves correct provider via scoped lookup", async () => {
    setup()
    await bootstrapOpencode()
    bootstrapWafer()

    const { modelShortLabel } = await import("../../src/llm/model-label.ts")

    // Scoped for OpenCode → label uses OpenCode's identity
    const ocLabel = modelShortLabel("deepseek-v4-flash", "opencode")
    expect(ocLabel).toMatch(/opencode/i)
    expect(ocLabel).not.toMatch(/wafer/i)

    // Scoped for Wafer → label uses Wafer's identity, not OpenCode
    const wfLabel = modelShortLabel("deepseek-v4-flash", "wafer")
    expect(wfLabel).not.toMatch(/opencode/i)
    expect(wfLabel).toMatch(/wafer|wf/i)
  })
})

/**
 * Tests for `preflight-pipeline.ts` — the legacy↔canonical bridge that
 * the agent loop wraps around each sendFn call.
 *
 * Core-side seam test (Wave A unit A-4): drives the provider-neutral
 * pipeline against a synthetic in-test provider registered straight into
 * the canonical registries — no real provider import (invariant I2) and
 * no provider fingerprint (invariant I1). The fake `preflight()` flags a
 * stale thinking-block signature and `applyResolution()` handles the
 * three resolutions; the Anthropic signature-decoding specifics live in
 * `plugins/llm-anthropic/`'s own preflight suites.
 *
 * Covers:
 *  - clean request (no provider issues) round-trips messages + model id
 *  - mismatch issue → user picks STRIP → messages stripped, same model
 *  - mismatch issue → user picks SWITCH → messages preserved, new model
 *  - mismatch issue → user Esc'd → cancelled = true, originals returned
 *  - explicit cancel option → cancelled = true
 *  - askUser is called once per issue
 *
 * @module agent/preflight-pipeline.test
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { Message } from "../client/types.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type {
  PreflightIssue,
  PreflightResolution,
  ProviderAdapter,
  ValidationResult,
} from "../llm/provider.ts"

import { runPreflightPipeline } from "./preflight-pipeline.ts"

// ---------------------------------------------------------------------------
// Synthetic preflight provider (neutral — I1/I2 clean)
// ---------------------------------------------------------------------------

const ISSUE_STALE_SIGNATURE = "test.thinking-signature-mismatch"
const OPTION_STRIP = "strip"
const OPTION_SWITCH_PREFIX = "switch:"
const OPTION_CANCEL = "cancel"
const STALE_SIGNATURE = "sig-from-another-model"

function fakeModel(id: string): ModelEntry {
  return {
    id,
    providerId: "test-prov",
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

/**
 * Register a synthetic provider whose `preflight()` flags any assistant
 * thinking block carrying {@link STALE_SIGNATURE}, plus two neutral
 * models so a `switch` resolution has somewhere to land.
 */
function registerFakePreflightProvider(): void {
  registerModel(fakeModel("test-model-1"))
  registerModel(fakeModel("test-model-2"))

  const adapter: ProviderAdapter = {
    id: "test-prov",
    displayName: "Test Provider",
    surfaces: ["custom"],
    validate(): ValidationResult {
      return { ok: true, errors: [] }
    },
    async *run() {
      throw new Error("fake preflight provider: run() is not exercised by these tests")
    },
    preflight(req: CanonicalRequest): PreflightIssue[] {
      const stale = req.messages.some(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "thinking" && b.signature === STALE_SIGNATURE),
      )
      if (!stale) return []
      return [
        {
          code: ISSUE_STALE_SIGNATURE,
          title: "Stale reasoning from a different model",
          detail: "History contains thinking signed by another model.",
          options: [
            { id: OPTION_STRIP, label: "Strip" },
            { id: `${OPTION_SWITCH_PREFIX}test-model-2`, label: "Switch" },
            { id: OPTION_CANCEL, label: "Cancel" },
          ],
        },
      ]
    },
    applyResolution(
      req: CanonicalRequest,
      issueCode: string,
      optionId: string,
    ): PreflightResolution {
      if (issueCode !== ISSUE_STALE_SIGNATURE) throw new Error(`unknown issue code: ${issueCode}`)
      if (optionId === OPTION_CANCEL) return { kind: "cancel" }
      if (optionId === OPTION_STRIP) {
        const messages = req.messages.map((m) =>
          m.role === "assistant" && Array.isArray(m.content)
            ? { ...m, content: m.content.filter((b) => b.type !== "thinking") }
            : m,
        )
        return { kind: "modify-request", request: { ...req, messages } }
      }
      if (optionId.startsWith(OPTION_SWITCH_PREFIX)) {
        const adoptModelId = optionId.slice(OPTION_SWITCH_PREFIX.length)
        return { kind: "modify-request", request: req, adoptModelId }
      }
      throw new Error(`unknown option id: ${optionId}`)
    },
  }
  registerProvider(adapter)
}

function makeMessages(opts: { withMismatch: boolean }): Message[] {
  if (!opts.withMismatch) {
    return [{ role: "user", content: [{ type: "text", text: "hi" }] }]
  }
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old reasoning", signature: STALE_SIGNATURE },
        { type: "text", text: "ok" },
      ],
    },
  ]
}

describe("runPreflightPipeline", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  test("no provider registered → no issues, round-trips inputs", async () => {
    let askCalls = 0
    const out = await runPreflightPipeline({
      messages: makeMessages({ withMismatch: false }),
      modelId: "test-model-1",
      askUser: async () => {
        askCalls++
        return null
      },
    })
    expect(askCalls).toBe(0)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("test-model-1")
  })

  test("provider registered, clean messages → no issues", async () => {
    registerFakePreflightProvider()
    let askCalls = 0
    const out = await runPreflightPipeline({
      messages: makeMessages({ withMismatch: false }),
      modelId: "test-model-1",
      askUser: async () => {
        askCalls++
        return null
      },
    })
    expect(askCalls).toBe(0)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("test-model-1")
    expect(out.adoptModelId).toBeUndefined()
  })

  test("mismatch + STRIP → strips thinking, same model", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    let askCalls = 0
    let seenIssueCode = ""
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async (issue) => {
        askCalls++
        seenIssueCode = issue.code
        return OPTION_STRIP
      },
    })
    expect(askCalls).toBe(1)
    expect(seenIssueCode).toBe(ISSUE_STALE_SIGNATURE)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("test-model-1")
    expect(out.adoptModelId).toBeUndefined()
    // Stripped: only text block remains in the assistant message.
    const asst = out.messages[1]
    expect(asst?.role).toBe("assistant")
    const blocks = Array.isArray(asst?.content) ? asst.content : []
    expect(blocks.map((b) => b.type)).toEqual(["text"])
  })

  test("mismatch + SWITCH → adopts model, preserves thinking", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async () => `${OPTION_SWITCH_PREFIX}test-model-2`,
    })
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("test-model-2")
    expect(out.adoptModelId).toBe("test-model-2")
    const asst = out.messages[1]
    const blocks = Array.isArray(asst?.content) ? asst.content : []
    // Thinking + text both still there.
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text"])
  })

  test("mismatch + user-cancel (askUser returns null) → cancelled", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async () => null,
    })
    expect(out.cancelled).toBe(true)
    // Originals returned untouched.
    expect(out.messages).toBe(msgs)
    expect(out.modelId).toBe("test-model-1")
  })

  test("mismatch + explicit CANCEL option → cancelled", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async () => OPTION_CANCEL,
    })
    expect(out.cancelled).toBe(true)
    expect(out.messages).toBe(msgs)
  })

  test("askUser receives the full issue, including detail + options", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    type Capture = { code: string; title: string; detail: string; optCount: number }
    let captured: Capture | null = null
    await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async (issue) => {
        captured = {
          code: issue.code,
          title: issue.title,
          detail: issue.detail,
          optCount: issue.options.length,
        } as Capture
        return null
      },
    })
    expect(captured).not.toBeNull()
    const c = captured as unknown as Capture
    expect(c.code).toBe(ISSUE_STALE_SIGNATURE)
    expect(c.title).toMatch(/different model/i)
    expect(c.optCount).toBe(3)
  })

  test("does not mutate the input messages array", async () => {
    registerFakePreflightProvider()
    const msgs = makeMessages({ withMismatch: true })
    const before = JSON.stringify(msgs)
    await runPreflightPipeline({
      messages: msgs,
      modelId: "test-model-1",
      askUser: async () => OPTION_STRIP,
    })
    expect(JSON.stringify(msgs)).toBe(before)
  })
})

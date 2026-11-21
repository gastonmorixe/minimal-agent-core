/**
 * Hook `additionalContext` on the tool result, and the `sid` / `mode` /
 * `isError` facts on the tool hook payloads.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import type { ModeManager } from "../modes/modes.ts"
import {
  allowDecision,
  denyDecision,
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type ToolWillInvokePayload,
} from "../sdk/lifecycle.ts"
import type { ToolDidInvokePayload } from "../sdk/tool-lifecycle.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

/** The real codec (sibling checkout), else `NO_SIDEBAND`: the core tags render here. */
const SB = fixtureSidebandOrNone()
/** `describe` for the tests that pin the bytes of a core tag. */
const describeSb = describe.skipIf(!sidebandFixturePresent())

const TMP_BASE = join(import.meta.dirname, "..", "..", "tmp")
mkdirSync(TMP_BASE, { recursive: true })
const TMP_ROOT = mkdtempSync(join(TMP_BASE, "ma-round-ctx-"))
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }))

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    sidebandApi: SB,
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

function writeTool(id: string): ToolUseBlock {
  const dir = mkdtempSync(join(TMP_ROOT, "ma-round-ctx-"))
  return {
    type: "tool_use",
    id,
    name: "Write",
    input: { file_path: join(dir, "a.txt"), content: "x\n" },
  }
}

function missingReadTool(id: string): ToolUseBlock {
  const dir = mkdtempSync(join(TMP_ROOT, "ma-round-ctx-"))
  return { type: "tool_use", id, name: "Read", input: { file_path: join(dir, "missing.txt") } }
}

const policy = (s: string) => `<ma::agent::policy>${s}</ma::agent::policy>`

describeSb("executeToolRound — hook additionalContext", () => {
  test("tool.willInvoke context is appended to the tool result", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision(p, ["pre context"])
      },
    }
    const result = await executeToolRound(writeTool("tu_pre"), baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(String(result.content)).toContain(policy("pre context"))
  })

  test("tool.willInvoke context is appended on the denied path", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool() {
        return denyDecision<ToolWillInvokePayload>("blocked", undefined, ["deny context"])
      },
    }
    const result = await executeToolRound(writeTool("tu_deny"), baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    const content = String(result.content)
    expect(content).toContain("blocked")
    expect(content).toContain(policy("deny context"))
  })

  test("tool.didInvoke context is appended to the tool result", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async afterTool(p) {
        return { ...p, additionalContext: ["post context", "  "] }
      },
    }
    const result = await executeToolRound(writeTool("tu_post"), baseCtx({ lifecycle }))
    const content = String(result.content)
    expect(content).toContain(policy("post context"))
    // Blank context strings are dropped.
    expect(content).not.toContain(policy("  "))
  })

  test("willInvoke context comes before didInvoke context", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision(p, ["first"])
      },
      async afterTool(p) {
        return { ...p, additionalContext: ["second"] }
      },
    }
    const content = String(
      (await executeToolRound(writeTool("tu_both"), baseCtx({ lifecycle }))).content,
    )
    expect(content.indexOf(policy("first"))).toBeGreaterThan(-1)
    expect(content.indexOf(policy("second"))).toBeGreaterThan(content.indexOf(policy("first")))
  })
})

describe("executeToolRound — tool hook payload facts", () => {
  test("no sid on the round context gives no sid on the payloads", async () => {
    const will: ToolWillInvokePayload[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        will.push(p)
        return allowDecision(p)
      },
    }
    await executeToolRound(writeTool("tu_nosid"), baseCtx({ lifecycle }))
    expect(will[0]?.sid).toBeUndefined()
  })

  test("didInvoke payload: isError false on success, with sid and mode", async () => {
    const seen: ToolDidInvokePayload[] = []
    const will: ToolWillInvokePayload[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        will.push(p)
        return allowDecision(p)
      },
      async afterTool(p) {
        seen.push(p)
        return p
      },
    }
    const modeManager = {
      isToolAllowed: () => ({ allowed: true as const }),
      activeId: () => "ask",
      buildActiveModeStamp: () => null,
      activeStampFacts: () => null,
    } as unknown as ModeManager
    await executeToolRound(
      writeTool("tu_ok"),
      baseCtx({ lifecycle, modeManager, sid: "sid-of-this-session" }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.ok).toBe(true)
    expect(seen[0]?.isError).toBe(false)
    expect(seen[0]?.sid).toBe("sid-of-this-session")
    expect(seen[0]?.agentMode).toBe("ask")
    expect(will[0]?.sid).toBe("sid-of-this-session")
    expect(will[0]?.agentMode).toBe("ask")
  })

  test("didInvoke payload: isError true on a failed tool, no agentMode when none is active", async () => {
    const seen: ToolDidInvokePayload[] = []
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async afterTool(p) {
        seen.push(p)
        return p
      },
    }
    const result = await executeToolRound(missingReadTool("tu_err"), baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.ok).toBe(false)
    expect(seen[0]?.isError).toBe(true)
    expect(seen[0]?.agentMode).toBeUndefined()
  })
})

function pngBytes(): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 12
  b[23] = 12
  return b
}

describeSb("executeToolRound — hook context on a block-array result", () => {
  afterEach(() => clearModelRegistry())

  test("will/didInvoke context rides in a text block next to the image", async () => {
    registerModel({
      id: "ctx-vision-model",
      providerId: "testprov",
      surfaceId: "test-surface",
      displayName: "ctx-vision-model",
      capabilities: {
        ...defaultCapabilities(),
        contextWindow: 200_000,
        maxOutputTokens: 8_000,
        modalities: { image: true, audio: false, pdf: false, video: false },
      },
      pricing: {
        inputUSD: 1,
        outputUSD: 1,
        cacheWriteUSD: 1,
        cacheReadUSD: 1,
        webSearchPerCallUSD: 0,
      },
    })
    const dir = mkdtempSync(join(TMP_ROOT, "ma-round-ctx-"))
    const file = join(dir, "a.png")
    writeFileSync(file, pngBytes())
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision(p, ["pre image"])
      },
      async afterTool(p) {
        return { ...p, additionalContext: ["post image"] }
      },
    }
    const result = await executeToolRound(
      { type: "tool_use", id: "tu_img", name: "Read", input: { file_path: file } },
      baseCtx({ lifecycle, model: "ctx-vision-model" }),
    )
    expect(Array.isArray(result.content)).toBe(true)
    const blocks = result.content as ContentBlock[]
    expect(blocks.some((b) => b.type === "image")).toBe(true)
    const text = blocks
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    expect(text).toContain(policy("pre image"))
    expect(text).toContain(policy("post image"))
  })
})

describe("executeToolRound — hook context with no codec (NO_SIDEBAND)", () => {
  test("the hook context lines reach the model with no wrapper, one line each", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision(p, ["pre context"])
      },
      async afterTool(p) {
        return { ...p, additionalContext: ["post context"] }
      },
    }
    const bare = await executeToolRound(
      writeTool("tu_nosb_ref"),
      baseCtx({ sidebandApi: NO_SIDEBAND }),
    )
    const result = await executeToolRound(
      writeTool("tu_nosb"),
      baseCtx({ lifecycle, sidebandApi: NO_SIDEBAND }),
    )
    const content = String(result.content)
    expect(content).not.toContain("<")
    expect(content.endsWith("\npre context\npost context")).toBe(true)
    // The call with no hook context, plus one line for each note (paths differ, so compare shape).
    expect(content.split("\n").length).toBe(String(bare.content).split("\n").length + 2)
  })
})

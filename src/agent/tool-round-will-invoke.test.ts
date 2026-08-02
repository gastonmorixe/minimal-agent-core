import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { ToolUseBlock } from "../llm/messages.ts"
import {
  allowDecision,
  denyDecision,
  type LifecyclePort,
  NOOP_LIFECYCLE,
} from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    presentation: new Map(),
    writeTranscript: () => {},
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: null,
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

describe("executeToolRound — tool.willInvoke", () => {
  test("deny prevents Write IO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-"))
    const path = join(dir, "secret.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool() {
        return denyDecision("no writes in this test")
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_deny",
      name: "Write",
      input: { file_path: path, content: "should-not-land\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBe(true)
    expect(String(result.content)).toContain("no writes")
    expect(existsSync(path)).toBe(false)
  })

  test("rewrite changes Write path (updatedInput)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-willinvoke-rw-"))
    const original = join(dir, "orig.txt")
    const rewritten = join(dir, "safe.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        return allowDecision({
          ...p,
          input: { ...p.input, file_path: rewritten, content: "rewritten\n" },
        })
      },
    }
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_rw",
      name: "Write",
      input: { file_path: original, content: "orig\n" },
    }
    const result = await executeToolRound(tool, baseCtx({ lifecycle }))
    expect(result.is_error).toBeFalsy()
    expect(existsSync(original)).toBe(false)
    expect(readFileSync(rewritten, "utf8")).toBe("rewritten\n")
  })
})

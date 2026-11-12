import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function run(lifecycle: LifecyclePort, path: string) {
  const events: ToolViewEvent[] = []
  const ctx: ToolRoundContext = {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle,
    toolView: {
      onToolEvent(event) {
        events.push(event)
      },
    },
  }
  const tool: ToolUseBlock = {
    type: "tool_use",
    id: "tu_hook_failed",
    name: "Write",
    input: { file_path: path, content: "payload\n" },
  }
  return { events, result: executeToolRound(tool, ctx) }
}

function throwing(thrown: unknown, failClosed: boolean | undefined): LifecyclePort {
  return {
    ...NOOP_LIFECYCLE,
    ...(failClosed === undefined ? {} : { hasFailClosedToolHook: () => failClosed }),
    async beforeTool() {
      throw thrown
    },
  }
}

describe("executeToolRound: policy hook failed", () => {
  test("policy hook failed text when emitChain throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-hook-failed-"))
    const path = join(dir, "gated.txt")
    const { result } = run(throwing(new Error("boom"), true), path)
    const out = await result
    expect(out.is_error).toBe(true)
    expect(out.content).toBe(
      "Tool blocked by lifecycle policy hook. The approval hook failed (boom).",
    )
    expect(existsSync(path)).toBe(false)
  })

  test("a non-Error thrown value is stringified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-hook-failed-str-"))
    const { result } = run(throwing("plain", true), join(dir, "gated.txt"))
    const out = await result
    expect(out.is_error).toBe(true)
    expect(out.content).toBe(
      "Tool blocked by lifecycle policy hook. The approval hook failed (plain).",
    )
  })

  test("without a fail-closed hook the failure is swallowed and the tool runs", async () => {
    for (const failClosed of [false, undefined]) {
      const dir = mkdtempSync(join(tmpdir(), "ma-hook-failed-open-"))
      const path = join(dir, "open.txt")
      const { events, result } = run(throwing(new Error("boom"), failClosed), path)
      const out = await result
      expect(out.is_error).toBeFalsy()
      expect(String(out.content)).not.toContain("approval hook failed")
      expect(readFileSync(path, "utf8")).toBe("payload\n")
      expect(events.some((e) => e.type === "refused")).toBe(false)
    }
  })

  test("the refused event carries refusedBy policy and the same message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-hook-failed-evt-"))
    const { events, result } = run(throwing(new Error("boom"), true), join(dir, "g.txt"))
    const out = await result
    const refused = events.filter((e) => e.type === "refused")
    expect(refused).toHaveLength(1)
    const ev = refused[0] as Extract<ToolViewEvent, { type: "refused" }>
    expect(ev.refusedBy).toBe("policy")
    expect(ev.message).toBe(out.content as string)
  })
})

/**
 * The tool round passes the persisted outcome to the session store as the
 * 4th argument of `appendToolResult` (join of M1 and M2, SPEC D8).
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { PersistedToolOutcome } from "../../plugin-api/src/types/tool-outcome-record.ts"
import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { outcomeTextOf } from "../sdk/tool-outcome-record.ts"
import type { SessionStore } from "../session/session-store.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

type AppendArgs = [
  ToolResultBlock,
  Date | undefined,
  { path: string; bytes: number; sha256: string } | undefined,
  PersistedToolOutcome | undefined,
]

/** A store that records the arguments of each `appendToolResult` call. */
function spyStore(): { calls: AppendArgs[]; store: SessionStore } {
  const calls: AppendArgs[] = []
  const store = {
    appendToolResult: (...args: AppendArgs) => {
      calls.push(args)
    },
  } as unknown as SessionStore
  return { calls, store }
}

function ctxWith(store: SessionStore): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store,
    lifecycle: NOOP_LIFECYCLE,
  }
}

function readTool(): ToolUseBlock {
  const dir = mkdtempSync(join(tmpdir(), "ma-persist-outcome-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return { type: "tool_use", id: "tu_persist", name: "Read", input: { file_path: path } }
}

describe("tool round persists the outcome", () => {
  test("a text result: the store gets a record that fits the block text", async () => {
    const { calls, store } = spyStore()
    const block = await executeToolRound(readTool(), ctxWith(store))
    expect(calls).toHaveLength(1)
    const [stored, , , rec] = calls[0] as AppendArgs
    expect(stored).toBe(block)
    expect(rec).toBeDefined()
    const text = outcomeTextOf(block.content)
    expect(rec?.bodyEnd).toBeGreaterThan(0)
    expect(rec?.bodyEnd).toBeLessThanOrEqual(text.length)
    for (const span of rec?.annotations ?? []) {
      expect(span.start).toBeGreaterThanOrEqual(rec?.bodyEnd ?? 0)
      expect(span.end).toBeLessThanOrEqual(text.length)
    }
  })
})

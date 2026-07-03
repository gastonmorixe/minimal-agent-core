/**
 * End-to-end test for the model-fork bug fix using a real session
 * fixture extracted from the original report (cc53c9fe).
 *
 * The fixture is `__fixtures__/forked-session-mixed-models.jsonl` :
 * 5 records (1 meta + 2 user + 3 assistant) trimmed down to the bytes
 * that matter for the preflight check (thinking-block signatures are
 * preserved verbatim from the real session). Loading it through
 * `loadSessionFromText` exercises the actual restore pipeline.
 *
 * What we verify here:
 *
 *  1. The restored session has thinking blocks signed by
 *     `claude-opus-4-7` (the bug's prerequisite).
 *  2. The preflight pipeline catches the mismatch when the user resumes
 *     with `claude-opus-4-8` and surfaces ONE issue with three options
 *     (STRIP / SWITCH back / CANCEL).
 *  3. The STRIP resolution removes the stale thinking blocks from the
 *     LATEST assistant message (the one the Anthropic server would
 *     reject) AND from earlier assistant messages.
 *  4. The SWITCH resolution preserves all thinking blocks AND signals
 *     the agent to adopt the original model.
 *
 * This is the regression test for the user's report ("we have this
 * bug again"). If a future change breaks the model-fork detection,
 * this test fails before the user sees a 400.
 *
 * @module llm/providers/anthropic/forked-session.e2e.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import { runPreflightPipeline } from "../../src/agent/preflight-pipeline.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../src/llm/model-registry.ts"
import { loadSessionFromText } from "../../src/session/session-restore.ts"

import { bootstrapAnthropic } from "./adapter.ts"
import { extractModelFromSignature } from "./signature-model.ts"
import {
  ISSUE_THINKING_MODEL_MISMATCH,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
} from "./thinking-preflight.ts"

const FIXTURE_PATH = join(import.meta.dir, "__fixtures__", "forked-session-mixed-models.jsonl")

function loadFixtureSession() {
  const text = readFileSync(FIXTURE_PATH, "utf-8")
  return loadSessionFromText(text)
}

describe("forked-session-mixed-models.jsonl (real cc53c9fe extract)", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  test("fixture loads with all thinking blocks signed by claude-opus-4-7", () => {
    const { messages } = loadFixtureSession()
    expect(messages.length).toBeGreaterThan(0)

    let thinkingCount = 0
    let mismatchCount = 0
    for (const m of messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b.type !== "thinking") continue
        thinkingCount++
        const decoded = extractModelFromSignature(b.signature)
        if (decoded === "claude-opus-4-7") mismatchCount++
      }
    }
    expect(thinkingCount).toBeGreaterThan(0)
    expect(mismatchCount).toBe(thinkingCount)
  })

  test("preflight catches the mismatch when continuing with claude-opus-4-8", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    let askCalled = 0
    let seenIssueCode = ""
    let seenOptionIds: string[] = []

    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-8",
      askUser: async (issue) => {
        askCalled++
        seenIssueCode = issue.code
        seenOptionIds = issue.options.map((o) => o.id)
        // Cancel so we don't mutate anything.
        return null
      },
    })

    expect(askCalled).toBe(1)
    expect(seenIssueCode).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(seenOptionIds[0]).toBe(OPTION_STRIP)
    expect(seenOptionIds[seenOptionIds.length - 1]).toBe(OPTION_CANCEL)
    expect(seenOptionIds).toContain(`${OPTION_SWITCH_PREFIX}claude-opus-4-7`)
    expect(out.cancelled).toBe(true)
  })

  test("STRIP resolution removes thinking blocks; resulting messages have NO thinking", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-8",
      askUser: async () => OPTION_STRIP,
    })
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-8")
    // Walk the resolved messages and verify NO thinking blocks remain.
    let remaining = 0
    for (const m of out.messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b.type === "thinking") remaining++
      }
    }
    expect(remaining).toBe(0)
  })

  test("SWITCH resolution preserves thinking + adopts claude-opus-4-7", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-8",
      askUser: async () => `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
    })
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-7")
    expect(out.adoptModelId).toBe("claude-opus-4-7")
    // Thinking blocks preserved.
    let preserved = 0
    for (const m of out.messages) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue
      for (const b of m.content) {
        if (b.type === "thinking") preserved++
      }
    }
    expect(preserved).toBeGreaterThan(0)
  })

  test("CANCEL resolution leaves messages and model unchanged", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-8",
      askUser: async () => OPTION_CANCEL,
    })
    expect(out.cancelled).toBe(true)
    expect(out.messages).toBe(messages)
    expect(out.modelId).toBe("claude-opus-4-8")
  })

  test("continuing with the ORIGINAL model (claude-opus-4-7) → no issue", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    let askCalled = 0
    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-7",
      askUser: async () => {
        askCalled++
        return null
      },
    })
    expect(askCalled).toBe(0)
    expect(out.cancelled).toBe(false)
  })

  test("continuing with the ORIGINAL model + [1m] suffix → no issue", async () => {
    bootstrapAnthropic()
    const { messages } = loadFixtureSession()
    let askCalled = 0
    const out = await runPreflightPipeline({
      messages,
      modelId: "claude-opus-4-7[1m]",
      askUser: async () => {
        askCalled++
        return null
      },
    })
    expect(askCalled).toBe(0)
    expect(out.cancelled).toBe(false)
  })
})

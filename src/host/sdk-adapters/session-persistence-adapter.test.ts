/**
 * Unit tests for {@link SessionPersistenceAdapter}: user/assistant/note/rewind
 * delegate straight to the {@link SessionStore}, while `appendToolResult` is a
 * deliberate no-op (tool_result persistence is owned by the ToolExecutorAdapter
 * via executeToolRound, with blob + presentation fidelity).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { ContentBlock, ToolResultBlock } from "../../llm/messages.ts"
import { SessionStore } from "../../session/session-store.ts"

import { SessionPersistenceAdapter } from "./session-persistence-adapter.ts"

let dir: string
let store: SessionStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sdk-adapter-sess-"))
  store = SessionStore.open({
    sid: "test-sid",
    model: "test-model",
    cwd: "/tmp",
    systemHash: "sh",
    toolsHash: "th",
    agentVersion: "0.0.0-test",
    dir,
  })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Read the store's JSONL records back off disk. */
function records(): Array<{ kind: string; [k: string]: unknown }> {
  return readFileSync(store.path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe("SessionPersistenceAdapter", () => {
  it("delegates appendUser and returns the store-generated id", () => {
    const adapter = new SessionPersistenceAdapter(store)
    const content: ContentBlock[] = [{ type: "text", text: "hello" }]
    const id = adapter.appendUser(content)
    expect(typeof id).toBe("string")
    const userRecs = records().filter((r) => r.kind === "user")
    expect(userRecs.length).toBe(1)
    expect(userRecs[0]?.id).toBe(id)
  })

  it("delegates appendAssistant with stop reason + usage", () => {
    const adapter = new SessionPersistenceAdapter(store)
    adapter.appendAssistant([{ type: "text", text: "ok" }], "end_turn", {
      input_tokens: 3,
      output_tokens: 1,
    })
    const rec = records().find((r) => r.kind === "assistant")
    expect(rec?.stopReason).toBe("end_turn")
    expect(rec?.usage).toEqual({ input_tokens: 3, output_tokens: 1 })
  })

  it("does NOT persist tool_result (owned by the executor adapter)", () => {
    const adapter = new SessionPersistenceAdapter(store)
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "should not be written here",
      is_error: false,
    }
    adapter.appendToolResult(block)
    adapter.appendToolResult(block, { path: "/x", bytes: 1, sha256: "d" }, { display: "d" })
    // Zero tool_result records on disk from this adapter.
    expect(records().filter((r) => r.kind === "tool_result").length).toBe(0)
  })

  it("delegates appendNote and appendRewind", () => {
    const adapter = new SessionPersistenceAdapter(store)
    adapter.appendNote("a marker")
    adapter.appendRewind("msg-42", 3)
    const kinds = records().map((r) => r.kind)
    expect(kinds).toContain("note")
    expect(kinds).toContain("rewind")
    const rewind = records().find((r) => r.kind === "rewind")
    expect(rewind?.to).toBe("msg-42")
    expect(rewind?.droppedCount).toBe(3)
  })
})

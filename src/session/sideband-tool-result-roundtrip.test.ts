import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { canonicalMessageToLegacy, legacyMessageToCanonical } from "../llm/adapter-legacy.ts"
import type { Message, ToolResultBlock } from "../llm/messages.ts"

import { loadSession } from "./session-restore.ts"
import { SessionStore } from "./session-store.ts"

const baseOpenOpts = {
  model: "test-model",
  cwd: "/tmp/x",
  systemHash: "h",
  toolsHash: "h",
  agentVersion: "test",
}

function writeSession(sid: string, block: ToolResultBlock): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "ma-sb-tr-"))
  const store = SessionStore.open({ ...baseOpenOpts, sid, dir })
  store.appendUser("go")
  store.appendAssistant([{ type: "tool_use", id: "tu_1", name: "T", input: {} }], "tool_use")
  store.appendToolResult(block)
  store.appendAssistant([{ type: "text", text: "done" }], "end_turn")
  return { dir, path: store.path }
}

function restoredBlock(sid: string, dir: string): ToolResultBlock | undefined {
  const loaded = loadSession(sid, dir)
  for (const m of loaded.messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === "tool_result") return b
  }
  return undefined
}

describe("sideband on tool_result blocks", () => {
  it("(a) writes sideband to the JSONL record", () => {
    const { path } = writeSession("sb-a", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "ok",
      sideband: { kind: "x" },
    })
    expect(readFileSync(path, "utf-8")).toContain('"sideband"')
  })

  it("(b) restores sideband on the tool_result block", () => {
    const { dir } = writeSession("sb-b", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "ok",
      sideband: { kind: "x" },
    })
    expect(restoredBlock("sb-b", dir)?.sideband).toEqual({ kind: "x" })
  })

  it("(c) no sideband: record and block carry no sideband key", () => {
    const { dir, path } = writeSession("sb-c", {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: "ok",
    })
    expect(readFileSync(path, "utf-8")).not.toContain("sideband")
    const b = restoredBlock("sb-c", dir)
    expect(b).toBeDefined()
    expect(b !== undefined && "sideband" in b).toBe(false)
  })

  it("(d) legacy adapter round trip keeps sideband", () => {
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_1",
          content: "ok",
          sideband: { kind: "x" },
        },
      ],
    }
    const back = canonicalMessageToLegacy(legacyMessageToCanonical(msg))
    const content = back.content
    const b = Array.isArray(content) ? content[0] : undefined
    expect(b?.type === "tool_result" ? b.sideband : undefined).toEqual({ kind: "x" })
  })
})

/**
 * End-to-end session restore: write a session via the real Agent loop,
 * "crash" mid-tool, then resume from disk and continue another turn.
 * Verifies that:
 *
 *   1. Records hit disk at turn boundaries (not just at exit).
 *   2. A crashed session resumes to a valid messages prefix.
 *   3. The resumed agent continues appending to the SAME file.
 *   4. After resume + new turn, the full record sequence reads back correctly.
 */
import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { StreamedResponse } from "./client.ts"
import { loadSession } from "./session-restore.ts"
import { SessionStore } from "./session-store.ts"

const auth: AuthResult = { type: "api-key", token: "test" }
const baseOpenOpts = {
  model: "test-model",
  cwd: "/tmp/x",
  systemHash: "h",
  toolsHash: "h",
  agentVersion: "test",
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe("session restore E2E", () => {
  it("survives a crash mid-tool and resumes cleanly into a follow-up turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-e2e-"))
    const sid = "ma-e2e-crash"

    // ------- Run 1: agent issues a tool_use, then we "crash" before result -------
    {
      const store = SessionStore.open({ ...baseOpenOpts, sid, dir })

      // sendFn that returns a tool_use, then would yield text on round 2 —
      // but we abandon before round 2.
      let round = 0
      const sendFn = async function* () {
        round++
        if (round === 1) {
          return {
            blocks: [
              { type: "tool_use" as const, id: "tu_1", name: "NonExistentTool", input: {} },
            ],
            text: "",
            stopReason: "tool_use",
          } as StreamedResponse
        }
        // Hypothetical round 2 — we never reach it in run 1.
        yield "should-not-reach"
        return {
          blocks: [{ type: "text" as const, text: "x" }],
          text: "x",
          stopReason: "end_turn",
        } as StreamedResponse
      }
      const agent = new Agent({ auth, model: "test-model", sendFn, store })

      // Run the loop. The fake tool name will produce an error tool_result,
      // so the agent appends a tool_result and proceeds to round 2.
      // To simulate a CRASH between the tool_use append and the tool_result
      // append, we'd need to interrupt mid-loop — but executeTool runs
      // synchronously. Instead, we drop the tool_result record from disk
      // by hand to simulate the crash window.
      const gen = agent.run("go", { onTranscriptLine: () => {} })
      while (true) {
        const { done } = await gen.next()
        if (done) break
      }

      // At this point disk has: meta, user, assistant(tool_use), tool_result, assistant(text).
      // Simulate the crash: truncate the file so it ends after the
      // assistant(tool_use) record (i.e. tool_result + final assistant lost).
      const lines = readJsonl(store.path) as { kind: string }[]
      const cutoff = lines.findIndex(
        (r, i) =>
          r.kind === "assistant" &&
          // first assistant record (the one with tool_use)
          lines.slice(0, i).filter((p) => p.kind === "assistant").length === 0,
      )
      expect(cutoff).toBeGreaterThan(0)
      const truncated =
        readFileSync(store.path, "utf-8")
          .split("\n")
          .filter((l) => l.length > 0)
          .slice(0, cutoff + 1)
          .join("\n") + "\n"
      const fs = await import("node:fs")
      fs.writeFileSync(store.path, truncated)
    }

    // ------- Run 2: resume from disk and continue with a clean turn -------
    {
      const loaded = loadSession(sid, dir)
      // The crashed assistant(tool_use) had an unmatched tool_use → repair drops it.
      expect(loaded.repaired).toBe(true)
      expect(loaded.messages).toHaveLength(1)
      expect(loaded.messages[0].role).toBe("user")

      // Re-open store with existsOk so we keep appending.
      const store = SessionStore.open({ ...baseOpenOpts, sid, dir, existsOk: true })

      // Brand-new sendFn for the resumed run — single text reply.
      const sendFn = async function* () {
        yield "resumed reply"
        return {
          blocks: [{ type: "text" as const, text: "resumed reply" }],
          text: "resumed reply",
          stopReason: "end_turn",
        } as StreamedResponse
      }

      const agent = new Agent({
        auth,
        model: "test-model",
        sendFn,
        store,
        initialMessages: loaded.messages,
      })

      // Sanity: hydrated messages preserved.
      expect(agent.messages).toHaveLength(1)
      // Stored as content blocks: [{type:"text", text:"go"}]
      const firstContent = agent.messages[0].content
      expect(Array.isArray(firstContent)).toBe(true)
      expect((firstContent as Array<{ type: string; text?: string }>)[0].text).toBe("go")

      const gen = agent.run("hello again", { onTranscriptLine: () => {} })
      const out: string[] = []
      while (true) {
        const { done, value } = await gen.next()
        if (done) break
        out.push(value)
      }
      expect(out.join("")).toBe("resumed reply")

      // After resume + 1 turn, the agent's messages should be:
      //   user "go" (from run 1) — never replied to
      //   user "hello again"
      //   assistant "resumed reply"
      expect(agent.messages).toHaveLength(3)
      expect(agent.messages[1].role).toBe("user")
      expect(agent.messages[2].role).toBe("assistant")
    }

    // ------- Final disk state: meta + user(go) + user(hello again) + assistant(resumed reply) -------
    const finalLines = readJsonl(join(dir, `${sid}.jsonl`)) as { kind: string }[]
    // Note: the truncated file ends with assistant(tool_use). Resume doesn't
    // rewrite the file (append-only) — it just appends new turn records.
    // So the disk has: meta, user, assistant(tool_use), user(hello again),
    // assistant(resumed reply). The "ghost" assistant(tool_use) line is
    // physically present but `loadSession` will repair it again on next load.
    expect(finalLines.map((r) => r.kind)).toEqual([
      "meta",
      "user",
      "assistant", // the tool_use ghost that repair will drop on next load
      "user",
      "assistant",
    ])

    // Round-trip once more through loadSession to confirm the repair is
    // idempotent and the visible conversation is the clean one.
    const reloaded = loadSession(sid, dir)
    // Repair drops the ghost assistant(tool_use), but leaves the rest.
    expect(reloaded.repaired).toBe(true)
    expect(reloaded.messages.map((m) => m.role)).toEqual(["user", "user", "assistant"])
  })
})

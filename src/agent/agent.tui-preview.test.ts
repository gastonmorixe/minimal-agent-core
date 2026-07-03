/**
 * Layer 1b runtime-note tests: when the TUI's per-tool preview budget
 * clamps more lines than the universal API cap does, the agent appends a
 * `<ma::agent::output-preview shown=N total=M tool=X>` annotation to
 * `tool_result.content` BEFORE sending it back to the model on the next
 * turn. The annotation is model-only by construction (lives in
 * `tool_result.content`, stripped by `formatToolPreview` before render).
 *
 * These tests drive `Agent.run()` end-to-end with a fake `sendFn` and
 * inspect the messages captured on the LAST round to find the tool_result
 * content the model would see.
 *
 * Companion tests:
 *   - `src/tools-descriptions.test.ts`  :  assert the descriptions disclose
 *     the TUI cap and steer the model toward text replies for visual
 *     content.
 *   - `src/agent.test.ts` `appends a streak [note: ...]`  :  Layer 3
 *     (streak tracker) integration. This file is Layer 1b.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"

import { Agent } from "./agent.ts"

interface CapturedMsg {
  role: string
  content: unknown
}

function collectToolResultContent(records: Array<{ messages: CapturedMsg[] }>): string[] {
  const out: string[] = []
  const lastRoundMessages = records[records.length - 1]?.messages ?? []
  for (const msg of lastRoundMessages) {
    if (msg.role !== "user") continue
    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const b of blocks as Array<Record<string, unknown>>) {
      if (b.type === "tool_result") out.push(String(b.content))
    }
  }
  return out
}

function makeSendFn(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  records: Array<{ messages: CapturedMsg[] }>,
) {
  let round = 0
  return async function* sendFn(
    opts: SendOptions,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push({ messages: JSON.parse(JSON.stringify(opts.messages)) })
    if (round < toolUses.length) {
      const t = toolUses[round]
      round++
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: t.id,
            name: t.name,
            input: t.input,
          },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

const AUTH: AuthResult = { type: "api-key", token: "t" }

describe("<ma::agent::output-preview> runtime annotation", () => {
  it("appends the annotation when Bash output is over the 10-line preview budget but under the API cap", async () => {
    // 20 lines of bash output : above the Bash TUI budget (10) but well
    // under the universal API cap (1000 lines / 64KB).
    const records: Array<{ messages: CapturedMsg[] }> = []
    const sendFn = makeSendFn([{ id: "c1", name: "Bash", input: { command: "seq 1 20" } }], records)
    const agent = new Agent({ auth: AUTH, model: "test", sendFn })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const toolResults = collectToolResultContent(records)
    expect(toolResults.length).toBe(1)
    const c = toolResults[0]
    // Body retained (line 1 at start, lines 5/15/20 in body).
    expect(c.startsWith("1\n")).toBe(true)
    expect(c).toContain("\n5\n")
    expect(c).toContain("\n15\n")
    expect(c).toContain("\n20\n")
    // Annotation appended with the correct attributes.
    expect(c).toMatch(/<ma::agent::output-preview shown="10" total="20" tool="Bash">/)
    expect(c).toMatch(/<\/ma::agent::output-preview>$/)
    // Hint body specific to Bash (text-reply steering).
    expect(c).toMatch(/text reply/i)
    // No [truncated:] : API cap didn't fire.
    expect(c).not.toContain("[truncated:")
  }, 30_000)

  it("does NOT append the annotation when the body fits the TUI budget", async () => {
    const records: Array<{ messages: CapturedMsg[] }> = []
    const sendFn = makeSendFn(
      [{ id: "c1", name: "Bash", input: { command: "echo hello" } }],
      records,
    )
    const agent = new Agent({ auth: AUTH, model: "test", sendFn })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const toolResults = collectToolResultContent(records)
    expect(toolResults.length).toBe(1)
    expect(toolResults[0]).not.toContain("<ma::agent::output-preview")
    expect(toolResults[0]).not.toContain("[truncated:")
  }, 30_000)

  it("appends BOTH [truncated:] AND <ma::agent::output-preview> when API cap fires too (audiences are independent)", async () => {
    // > 64KB AND > 10 lines : API cap clamps to ~1000 lines, AND the
    // TUI's 10-line budget is also exceeded. The model needs both
    // signals : `[truncated:]` says "source was bigger than what I'm
    // showing you"; `<ma::agent::output-preview>` says "the user saw even less of
    // what you got".
    const records: Array<{ messages: CapturedMsg[] }> = []
    const sendFn = makeSendFn(
      [{ id: "c1", name: "Bash", input: { command: "yes hi | head -c 200000" } }],
      records,
    )
    const agent = new Agent({ auth: AUTH, model: "test", sendFn })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const toolResults = collectToolResultContent(records)
    expect(toolResults.length).toBe(1)
    const c = toolResults[0]
    // Both annotations present, with truncated FIRST (annotation order is
    // fixed and findAnnotationStart depends on it).
    expect(c).toContain("[truncated:")
    expect(c).toMatch(/<ma::agent::output-preview shown="10" total="1000" tool="Bash">/)
    const tIdx = c.indexOf("[truncated:")
    const mIdx = c.indexOf("<ma::agent::output-preview")
    expect(tIdx).toBeGreaterThan(0)
    expect(mIdx).toBeGreaterThan(tIdx)
  }, 30_000)

  it("appends the annotation for Read with the correct tool name and 15-line budget", async () => {
    // Read a synthetic file with > 15 lines so the Read preview budget bites.
    const tmpdir = await Bun.write(
      `/tmp/agent-tui-preview-read-${Date.now()}.txt`,
      Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"),
    )
    void tmpdir
    const path = `/tmp/agent-tui-preview-read-${Date.now()}.txt`
    await Bun.write(path, Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n"))
    const records: Array<{ messages: CapturedMsg[] }> = []
    const sendFn = makeSendFn([{ id: "c1", name: "Read", input: { file_path: path } }], records)
    const agent = new Agent({ auth: AUTH, model: "test", sendFn })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const toolResults = collectToolResultContent(records)
    expect(toolResults.length).toBe(1)
    const c = toolResults[0]
    expect(c).toMatch(/<ma::agent::output-preview shown="15" total="30" tool="Read">/)
    // Default (non-Bash) hint variant.
    expect(c).toMatch(/summarize/i)
  }, 30_000)

  it("uses the EARLIEST of the annotations as the strip boundary (defends against body containing [truncated:] literally)", async () => {
    // The strip is `findAnnotationStart` which takes the EARLIEST among
    // the last-occurrences of each prefix. Even if Bash output happens
    // to contain the string `[truncated:` somewhere in the body (e.g.
    // catting a log file that includes that token), the LAST occurrence
    // of `\n\n[truncated:` is still the real annotation at end-of-body.
    // This test cats output that contains the literal substring
    // `[truncated:` in the middle of the body and asserts the annotation
    // (added by us at the END) is what gets parsed for line-counting.
    const records: Array<{ messages: CapturedMsg[] }> = []
    // 20 lines, one of which CONTAINS the literal text `[truncated: foo]`
    // : this is the "log file accident" scenario.
    const lines = Array.from({ length: 20 }, (_, i) =>
      i === 10 ? "this line has [truncated: 42 of 100] in it" : `line ${i + 1}`,
    )
    const path = `/tmp/agent-tui-preview-stripcheck-${Date.now()}.txt`
    await Bun.write(path, lines.join("\n"))
    const sendFn = makeSendFn(
      [{ id: "c1", name: "Bash", input: { command: `cat ${path}` } }],
      records,
    )
    const agent = new Agent({ auth: AUTH, model: "test", sendFn })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const toolResults = collectToolResultContent(records)
    expect(toolResults.length).toBe(1)
    const c = toolResults[0]
    // The annotation's `total` should be 20 (the real body line count),
    // NOT misled by the in-body `[truncated:` substring. If the strip
    // logic mistook the in-body text for the annotation, `total` would
    // be ~10 and we'd never have appended the annotation at all.
    expect(c).toMatch(/<ma::agent::output-preview shown="10" total="20" tool="Bash">/)
  }, 30_000)
})

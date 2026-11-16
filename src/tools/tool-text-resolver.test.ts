/**
 * Built-in tool result texts go through the G3 synthetic text resolver
 * (core-prompts decouple steps P1.3 and P3.2). Each call site asks for one
 * kind with data-only facts: a recording resolver pins the kind and the
 * facts, not the text (the text parity lives in the plugin parity tests). A
 * stub provider changes the text, end to end through AgentCore's one resolver.
 */

import { describe, expect, it } from "bun:test"

import type {
  SyntheticFacts,
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { ToolResultBlock } from "../llm/messages.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import { ToolFeedbackTracker } from "./feedback-tracker.ts"
import { resolveGlobExecArgs } from "./glob-input.ts"
import { executeTool } from "./tools.ts"
import { MAX_TOOL_OUTPUT_BYTES, truncateToolOutput } from "./truncation.ts"
import { resolveWriteExecArgs } from "./write-input.ts"

/** One synthetic text request the code under test made. */
type Call = { kind: SyntheticKind; facts: SyntheticFacts }

/** A resolver that records (kind, facts) and returns `REC <kind>`. */
function recorder(): SyntheticTextResolver & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    resolve(kind, facts) {
      calls.push({ kind, facts })
      return `REC ${kind}`
    },
  }
}

function stub(kinds: SyntheticKind[]): SyntheticTextProvider {
  return { kinds, text: (kind, facts) => `STUB ${kind} ${JSON.stringify(facts)}` }
}

function resolverFor(kinds: SyntheticKind[]) {
  return createSyntheticTextResolver([stub(kinds)], createDiagnostics({ emit: () => {} }))
}

describe("tool result call sites ask for the kind with the documented facts", () => {
  it("unknown tool: tool_result.unknown_tool {name}", async () => {
    const text = recorder()
    const r = await executeTool("NoSuchTool", {}, { text })
    expect(r.content).toBe("REC tool_result.unknown_tool")
    expect(text.calls).toEqual([
      { kind: "tool_result.unknown_tool", facts: { name: "NoSuchTool" } },
    ])
  })

  it("Bash exit code: tool_text.Bash.exit_code {exitCode}", async () => {
    const text = recorder()
    const r = await executeTool("Bash", { command: "exit 1" }, { text })
    expect(r.content).toContain("REC tool_text.Bash.exit_code")
    expect(text.calls).toContainEqual({ kind: "tool_text.Bash.exit_code", facts: { exitCode: 1 } })
  })

  it("Write and Glob input errors: no facts", () => {
    const text = recorder()
    expect(resolveWriteExecArgs({}, text)).toEqual({
      ok: false,
      error: "REC tool_text.Write.missing_path",
    })
    expect(resolveWriteExecArgs({ file_path: "/x" }, text)).toEqual({
      ok: false,
      error: "REC tool_text.Write.missing_content",
    })
    expect(resolveGlobExecArgs({}, ".", text)).toEqual({
      ok: false,
      error: "REC tool_text.Glob.missing_pattern",
    })
    expect(text.calls).toEqual([
      { kind: "tool_text.Write.missing_path", facts: {} },
      { kind: "tool_text.Write.missing_content", facts: {} },
      { kind: "tool_text.Glob.missing_pattern", facts: {} },
    ])
  })

  it("streak note: tool_output.streak {tool, threshold} once per streak", () => {
    for (const [tool, threshold] of [
      ["Bash", 3],
      ["Read", 2],
    ] as const) {
      const text = recorder()
      const tracker = new ToolFeedbackTracker(threshold)
      let note: string | null = null
      for (let i = 0; i < threshold; i++) note = tracker.observe(tool, true, text)
      expect(note).toBe("REC tool_output.streak")
      expect(text.calls).toEqual([{ kind: "tool_output.streak", facts: { tool, threshold } }])
    }
  })

  it("truncation notice: tool_output.truncated with the cut facts", () => {
    const text = recorder()
    const big = "x\n".repeat(MAX_TOOL_OUTPUT_BYTES)
    const { content, info } = truncateToolOutput(big, { tool: "Grep" }, text)
    expect(info.truncated).toBe(true)
    expect(content.endsWith("\n\nREC tool_output.truncated")).toBe(true)
    expect(text.calls).toEqual([
      {
        kind: "tool_output.truncated",
        facts: {
          tool: "Grep",
          // The 1000-line cap cuts first: 1000 lines of "x\n" minus the last newline.
          shownBytes: 1999,
          totalBytes: 2 * MAX_TOOL_OUTPUT_BYTES,
          shownLines: 1000,
          // The trailing newline counts one more (empty) line.
          totalLines: MAX_TOOL_OUTPUT_BYTES + 1,
          cutLine: 1000,
          maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
        },
      },
    ])
  })

  it("truncation with no tool: fact tool is the empty string", () => {
    const text = recorder()
    truncateToolOutput("z\n".repeat(MAX_TOOL_OUTPUT_BYTES), {}, text)
    expect(text.calls[0]?.kind).toBe("tool_output.truncated")
    expect(text.calls[0]?.facts.tool).toBe("")
  })
})

describe("a stub provider changes the tool result text", () => {
  it("tool_result.unknown_tool", async () => {
    const text = resolverFor(["tool_result.unknown_tool"])
    const r = await executeTool("Foo", {}, { text })
    expect(r.content).toBe('STUB tool_result.unknown_tool {"name":"Foo"}')
  })

  it("tool_text.Bash.exit_code", async () => {
    const text = resolverFor(["tool_text.Bash.exit_code"])
    const r = await executeTool("Bash", { command: "exit 3" }, { text })
    expect(r.content).toBe('STUB tool_text.Bash.exit_code {"exitCode":3}')
  })

  it("tool_output.truncated keeps the body and the join", () => {
    const text = resolverFor(["tool_output.truncated"])
    const big = "y\n".repeat(MAX_TOOL_OUTPUT_BYTES)
    const { content, info } = truncateToolOutput(big, { tool: "Read" }, text)
    expect(info.truncated).toBe(true)
    const notice = content.slice(content.lastIndexOf("\n\n") + 2)
    expect(notice.startsWith('STUB tool_output.truncated {"tool":"Read"')).toBe(true)
    expect(content.startsWith("y\ny\n")).toBe(true)
  })
})

const auth: AuthResult = { type: "api-key", token: "test-token" }

/** Round 1 calls an unknown tool. Round 2 ends the turn. */
function unknownToolThenDone(): TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      const block = { type: "tool_use" as const, id: "toolu_1", name: "NoSuchTool", input: {} }
      return { blocks: [block], text: "", stopReason: "tool_use" } as StreamedResponse
    }
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function toolResultText(providers: SyntheticTextProvider[]): Promise<string> {
  const agent = await buildTestCore({
    auth,
    sendFn: unknownToolThenDone(),
    syntheticTextProviders: providers,
  })
  const gen = agent.run("go")
  while (!(await gen.next()).done) {}
  for (const m of agent.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "tool_result") return String((b as ToolResultBlock).content)
    }
  }
  return ""
}

describe("AgentCore's one resolver reaches the tool run", () => {
  it("passes kind and facts to the provider that owns the kind", async () => {
    const calls: Call[] = []
    const recording: SyntheticTextProvider = {
      kinds: ["tool_result.unknown_tool"],
      text: (kind, facts) => {
        calls.push({ kind, facts })
        return "RECORDED"
      },
    }
    expect(await toolResultText([recording])).toBe("RECORDED")
    expect(calls).toEqual([{ kind: "tool_result.unknown_tool", facts: { name: "NoSuchTool" } }])
  })

  it("uses the provider text for tool_result.unknown_tool", async () => {
    expect(await toolResultText([stub(["tool_result.unknown_tool"])])).toBe(
      'STUB tool_result.unknown_tool {"name":"NoSuchTool"}',
    )
  })
})

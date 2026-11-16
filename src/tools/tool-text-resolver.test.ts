/**
 * Built-in tool result texts go through the G3 synthetic text resolver
 * (core-prompts decouple step P1.3). With no provider, each text equals the
 * old PROMPTS.ts output (the fixture cases in synthetic.json). A stub
 * provider changes the text, end to end through AgentCore's one resolver.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type {
  SyntheticKind,
  SyntheticTextProvider,
} from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
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

const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "minimal-agent-plugins",
  "tests",
  "text-parity",
  "fixtures",
  "synthetic.json",
)

interface FixtureCase {
  args: unknown[]
  text: string
}

/** The fixture cases of one old function, or null when the plugins checkout is absent. */
function fixture(fn: string): FixtureCase[] | null {
  if (!existsSync(FIXTURE)) return null
  const data = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    entries: { fn: string; cases: FixtureCase[] }[]
  }
  const entry = data.entries.find((e) => e.fn === fn)
  if (!entry) throw new Error(`no fixture for ${fn}`)
  return entry.cases
}

function stub(kinds: SyntheticKind[]): SyntheticTextProvider {
  return { kinds, text: (kind, facts) => `STUB ${kind} ${JSON.stringify(facts)}` }
}

function resolverFor(kinds: SyntheticKind[]) {
  return createSyntheticTextResolver([stub(kinds)], createDiagnostics({ emit: () => {} }))
}

const hasFixture = existsSync(FIXTURE)

describe("tool result texts with no provider equal the fixture", () => {
  it.skipIf(!hasFixture)("unknown tool", async () => {
    for (const c of fixture("unknownToolResult") ?? []) {
      const r = await executeTool(c.args[0] as string, {})
      expect(r.content).toBe(c.text)
    }
  })

  it.skipIf(!hasFixture)("Bash exit code", async () => {
    const want = (fixture("bashExitCodeResult") ?? []).find((c) => c.args[0] === 1)
    const r = await executeTool("Bash", { command: "exit 1" })
    expect(r.content).toBe(want?.text ?? "")
  })

  it.skipIf(!hasFixture)("Write and Glob input errors", () => {
    const missingPath = fixture("writeMissingPathResult")?.[0]?.text
    const missingContent = fixture("writeMissingContentResult")?.[0]?.text
    const missingPattern = fixture("globMissingPatternResult")?.[0]?.text
    expect(resolveWriteExecArgs({})).toEqual({ ok: false, error: missingPath ?? "" })
    expect(resolveWriteExecArgs({ file_path: "/x" })).toEqual({
      ok: false,
      error: missingContent ?? "",
    })
    expect(resolveGlobExecArgs({}, ".")).toEqual({ ok: false, error: missingPattern ?? "" })
  })

  it.skipIf(!hasFixture)("streak note", () => {
    for (const c of fixture("streakNote") ?? []) {
      const tracker = new ToolFeedbackTracker(c.args[1] as number)
      let note: string | null = null
      for (let i = 0; i < (c.args[1] as number); i++)
        note = tracker.observe(c.args[0] as string, true)
      expect(note).toBe(c.text)
    }
  })

  it.skipIf(!hasFixture)("truncation hint inside the notice", () => {
    const hint = (fixture("truncationHint") ?? []).find((c) => c.args[0] === "Grep")
    const big = "x\n".repeat(MAX_TOOL_OUTPUT_BYTES)
    const { content } = truncateToolOutput(big, { tool: "Grep" })
    expect(content.endsWith(`${hint?.text ?? "?"}]`)).toBe(true)
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

async function toolResultText(providers?: SyntheticTextProvider[]): Promise<string> {
  const agent = await buildTestCore({
    auth,
    sendFn: unknownToolThenDone(),
    ...(providers ? { syntheticTextProviders: providers } : {}),
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
  it("uses the core fallback with no provider", async () => {
    expect(await toolResultText()).toBe("Unknown tool: NoSuchTool")
  })

  it("uses the provider text for tool_result.unknown_tool", async () => {
    expect(await toolResultText([stub(["tool_result.unknown_tool"])])).toBe(
      'STUB tool_result.unknown_tool {"name":"NoSuchTool"}',
    )
  })
})

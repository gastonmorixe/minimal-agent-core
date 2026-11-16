/**
 * Safety: the validity decision never depends on the error text. With no
 * text resolver (or a provider that returns ""), an invalid built-in input
 * still fails validation, and the tool does not run. The error content may
 * be "", but `is_error` is true.
 */

import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { executeToolRound, type ToolRoundContext } from "../loops/tool-round.ts"
import { allowDecision, type LifecyclePort, NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"

import { ToolFeedbackTracker } from "./feedback-tracker.ts"
import { prepareBuiltInToolInput, validateToolInput } from "./tool-input.ts"
import { executeTool } from "./tools.ts"

const EMPTY_TEXT = { resolve: () => "" }

const INVALID: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["Bash", { command: 5 }],
  ["Read", {}],
  ["Write", { content: "x" }],
  ["Glob", {}],
]

function ctxNoText(
  events: ToolViewEvent[],
  overrides: Partial<ToolRoundContext> = {},
): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    toolView: { onToolEvent: (e) => void events.push(e) },
    ...overrides,
  }
}

describe("invalid built-in input is rejected with no text resolver", () => {
  for (const [name, input] of INVALID) {
    it(`prepareBuiltInToolInput rejects ${name} ${JSON.stringify(input)}`, () => {
      expect(prepareBuiltInToolInput(name, input, undefined).ok).toBe(false)
      expect(prepareBuiltInToolInput(name, input, EMPTY_TEXT).ok).toBe(false)
      expect(validateToolInput(name, input, undefined)).not.toBeNull()
    })

    it(`the tool round does not run ${name} and gives is_error`, async () => {
      const events: ToolViewEvent[] = []
      const tool: ToolUseBlock = { type: "tool_use", id: `tu_${name}`, name, input }
      const result = await executeToolRound(tool, ctxNoText(events))
      expect(result.is_error).toBe(true)
      expect(events.some((e) => e.type === "started")).toBe(false)
      expect(events.some((e) => e.type === "input_error")).toBe(true)
    })

    it(`SDK executeTool with no opts.text rejects ${name}`, async () => {
      const result = await executeTool(name, input)
      expect(result.is_error).toBe(true)
    })
  }

  it("valid input still passes with no resolver", () => {
    expect(prepareBuiltInToolInput("Read", { file_path: "/x" }, undefined).ok).toBe(true)
    expect(validateToolInput("Glob", { pattern: "*" }, undefined)).toBeNull()
  })

  it("SDK executeTool does not write a file for Write with no content", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ma-noresolver-")), "w.txt")
    const result = await executeTool("Write", { file_path: path })
    expect(result.is_error).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it("SDK executeTool with no opts.text does not run Bash with a mistyped field", async () => {
    // Only the schema rejects `timeout: "abc"`. The Bash executor alone
    // would run the command, so this proves the gate, not the executor.
    const marker = join(mkdtempSync(join(tmpdir(), "ma-noresolver-bash-")), "ran")
    const result = await executeTool("Bash", { command: `touch '${marker}'`, timeout: "abc" })
    expect(result.is_error).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it("a hook rewrite to invalid input is denied with no resolver", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ma-noresolver-rw-")), "w.txt")
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      async beforeTool(p) {
        const { content: _dropped, ...rest } = p.input
        return allowDecision({ ...p, input: rest })
      },
    }
    const events: ToolViewEvent[] = []
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_rw",
      name: "Write",
      input: { file_path: path, content: "x" },
    }
    const result = await executeToolRound(tool, ctxNoText(events, { lifecycle }))
    expect(result.is_error).toBe(true)
    expect(events.some((e) => e.type === "started")).toBe(false)
    expect(existsSync(path)).toBe(false)
  })
})

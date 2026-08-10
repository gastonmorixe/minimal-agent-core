import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { executeToolRound, type ToolRoundContext } from "../../../agent/tool-round.ts"
import { NOOP_LIFECYCLE } from "../../../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../../../tools/feedback-tracker.ts"

import type { CodeHighlighter, CodeHighlightRequest } from "./format.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const highlighter: CodeHighlighter = {
  warmup: async () => true,
  async highlight({ code }: CodeHighlightRequest) {
    return code
      .split("\n")
      .map((line) => `\x1b[38;2;10;20;30m${line}\x1b[0m`)
      .join("\n")
  },
  close: async () => {},
}

function context(transcript: string[]): ToolRoundContext {
  return {
    presentation: new Map(),
    writeTranscript: (line) => transcript.push(line),
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: null,
    codeHighlighter: highlighter,
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
  }
}

describe("executeToolRound code highlighting", () => {
  it("colors Read transcript code without changing model-facing content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-read-highlight-"))
    dirs.push(dir)
    const path = join(dir, "example.ts")
    writeFileSync(path, "const x: number = 1\nreturn x\n")
    const transcript: string[] = []

    const result = await executeToolRound(
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: path } },
      context(transcript),
    )

    expect(result.content).toBe("1\tconst x: number = 1\n2\treturn x\n3\t")
    expect(String(result.content)).not.toContain("\x1b")
    expect(transcript.join("\n")).toContain("\x1b[38;2;10;20;30mconst x: number = 1")
    expect(transcript.join("\n")).toContain("\x1b[2m1\x1b[22m")
  })

  it("colors Markdown Read output instead of treating .md as prose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-read-markdown-highlight-"))
    dirs.push(dir)
    const path = join(dir, "CHANGELOG.md")
    writeFileSync(path, "### Feat: Session dump artifact paths\n\nUse `--dump-paths`.\n")
    const transcript: string[] = []

    const result = await executeToolRound(
      { type: "tool_use", id: "read-md-1", name: "Read", input: { file_path: path } },
      context(transcript),
    )

    expect(String(result.content)).not.toContain("\x1b")
    const rendered = transcript.join("\n")
    expect(rendered).toContain("\x1b[38;2;10;20;30m### Feat: Session dump artifact paths")
    expect(rendered).toContain("\x1b[38;2;10;20;30mUse `--dump-paths`.")
  })

  it("composes Edit status markers with token colors and keeps compact result plain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-edit-highlight-"))
    dirs.push(dir)
    const path = join(dir, "example.ts")
    writeFileSync(path, "oldCall()\n")
    const transcript: string[] = []

    const result = await executeToolRound(
      {
        type: "tool_use",
        id: "edit-1",
        name: "Edit",
        input: { file_path: path, old_string: "oldCall()", new_string: "newCall()" },
      },
      context(transcript),
    )

    expect(String(result.content)).toContain("File edited:")
    expect(String(result.content)).not.toContain("\x1b")
    const rendered = transcript.join("\n")
    expect(rendered).toContain("\x1b[48;2;56;0;38m\x1b[38;5;199m-")
    expect(rendered).toContain("\x1b[48;2;29;56;0m\x1b[38;5;118m+")
    expect(rendered).toContain("\x1b[38;2;10;20;30moldCall()")
    expect(rendered).toContain("\x1b[38;2;10;20;30mnewCall()")
  })
})

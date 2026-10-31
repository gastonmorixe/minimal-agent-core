import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { PLAIN_TOOL_TRANSCRIPT } from "./plain-tool-transcript.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"
import type { CodeHighlighter, ToolTranscriptFormatter } from "./tool-transcript-port.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const highlighter: CodeHighlighter = {
  warmup: async () => true,
  highlight: async ({ code }) => `\x1b[31m${code}\x1b[0m`,
  close: async () => {},
}

function context(
  transcript: string[],
  transcriptFormatter?: ToolTranscriptFormatter,
): ToolRoundContext {
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
    ...(transcriptFormatter ? { transcriptFormatter } : {}),
  }
}

function readFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-plain-transcript-"))
  dirs.push(dir)
  const path = join(dir, "example.ts")
  writeFileSync(path, "const x = 1\n")
  return path
}

describe("plain tool transcript default", () => {
  it("writes framed rows with no ANSI and no code highlight", async () => {
    const path = readFixture()
    const transcript: string[] = []
    const result = await executeToolRound(
      { type: "tool_use", id: "read-1", name: "Read", input: { file_path: path } },
      context(transcript),
    )

    expect(result.content).toBe("1\tconst x = 1\n2\t")
    const rendered = transcript.join("\n")
    expect(rendered).not.toContain("\x1b")
    expect(rendered).toContain(`  ╭ Read  ${path}`)
    expect(rendered).toContain("  │ 1   const x = 1")
    expect(transcript.at(-1)).toMatch(/^ {2}╰/)
  })

  it("routes every row through a host formatter when the host gives one", async () => {
    const path = readFixture()
    const transcript: string[] = []
    const tagged: ToolTranscriptFormatter = {
      ...PLAIN_TOOL_TRANSCRIPT,
      formatToolHeaderRows: (opts) => [`HEADER ${opts.tool.name}`],
      formatToolPreview: () => ["PREVIEW"],
    }
    const result = await executeToolRound(
      { type: "tool_use", id: "read-2", name: "Read", input: { file_path: path } },
      context(transcript, tagged),
    )

    expect(result.content).toBe("1\tconst x = 1\n2\t")
    expect(transcript).toEqual(["\nHEADER Read", "PREVIEW"])
  })

  it("renders refusal, mode, findings, and stream tail rows as plain text", () => {
    expect(PLAIN_TOOL_TRANSCRIPT.formatRefusalRows("no", "plan")).toEqual([
      "  │ ⊘ no",
      "  ╰ (refused by plan)",
    ])
    expect(PLAIN_TOOL_TRANSCRIPT.formatModeCloseRow("Plan")).toBe("  ╰ active mode: Plan")
    expect(
      PLAIN_TOOL_TRANSCRIPT.renderFindingsPanel([
        { source: "lint", severity: "error", message: "bad", line: 3, col: 1 },
      ]),
    ).toEqual(["  │ ● 3:1 bad", "  ╰ ✘ 1 error"])
    const rows: string[] = []
    PLAIN_TOOL_TRANSCRIPT.renderStreamedTail({
      bufferedLastLine: "last",
      streamedLineCount: 12,
      budget: 10,
      writeTranscript: (line) => rows.push(line),
    })
    expect(rows).toEqual(["  │ last", "  ┊", "  ╰ shown 10/12 L"])
    expect(PLAIN_TOOL_TRANSCRIPT.reopenFrameCloser("  ╰ done")).toBe("  │ done")
  })
})

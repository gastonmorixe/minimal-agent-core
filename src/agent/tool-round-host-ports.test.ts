/**
 * The tool round reads no module singleton and no terminal (spec S23, S24,
 * S47). Tool status goes through the injected `statusPort`. The render
 * width comes from the injected `toolEnv` port. With no port, the round
 * is silent and the formatter uses its own fixed width.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { StatusActivity } from "../bus/status.ts"
import { GLOBAL_STATUS_BUS } from "../bus/status.ts"
import type { LiveStatus, StatusFields, StatusPort } from "../bus/status-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { Finding } from "../sdk/tool-lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { PLAIN_TOOL_TRANSCRIPT } from "./plain-tool-transcript.ts"
import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"
import type { ToolTranscriptFormatter } from "./tool-transcript-port.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    presentation: new Map(),
    writeTranscript: () => {},
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: null,
    model: "test-model",
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    ...overrides,
  }
}

/** One status the round opened, with every call made on it. */
interface RecordedStatus {
  fields: StatusFields
  activity: StatusActivity[]
  cleared: boolean
}

function recordingStatusPort(): { port: StatusPort; opened: RecordedStatus[] } {
  const opened: RecordedStatus[] = []
  const port: StatusPort = {
    open(fields): LiveStatus {
      const rec: RecordedStatus = { fields, activity: [], cleared: false }
      opened.push(rec)
      return {
        update: () => {},
        updateActivity: (a) => rec.activity.push(a),
        clear: () => {
          rec.cleared = true
        },
      }
    },
  }
  return { port, opened }
}

function readFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "ma-tool-round-ports-"))
  const path = join(dir, "a.txt")
  writeFileSync(path, "line one\nline two\n")
  return path
}

function readTool(path: string): ToolUseBlock {
  return { type: "tool_use", id: "tu_read", name: "Read", input: { file_path: path } }
}

/** A plain formatter that records the `cols` of each header and findings panel. */
function colsRecordingFormatter(): { fmt: ToolTranscriptFormatter; cols: unknown[] } {
  const cols: unknown[] = []
  const fmt: ToolTranscriptFormatter = {
    ...PLAIN_TOOL_TRANSCRIPT,
    formatToolHeaderRows(opts) {
      cols.push(opts.cols)
      return PLAIN_TOOL_TRANSCRIPT.formatToolHeaderRows(opts)
    },
    renderFindingsPanel(findings, opts) {
      cols.push(opts?.cols)
      return PLAIN_TOOL_TRANSCRIPT.renderFindingsPanel(findings, opts)
    },
  }
  return { fmt, cols }
}

const FINDING: Finding = { source: "lint", severity: "warning", line: 1, message: "check this" }

describe("executeToolRound status port (S23)", () => {
  test("opens one running_tool status on the port and clears it", async () => {
    const { port, opened } = recordingStatusPort()
    await executeToolRound(readTool(readFixture()), baseCtx({ statusPort: port }))
    expect(opened).toHaveLength(1)
    expect(opened[0]?.fields).toEqual({ phase: "running_tool", toolName: "Read" })
    expect(opened[0]?.cleared).toBe(true)
  })

  test("a non-streaming tool seeds an idle activity, not a stall candidate", async () => {
    const { port, opened } = recordingStatusPort()
    await executeToolRound(readTool(readFixture()), baseCtx({ statusPort: port }))
    const seed = opened[0]?.activity[0]
    expect(seed?.direction).toBe("idle")
    expect(seed?.lastChunkAt).toBeUndefined()
  })

  test("Bash seeds a download activity and reports streamed bytes", async () => {
    const { port, opened } = recordingStatusPort()
    const tool: ToolUseBlock = {
      type: "tool_use",
      id: "tu_bash",
      name: "Bash",
      input: { command: "echo hello-port" },
    }
    await executeToolRound(tool, baseCtx({ statusPort: port }))
    expect(opened[0]?.fields).toEqual({ phase: "running_tool", toolName: "Bash" })
    const seed = opened[0]?.activity[0]
    expect(seed?.direction).toBe("down")
    expect(seed?.recvBytes).toBe(0)
    expect(typeof seed?.lastChunkAt).toBe("number")
    const bytes = opened[0]?.activity.map((a) => a.recvBytes ?? 0) ?? []
    expect(Math.max(...bytes)).toBeGreaterThan(0)
    expect(opened[0]?.cleared).toBe(true)
  })

  test("the round never writes the module status bus", async () => {
    const labels: string[] = []
    const unsub = GLOBAL_STATUS_BUS.subscribe(() => {
      const s = GLOBAL_STATUS_BUS.currentStatus()
      if (s) labels.push(s.label)
    })
    try {
      await executeToolRound(readTool(readFixture()), baseCtx())
      const { port } = recordingStatusPort()
      await executeToolRound(readTool(readFixture()), baseCtx({ statusPort: port }))
    } finally {
      unsub()
    }
    expect(labels.filter((l) => l.includes("Running"))).toEqual([])
  })
})

describe("executeToolRound width (S24)", () => {
  const savedColumns = Object.getOwnPropertyDescriptor(process.stdout, "columns")
  afterEach(() => {
    if (savedColumns) Object.defineProperty(process.stdout, "columns", savedColumns)
    else Reflect.deleteProperty(process.stdout, "columns")
  })

  function fakeTerminalColumns(value: number): void {
    Object.defineProperty(process.stdout, "columns", { value, configurable: true })
  }

  const findingsLifecycle = {
    ...NOOP_LIFECYCLE,
    afterTool: async (p: Parameters<NonNullable<typeof NOOP_LIFECYCLE.afterTool>>[0]) => ({
      ...p,
      findings: [FINDING],
    }),
  }

  test("header and findings panel take the width from the toolEnv port", async () => {
    fakeTerminalColumns(211)
    const { fmt, cols } = colsRecordingFormatter()
    await executeToolRound(
      readTool(readFixture()),
      baseCtx({
        transcriptFormatter: fmt,
        lifecycle: findingsLifecycle,
        toolEnv: { values: () => ({ columns: 57 }) },
      }),
    )
    expect(cols.length).toBeGreaterThanOrEqual(2)
    expect(cols.every((c) => c === 57)).toBe(true)
  })

  test("with no toolEnv port the round passes no width, not the terminal width", async () => {
    fakeTerminalColumns(211)
    const { fmt, cols } = colsRecordingFormatter()
    await executeToolRound(
      readTool(readFixture()),
      baseCtx({ transcriptFormatter: fmt, lifecycle: findingsLifecycle }),
    )
    expect(cols.length).toBeGreaterThanOrEqual(2)
    expect(cols.every((c) => c === undefined)).toBe(true)
  })
})

/**
 * The tool round reads no module singleton and no terminal (spec S23, S24,
 * S47). Tool status goes through the injected `statusPort`. The host view
 * gets plain events through the injected `toolView` port. Env values for a
 * spawned tool come only from the injected `toolEnv` port.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import type { ToolViewEvent } from "../agent/tool-view-port.ts"
import type { StatusActivity } from "../bus/status.ts"
import { GLOBAL_STATUS_BUS } from "../bus/status.ts"
import type { LiveStatus, StatusFields, StatusPort } from "../bus/status-port.ts"
import type { ToolUseBlock } from "../llm/messages.ts"
import { ToolExecutorAdapter } from "../loops/assemble.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import type { Finding } from "../sdk/tool-lifecycle.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

function baseCtx(overrides: Partial<ToolRoundContext> = {}): ToolRoundContext {
  return {
    loader: null,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
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

describe("executeToolRound host view and env (S24)", () => {
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

  function bashTool(command: string): ToolUseBlock {
    return { type: "tool_use", id: "tu_env", name: "Bash", input: { command } }
  }

  test("emits plain events in order, with the findings in the outcome", async () => {
    const events: ToolViewEvent[] = []
    const path = readFixture()
    const block = await executeToolRound(
      readTool(path),
      baseCtx({
        lifecycle: findingsLifecycle,
        toolView: { onToolEvent: (e) => void events.push(e) },
      }),
    )
    expect(events.map((e) => e.type)).toEqual(["started", "executed", "outcome"])
    const outcome = events.find((e) => e.type === "outcome")
    if (outcome?.type !== "outcome") throw new Error("no outcome event")
    expect(outcome.tool.input).toEqual({ file_path: path })
    expect(outcome.outcome.findings).toEqual([FINDING])
    expect(outcome.outcome.content).toBe(String(block.content))
    expect(JSON.stringify(events)).not.toContain("\\u001b")
  })

  test("a view that throws or rejects never breaks the round", async () => {
    const tool = bashTool("echo still-runs")
    const thrown = await executeToolRound(
      tool,
      baseCtx({
        toolView: {
          onToolEvent: () => {
            throw new Error("view broke")
          },
        },
      }),
    )
    const rejected = await executeToolRound(
      tool,
      baseCtx({ toolView: { onToolEvent: async () => Promise.reject(new Error("no")) } }),
    )
    expect(thrown.content).toBe("still-runs")
    expect(rejected.content).toBe("still-runs")
  })

  test("Bash streams raw output chunks to the view", async () => {
    const chunks: string[] = []
    await executeToolRound(
      bashTool("printf 'a\\nb\\n'"),
      baseCtx({
        toolView: {
          onToolEvent: (e) => {
            if (e.type === "output") chunks.push(e.chunk)
          },
        },
      }),
    )
    expect(chunks.join("")).toBe("a\nb\n")
  })

  test("the adapter adds no terminal size to a Bash child (no toolEnv port)", async () => {
    fakeTerminalColumns(211)
    const savedEnvColumns = process.env.COLUMNS
    delete process.env.COLUMNS
    const executor = new ToolExecutorAdapter({
      loader: null,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set(),
      feedbackTracker: new ToolFeedbackTracker(),
      model: "test-model",
    })
    try {
      const result = await executor.execute(bashTool("echo ${COLUMNS:-none}"))
      expect(result.content).toBe("none")
    } finally {
      if (savedEnvColumns !== undefined) process.env.COLUMNS = savedEnvColumns
    }
  })

  test("the host toolEnv port supplies the env names and values", async () => {
    fakeTerminalColumns(211)
    const block = await executeToolRound(
      bashTool("echo $COLUMNS $TERM"),
      baseCtx({ toolEnv: { values: () => ({ env: { COLUMNS: "57", TERM: "xterm" } }) } }),
    )
    // The host value wins for COLUMNS. Core keeps TERM=dumb.
    expect(block.content).toBe("57 dumb")
  })
})

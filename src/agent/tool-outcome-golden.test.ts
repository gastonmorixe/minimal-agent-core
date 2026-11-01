/**
 * Golden for the tool outcome (spec S24, S29). Each case runs one real tool
 * call through the {@link ToolExecutorAdapter}. The golden pins three
 * things:
 *
 * 1. `model`: the model-facing `content` and `isError` of each case. These
 *    bytes were recorded before the tool round stopped building transcript
 *    rows, and they must not change.
 * 2. `events`: the plain tool view events each case sends to the host.
 * 3. `jsonRoute`: the exact JSONL bytes of one Bash tool turn on the JSON
 *    route.
 *
 * The test runs every case at two terminal widths, with and without a host
 * view. The model bytes and the JSON route bytes must be the same in each
 * run: the width and the view are host matters.
 *
 * Set `UPDATE_TOOL_OUTCOME_GOLDEN=1` to write a new golden file. Do this
 * only for an intended change.
 *
 * @module agent/tool-outcome-golden.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { ToolExecutorAdapter } from "../adapters/tool-executor-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { ModeManager } from "../modes/modes.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import { JsonlEventSink } from "../sdk/events.ts"
import type { LifecyclePort } from "../sdk/lifecycle.ts"
import type { ToolEnvPort } from "../sdk/tool-env.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import type { ToolViewEvent } from "./tool-view-port.ts"

const GOLDEN_PATH = join(import.meta.dirname, "tool-outcome.golden.json")
const UPDATE = process.env.UPDATE_TOOL_OUTCOME_GOLDEN === "1"
const WIDTHS = [40, 200] as const

const root = mkdtempSync(join(tmpdir(), "core-tool-outcome-golden-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const scrub = (s: string): string => s.split(root).join("<ROOT>")

/** A terminal host's env values for one width. */
function widthEnv(columns: number): ToolEnvPort {
  return { values: () => ({ env: { COLUMNS: String(columns), LINES: "40" } }) }
}

/** A plugin with a body tool, a long plain tool, and a binary tool. */
async function loadProbePlugin(): Promise<PluginLoader> {
  const pluginsDir = join(root, "plugins")
  const dir = join(pluginsDir, "probe")
  mkdirSync(dir, { recursive: true })
  const tool = (id: string, name: string) => ({
    id,
    trigger: {
      type: "tool",
      tool: {
        name,
        description: "probe",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
      },
    },
    handler: { type: "module", path: `./${id}.ts`, export: "default" },
    interactive: false,
  })
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "probe",
      name: "probe",
      version: "0.1.0",
      description: "t",
      headless: { tools: [tool("body", "ProbeBody"), tool("long", "ProbeLong")] },
    }),
  )
  writeFileSync(
    join(dir, "body.ts"),
    `export default async () => ({
  kind: "tool_result",
  content: Array.from({ length: 30 }, (_, i) => "row " + i).join("\\n"),
  display: "short body",
  displayHeader: "probe header",
  displayFooter: "probe footer",
})`,
  )
  writeFileSync(
    join(dir, "long.ts"),
    `export default async () => ({
  kind: "tool_result",
  content: Array.from({ length: 30 }, (_, i) => "line " + i).join("\\n"),
})`,
  )
  return PluginLoader.load({ roots: { embedded: [pluginsDir] }, logger: () => {} })
}

interface CaseSpec {
  name: string
  tool: string
  /** Makes the input, and fresh fixture files, for each run. */
  input: () => Record<string, unknown>
  loader?: PluginLoader | null
  modeManager?: ModeManager | null
  lifecycle?: LifecyclePort
}

interface RunResult {
  model: { content: unknown; isError: boolean }
  events: unknown[]
}

/** Merge the live output chunks: their split depends on the OS pipe. */
function normalizeEvents(events: ToolViewEvent[]): unknown[] {
  const out: unknown[] = []
  for (const e of events) {
    const last = out.at(-1) as { type?: string; text?: string } | undefined
    if (e.type === "output") {
      if (last?.type === "output") last.text = `${last.text ?? ""}${e.chunk}`
      else out.push({ type: "output", text: e.chunk })
      continue
    }
    out.push(JSON.parse(scrub(JSON.stringify(e))))
  }
  return out
}

async function runCase(spec: CaseSpec, width: number, withView: boolean): Promise<RunResult> {
  const events: ToolViewEvent[] = []
  const executor = new ToolExecutorAdapter({
    loader: spec.loader ?? null,
    modeManager: spec.modeManager ?? null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    toolEnv: widthEnv(width),
    ...(spec.lifecycle ? { lifecycle: spec.lifecycle } : {}),
    ...(withView ? { toolView: { onToolEvent: (e: ToolViewEvent) => void events.push(e) } } : {}),
  })
  const result = await executor.execute({
    type: "tool_use",
    id: `call-${spec.name}`,
    name: spec.tool,
    input: spec.input(),
  })
  const content = typeof result.content === "string" ? scrub(result.content) : result.content
  return { model: { content, isError: result.isError }, events: normalizeEvents(events) }
}

function caseSpecs(loader: PluginLoader): CaseSpec[] {
  const write = (name: string, text: string): string => {
    const path = join(root, name)
    rmSync(path, { force: true })
    if (text) writeFileSync(path, text)
    return path
  }
  const longText = `${Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n")}\n`
  const askMode = new ModeManager(
    [
      {
        id: "ask",
        label: "ASK",
        permissions: [
          { tool: "*", allow: true },
          { tool: "Bash", allow: false },
        ],
      },
    ],
    "ask",
    "dark",
    () => new Date(Date.UTC(2026, 4, 22, 17, 52, 30)),
  )
  return [
    { name: "bash-short", tool: "Bash", input: () => ({ command: "printf 'one\\ntwo\\n'" }) },
    { name: "bash-long", tool: "Bash", input: () => ({ command: "seq 1 30" }) },
    { name: "bash-error", tool: "Bash", input: () => ({ command: "echo oops >&2; exit 3" }) },
    {
      name: "bash-binary",
      tool: "Bash",
      input: () => ({ command: "printf '\\x00\\x01\\x02\\xff\\xfe'" }),
    },
    { name: "read-long", tool: "Read", input: () => ({ file_path: write("long.txt", longText) }) },
    {
      name: "edit",
      tool: "Edit",
      input: () => ({
        file_path: write("edit.txt", "a\nb\nc\n"),
        old_string: "b",
        new_string: "B",
      }),
    },
    {
      name: "write-new",
      tool: "Write",
      input: () => ({ file_path: write("new.txt", ""), content: "x\ny\n" }),
    },
    { name: "input-error", tool: "Read", input: () => ({}) },
    {
      name: "policy-deny",
      tool: "Bash",
      input: () => ({ command: "echo never" }),
      lifecycle: { beforeTool: async () => ({ action: "deny", reason: "blocked here" }) },
    },
    {
      name: "mode-refusal",
      tool: "Bash",
      input: () => ({ command: "echo no" }),
      modeManager: askMode,
    },
    { name: "mode-tool", tool: "Mode", input: () => ({}), modeManager: askMode },
    {
      name: "diagnostics",
      tool: "Edit",
      input: () => ({
        file_path: write("diag.txt", "let a\n"),
        old_string: "let",
        new_string: "const",
      }),
      lifecycle: {
        afterTool: async (payload) => ({
          ...payload,
          findings: [{ source: "lint", severity: "warning", line: 1, message: "a is unused" }],
          notes: ["a is unused"],
        }),
      },
    },
    { name: "plugin-body", tool: "ProbeBody", input: () => ({}), loader },
    { name: "plugin-long", tool: "ProbeLong", input: () => ({}), loader },
  ]
}

/** Round 1 asks for one Bash call, round 2 answers in text. */
function bashTurnSend() {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          { type: "tool_use" as const, id: "call-1", name: "Bash", input: { command: "seq 1 12" } },
        ],
        text: "",
        stopReason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 3 },
      }
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 4 },
    }
  }
}

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const STILL_CLOCK: RetryClock = { now: () => 1_000, sleep: async () => {} }

/** The JSONL bytes of one Bash tool turn on the JSON route. */
async function jsonRouteBytes(width: number, withView: boolean): Promise<string> {
  const out: string[] = []
  const core = new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [{ name: "Bash", description: "run", input_schema: {} }] },
    toolExecutor: new ToolExecutorAdapter({
      loader: null,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set(),
      feedbackTracker: new ToolFeedbackTracker(),
      model: "test-model",
      toolEnv: widthEnv(width),
      ...(withView ? { toolView: { onToolEvent: () => {} } } : {}),
    }),
    sendFn: bashTurnSend(),
    eventSink: new JsonlEventSink((line) => out.push(line)),
    retry: { clock: STILL_CLOCK },
  })
  const gen = core.run("count")
  while (!(await gen.next()).done) {
    // drain
  }
  // The duration is wall-clock time of a real child process.
  return out.join("").replace(/"durationMs":\d+/g, '"durationMs":0')
}

describe("tool outcome golden (S24, S29)", () => {
  it("keeps the model bytes, the view events, and the JSON route bytes", async () => {
    const loader = await loadProbePlugin()
    const specs = caseSpecs(loader)
    const model: Record<string, RunResult["model"]> = {}
    const events: Record<string, unknown[]> = {}
    for (const spec of specs) {
      const runs: RunResult[] = []
      for (const width of WIDTHS) {
        runs.push(await runCase(spec, width, true))
        runs.push(await runCase(spec, width, false))
      }
      const [first, ...rest] = runs
      if (!first) throw new Error("no run")
      // Same model bytes at each width, with and without a view.
      for (const run of rest) expect(run.model).toEqual(first.model)
      // Same view events at each width.
      expect(runs[2]?.events).toEqual(first.events)
      // No view: no events.
      expect(runs[1]?.events).toEqual([])
      model[spec.name] = first.model
      events[spec.name] = first.events
    }
    const routes = await Promise.all(
      WIDTHS.flatMap((w) => [jsonRouteBytes(w, true), jsonRouteBytes(w, false)]),
    )
    for (const bytes of routes) expect(bytes).toBe(routes[0] ?? "")

    const actual = `${JSON.stringify({ model, events, jsonRoute: routes[0] }, null, 2)}\n`
    if (UPDATE || !existsSync(GOLDEN_PATH)) writeFileSync(GOLDEN_PATH, actual)
    expect(actual).toBe(readFileSync(GOLDEN_PATH, "utf8"))
  }, 60_000)
})

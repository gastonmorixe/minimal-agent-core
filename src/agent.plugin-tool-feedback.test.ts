/**
 * Plugin-tool live feedback: regression guards for two bugs where a
 * long-running plugin tool (Fetch-like) gave the user no usable signal.
 *
 *  Bug 1 — "no header until it finishes": the framed `╭ <icon> <tool>`
 *  transcript row was deferred until `loader.dispatch()` resolved, so a
 *  120s Fetch showed nothing in scrollback until completion. Built-in
 *  tools (Bash/Read/…) paint the header BEFORE executing; plugin tools
 *  must do the same.
 *
 *  Bug 2 — "false stalled": the status row was seeded with
 *  `direction:"down"` + `lastChunkAt`, which makes the activity infix flip
 *  to the amber `⋯ stalled · last byte Ns ago` after 2s of no chunks. But
 *  only Bash ever feeds chunks, so EVERY plugin tool was guaranteed to read
 *  "stalled" after 2 seconds even while perfectly healthy. A non-streaming
 *  tool must NOT seed the stall machinery.
 *
 * Both are framework bugs in `src/agent.ts`'s tool-dispatch loop, not in
 * any specific plugin.
 */
import { describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { SendOptions, StreamedResponse } from "./client/types.ts"
import { formatActivityInfix } from "./host/ui/status/format.ts"
import type { PluginLoader } from "./plugins/loader.ts"
import type { TUIResult } from "./plugins/types.ts"
import { GLOBAL_STATUS_BUS, type StatusActivity } from "./status.ts"

const ANSI_RE = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

const auth: AuthResult = { type: "api-key", token: "test-token" }

/**
 * Loader stub that routes a `Fetch` tool_use through `dispatch`. The
 * `onDispatchEntry` hook fires synchronously at the top of `dispatch`,
 * BEFORE the result promise resolves, so a test can observe what the agent
 * has already rendered by the time the plugin handler is invoked.
 */
function makeLoaderStub(opts: { result: TUIResult; onDispatchEntry?: () => void }): PluginLoader {
  const stub = {
    hasTool: (name: string) => name === "Fetch",
    dispatch: async (_trigger: unknown, _cwd: string, _signal?: AbortSignal) => {
      opts.onDispatchEntry?.()
      // Resolve on a later macrotask so "before dispatch resolves" is a
      // real window, not a synchronous return.
      await new Promise((r) => setTimeout(r, 5))
      return opts.result
    },
    // Advertise Fetch with the declarative `headerKey: "url"` so the agent
    // builds a presentation map that surfaces the URL synchronously in the
    // header (mirrors the real ma-fetch manifest).
    getExtraTools: () => [
      {
        name: "Fetch",
        description: "fetch a page",
        input_schema: { type: "object", properties: { url: { type: "string" } } },
        icon: "⤓",
        color: "sky",
        headerKey: "url",
      },
    ],
    getPromptBlockAsync: async () => "",
    getPromptBlock: () => "",
    getToolAliases: () => new Map<string, string>(),
  }
  return stub as unknown as PluginLoader
}

function fetchSendFn() {
  let round = 0
  return async function* (_opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [
          {
            type: "tool_use" as const,
            id: "toolu_fetch_1",
            name: "Fetch",
            input: { url: "https://example.com/page" },
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

describe("plugin tool: header is painted BEFORE dispatch (Bug 1)", () => {
  it("emits the framed ╭ header row before loader.dispatch resolves", async () => {
    const lines: string[] = []
    let headerLinesAtDispatchEntry = -1
    const loader = makeLoaderStub({
      result: {
        kind: "tool_result",
        content: "BODY",
        display: "BODY",
        displayHeader: "https://example.com/page",
      },
      onDispatchEntry: () => {
        headerLinesAtDispatchEntry = lines.filter((l) => stripAnsi(l).includes("╭")).length
      },
    })
    const agent = new Agent({ auth, model: "test-model", sendFn: fetchSendFn(), loader })
    const gen = agent.run("go", { onTranscriptLine: (l) => lines.push(l) })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The header must already be in scrollback at the moment the plugin
    // handler is entered — i.e. BEFORE the dispatch promise resolves.
    expect(headerLinesAtDispatchEntry).toBeGreaterThanOrEqual(1)

    // And the header the user sees identifies what's running (the URL),
    // rendered CLEANLY via the declarative `headerKey` — not the raw
    // `{"url":"…"}` JSON fallback.
    const headerRow = lines.map(stripAnsi).find((l) => l.includes("╭"))
    expect(headerRow).toBeDefined()
    expect(headerRow!).toContain("Fetch")
    expect(headerRow!).toContain("https://example.com/page")
    expect(headerRow!).not.toContain("{")
    expect(headerRow!).not.toContain('"url"')
  }, 10_000)
})

describe("plugin tool: no false 'stalled' seed (Bug 2)", () => {
  it("seeded status activity does not render as stalled for a non-streaming tool", async () => {
    // Capture the activity the agent seeds for the "Running Fetch" status.
    const seen: StatusActivity[] = []
    const unsub = GLOBAL_STATUS_BUS.subscribe(() => {
      const s = GLOBAL_STATUS_BUS.currentStatus()
      if (s && s.label.includes("Running Fetch") && s.activity) seen.push(s.activity)
    })

    const loader = makeLoaderStub({
      result: { kind: "tool_result", content: "BODY", display: "BODY" },
    })
    const agent = new Agent({ auth, model: "test-model", sendFn: fetchSendFn(), loader })
    const gen = agent.run("go", { onTranscriptLine: () => {} })
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    unsub()

    expect(seen.length).toBeGreaterThanOrEqual(1)
    const seed = seen[0]
    const startedAt = seed.startedAt ?? Date.now()
    // Simulate the renderer 10s later with no chunks (the exact condition
    // that wrongly produced "⋯ stalled · last byte Ns ago" before the fix).
    const infix = stripAnsi(
      formatActivityInfix(seed, { now: startedAt + 10_000, entryStartedAt: startedAt }),
    )
    expect(infix).not.toContain("stalled")
  }, 10_000)
})

/**
 * Plugin-tool live feedback: regression guards for two bugs where a
 * long-running plugin tool (Fetch-like) gave the user no usable signal.
 *
 *  Bug 1 — "no header until it finishes": the framed `╭ <icon> <tool>`
 *  transcript row was deferred until `loader.dispatch()` resolved, so a
 *  120s Fetch showed nothing in scrollback until completion. Built-in
 *  tools (Bash/Read/…) paint the header BEFORE executing; plugin tools
 *  that declared a `headerKey` could opt in to the same early paint.
 *
 *  S29/S31 removed `headerKey` (and the rest of the cosmetic tool
 *  presentation surface) from core's `ToolDefinition` / `ToolRegistry`:
 *  there is no longer a way for a plugin to OPT IN to early painting, so
 *  `tool-round.ts`'s `paintHeaderEarly` now always takes the "defer"
 *  branch for plugin tools (the same branch "instant" tools like Task
 *  always used) — this is `agent.run.test.ts`'s `pres?.headerKey` gate
 *  (now permanently `undefined`), not a bug in this file's test. A
 *  long-running plugin tool is back to showing nothing until it resolves,
 *  until a host (CLI) builds its own static presentation map (S41) and
 *  reintroduces an early-paint opt-in on its side. This test now checks
 *  what core still guarantees: the header, once painted, reads the clean
 *  `displayHeader` text — never the raw `{"url":"…"}` JSON fallback.
 *
 *  Bug 2 — "false stalled": the status row was seeded with
 *  `direction:"down"` + `lastChunkAt`, which makes the activity infix flip
 *  to the amber `⋯ stalled · last byte Ns ago` after 2s of no chunks. But
 *  only Bash ever feeds chunks, so EVERY plugin tool was guaranteed to read
 *  "stalled" after 2 seconds even while perfectly healthy. A non-streaming
 *  tool must NOT seed the stall machinery. Unaffected by S29/S31.
 *
 * Both are framework bugs in the shared tool-dispatch round
 * (`src/agent/tool-round.ts` :: `executeToolRound`), not in any specific
 * plugin.
 */
import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { GLOBAL_STATUS_BUS, type StatusActivity } from "../bus/status.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { TUIResult } from "../plugins/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

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
    getExtraTools: () => [
      {
        name: "Fetch",
        description: "fetch a page",
        input_schema: { type: "object", properties: { url: { type: "string" } } },
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

describe("plugin tool header: deferred to the result's displayHeader (S29/S31)", () => {
  it("shows the clean displayHeader text once dispatch resolves, never raw JSON", async () => {
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
    const agent = await buildTestCore({
      auth,
      sendFn: fetchSendFn(),
      loader,
      writeTranscript: (l) => lines.push(l),
    })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // No cosmetic presentation data survives into core anymore (S29/S31
    // dropped `headerKey`, the opt-in signal), so a plugin tool can no
    // longer paint its header before `loader.dispatch()` resolves — same
    // as any other plugin tool with no declared header field.
    expect(headerLinesAtDispatchEntry).toBe(0)

    // What core still guarantees once the header IS painted: it is the
    // result's clean `displayHeader` text, never the raw `{"url":"…"}`
    // JSON fallback.
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
    const agent = await buildTestCore({
      auth,
      sendFn: fetchSendFn(),
      loader,
      writeTranscript: () => {},
    })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }
    unsub()

    expect(seen.length).toBeGreaterThanOrEqual(1)
    const seed = seen[0]
    // A host renders "⋯ stalled" only for a download with a last-chunk
    // stamp that is too old. The seed for a non-streaming tool must not
    // carry that stamp, so no host can show it as stalled.
    const stallCandidate = seed.direction === "down" && seed.lastChunkAt != null
    expect(stallCandidate).toBe(false)
  }, 10_000)
})

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
 *  Spec S24/S29: core emits a `started` event (with `pluginTool: true`)
 *  BEFORE `loader.dispatch()` runs, and a `plugin_result` event with the
 *  plugin's header text after it returns. The host (CLI) keeps the
 *  `headerKey` opt-in in its own static presentation map (S41) and paints
 *  the header from the `started` event when the tool has one.
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
import type { StatusActivity } from "../bus/status.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { TUIResult } from "../plugins/types.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import type { ToolViewEvent } from "./tool-view-port.ts"

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

describe("plugin tool view events: started before dispatch (S24/S29)", () => {
  it("emits `started` before dispatch and the plugin header text after it", async () => {
    const events: ToolViewEvent[] = []
    let eventsAtDispatchEntry: string[] = []
    const loader = makeLoaderStub({
      result: {
        kind: "tool_result",
        content: "BODY",
        display: "BODY",
        displayHeader: "https://example.com/page",
      },
      onDispatchEntry: () => {
        eventsAtDispatchEntry = events.map((e) => e.type)
      },
    })
    const agent = await buildTestCore({
      auth,
      sendFn: fetchSendFn(),
      loader,
      toolView: { onToolEvent: (e) => void events.push(e) },
    })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // The host can paint the header before the handler returns.
    expect(eventsAtDispatchEntry).toEqual(["started"])
    const started = events[0]
    expect(started?.type === "started" ? started.pluginTool : null).toBe(true)

    // The plugin header text reaches the host as is, never as raw JSON.
    const result = events.find((e) => e.type === "plugin_result")
    expect(result?.type === "plugin_result" ? result.view.displayHeader : null).toBe(
      "https://example.com/page",
    )
  }, 10_000)
})

describe("plugin tool: no false 'stalled' seed (Bug 2)", () => {
  it("seeded status activity does not render as stalled for a non-streaming tool", async () => {
    // Capture the activity the agent seeds for the `running_tool` Fetch
    // status. The status goes through the injected port (spec S23).
    const seen: StatusActivity[] = []
    const statusPort: StatusPort = {
      open(fields) {
        const isFetch = fields.phase === "running_tool" && fields.toolName === "Fetch"
        return {
          update: () => {},
          updateActivity: (a) => {
            if (isFetch) seen.push(a)
          },
          clear: () => {},
        }
      },
    }

    const loader = makeLoaderStub({
      result: { kind: "tool_result", content: "BODY", display: "BODY" },
    })
    const agent = await buildTestCore({
      auth,
      sendFn: fetchSendFn(),
      loader,
      statusPort,
    })
    const gen = agent.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(seen.length).toBeGreaterThanOrEqual(1)
    const seed = seen[0]
    // A host renders "⋯ stalled" only for a download with a last-chunk
    // stamp that is too old. The seed for a non-streaming tool must not
    // carry that stamp, so no host can show it as stalled.
    const stallCandidate = seed.direction === "down" && seed.lastChunkAt != null
    expect(stallCandidate).toBe(false)
  }, 10_000)
})

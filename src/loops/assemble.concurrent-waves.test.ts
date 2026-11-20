/**
 * `openAgentCoreSession` forwards `maxConcurrentToolCalls` to the runtime
 * session (the event-stream and ACP routes of the CLI, and sub-agent
 * workers, open their session here). A fake provider asks for 2 calls of a
 * concurrency-safe plugin tool in one response. Each run waits on a gate.
 * With cap 2 the 2 runs overlap (peak 2). With cap 1 they do not (peak 1).
 *
 * @module loops/assemble.concurrent-waves.test
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"

import { openAgentCoreSession } from "./assemble.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** The time a run waits for the other run before it gives up (test only). */
const OVERLAP_WAIT_MS = 300

interface Probe {
  loader: PluginLoader
  peak(): number
  starts: string[]
}

/**
 * A loader stub with one plugin tool `Look` (concurrency-safe flag). Each
 * run waits until 2 runs are in flight, or until `OVERLAP_WAIT_MS` (so a
 * serial run ends and the test fails on the peak, not on a hang).
 */
function probe(): Probe {
  let running = 0
  let peak = 0
  const starts: string[] = []
  let openBoth = () => {}
  const both = new Promise<void>((res) => {
    openBoth = res
  })
  const loader = {
    getPromptBlocksAsync: async () => ({ afterInstructions: null, sessionContext: null }),
    getPromptBlock: () => null,
    getExtraTools: () => [
      { name: "Look", description: "look", input_schema: { type: "object", properties: {} } },
    ],
    getToolAliases: () => new Map<string, string>(),
    hasTool: (name: string) => name === "Look",
    toolConcurrency: (name: string) => (name === "Look" ? { flag: true } : undefined),
    dispatch: async (trigger: { tool_use_id: string }) => {
      starts.push(trigger.tool_use_id)
      running++
      peak = Math.max(peak, running)
      if (running >= 2) openBoth()
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        both,
        new Promise<void>((res) => {
          timer = setTimeout(res, OVERLAP_WAIT_MS)
        }),
      ])
      clearTimeout(timer)
      running--
      return { kind: "tool_result" as const, content: `ok ${trigger.tool_use_id}`, is_error: false }
    },
  } as unknown as PluginLoader
  return { loader, peak: () => peak, starts }
}

/** Round 1: 2 `Look` calls in one response. Round 2: end the turn. */
function provider(): (opts: SendOptions) => AsyncGenerator<string, StreamedResponse, undefined> {
  let call = 0
  return async function* (_opts: SendOptions) {
    call++
    yield ""
    if (call === 1) {
      return {
        blocks: [
          { type: "tool_use" as const, id: "a", name: "Look", input: {} },
          { type: "tool_use" as const, id: "b", name: "Look", input: {} },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function runTurn(cap: number | undefined): Promise<Probe> {
  const p = probe()
  const session = await openAgentCoreSession({
    auth: AUTH,
    model: "concurrent-waves-unregistered-model",
    sendFn: provider(),
    loader: p.loader,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    ...(cap !== undefined ? { maxConcurrentToolCalls: cap } : {}),
  })
  try {
    for await (const _entry of session.run("go")) {
      // drain
    }
  } finally {
    session.close()
  }
  return p
}

describe("openAgentCoreSession forwards maxConcurrentToolCalls", () => {
  it("cap 2: the 2 concurrency-safe runs of one response overlap (peak 2)", async () => {
    const p = await runTurn(2)
    expect(p.starts).toEqual(["a", "b"])
    expect(p.peak()).toBe(2)
  })

  it("cap 1: the runs do not overlap (peak 1, the old serial loop)", async () => {
    const p = await runTurn(1)
    expect(p.starts).toEqual(["a", "b"])
    expect(p.peak()).toBe(1)
  })
})

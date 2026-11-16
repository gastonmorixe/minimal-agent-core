import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentCoreConfig } from "./ports.ts"

/**
 * Report-mode probe (plan step S0.2). Boot AgentCore with zero plugins, send
 * "hi", and list every string in the captured request that is not the user
 * text. The list is a snapshot of today's leaks. This test turns strict at
 * step S9.4: then EXPECTED_LEAK_PATHS becomes empty.
 *
 * `allowBareCore` does not exist yet, so this tests today's behavior.
 */

const USER_TEXT = "hi"
const MAX_PREVIEW = 60

/** Caller-supplied config values. They are inputs, not core text. */
const CONFIG_ECHO_PATHS = new Set(["auth.token", "model"])

/**
 * Wire protocol fields, not prose: block kind, role, auth kind and cache
 * markers. Every other string counts as a leak.
 */
const PROTOCOL_PATH = /(^auth\.type$|\.role$|\.type$|\.cache_control\.[a-z]+$)/

interface Leak {
  path: string
  preview: string
  length: number
}

/** Walk any value. Collect every string leaf with its path. */
function collectStrings(value: unknown, path: string, out: Array<{ path: string; text: string }>) {
  if (typeof value === "string") {
    out.push({ path, text: value })
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${path}[${i}]`, out))
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, path === "" ? key : `${path}.${key}`, out)
    }
  }
}

/** Build the leak list: every string except the user text and config echoes. */
function buildLeakList(request: unknown): Leak[] {
  const all: Array<{ path: string; text: string }> = []
  collectStrings(request, "", all)
  return all
    .filter((s) => s.text !== USER_TEXT)
    .filter((s) => !CONFIG_ECHO_PATHS.has(s.path))
    .filter((s) => !PROTOCOL_PATH.test(s.path))
    .map((s) => ({
      path: s.path,
      preview: s.text.slice(0, MAX_PREVIEW),
      length: s.text.length,
    }))
}

/**
 * The current snapshot, as sorted paths. To shrink after a fix, delete the
 * line of the removed leak. Growth fails the test.
 */
// P3.4: core holds no prompt text. Bare core sends only the user text.
const EXPECTED_LEAK_PATHS: string[] = []

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

async function captureBareRequest(): Promise<unknown> {
  let captured: unknown
  const sendFn = async function* (
    opts: unknown,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    captured = JSON.parse(JSON.stringify(opts))
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const config: AgentCoreConfig = {
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    sendFn: sendFn as never,
  }
  const core = new AgentCore(config)
  const gen = core.run(USER_TEXT)
  while (!(await gen.next()).done) {
    // drain
  }
  return captured
}

describe("bare core request (report mode)", () => {
  it("snapshots every non-user string in the request", async () => {
    const request = await captureBareRequest()
    const leaks = buildLeakList(request)
    if (process.env.BARE_CORE_DUMP === "1") {
      console.log(JSON.stringify(leaks, null, 2))
    }
    expect(leaks.map((l) => l.path).sort()).toEqual(EXPECTED_LEAK_PATHS)
    expect(leaks.length).toBe(EXPECTED_LEAK_PATHS.length)
  })

  it("keeps the user text in the request", async () => {
    const all: Array<{ path: string; text: string }> = []
    collectStrings(await captureBareRequest(), "", all)
    expect(all.some((s) => s.text === USER_TEXT)).toBe(true)
  })
})

describe("bare core synthetic text (no provider)", () => {
  it("sends no synthetic prose: every unowned kind resolves to empty text", async () => {
    const requests: unknown[] = []
    let round = 0
    const sendFn = async function* (
      opts: unknown,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      requests.push(JSON.parse(JSON.stringify(opts)))
      round++
      // Round 1 stops on max_tokens with no blocks. With no `continue.*`
      // text the core adds no placeholder and no nudge (follow-up 15a): the
      // turn ends truncated, so a round 2 would mean an empty block was sent.
      if (round === 1) return { blocks: [], text: "", stopReason: "max_tokens" } as never
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [] },
      toolExecutor: { execute: async () => ({ content: "", isError: false }) },
      sendFn: sendFn as never,
    })
    // `runtime.turn_aborted` marker on the first user message.
    core.notePreviousTurnAborted()
    const gen = core.run(USER_TEXT)
    while (!(await gen.next()).done) {
      // drain
    }
    expect(requests.length).toBe(1)
    const all: Array<{ path: string; text: string }> = []
    collectStrings((requests[0] as { messages: unknown }).messages, "messages", all)
    const prose = all
      .filter((s) => !PROTOCOL_PATH.test(s.path))
      .filter((s) => s.text !== USER_TEXT)
      .map((s) => s.text)
    expect(prose).toEqual(prose.map(() => ""))
    // The `runtime.turn_aborted` marker (out of scope of 15a).
    expect(prose.length).toBeGreaterThanOrEqual(1)
  })
})

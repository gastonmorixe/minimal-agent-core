import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentCoreConfig, SessionPersistence } from "./ports.ts"

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

/** One bare-core run (no text provider). Returns every request's messages and the history. */
async function runBare(
  userText: string,
  marker: "aborted" | "resumed",
  providers?: AgentCoreConfig["syntheticTextProviders"],
): Promise<{ requests: Message[][]; messages: Message[]; persisted: unknown[] }> {
  const requests: Message[][] = []
  const persisted: unknown[] = []
  // One round only: an `end_turn` reply ends the turn.
  const sendFn = async function* (opts: {
    messages: Message[]
  }): AsyncGenerator<string, StreamedResponse, undefined> {
    requests.push(JSON.parse(JSON.stringify(opts.messages)) as Message[])
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
    sessionPersistence: {
      appendUser: (content: unknown) => {
        persisted.push(content)
        return "u"
      },
      appendAssistant: () => {},
      appendToolResult: () => {},
      appendNote: () => {},
      appendRewind: () => {},
    } as unknown as SessionPersistence,
    ...(providers ? { syntheticTextProviders: providers } : {}),
  })
  if (marker === "aborted") core.notePreviousTurnAborted()
  else core.noteSessionResumed()
  const gen = core.run(userText)
  while (!(await gen.next()).done) {
    // drain
  }
  return { requests, messages: core.messages, persisted }
}

const STRIP_CACHE = (m: Message[]): Message[] =>
  JSON.parse(JSON.stringify(m, (k, v) => (k === "cache_control" ? undefined : v))) as Message[]

describe("bare core synthetic text (no provider)", () => {
  it("sends no synthetic prose: every unowned kind adds no block", async () => {
    // `runtime.turn_aborted` marker on the first user message. The
    // continuation kinds are covered in continuation.test.ts (15a).
    const { requests } = await runBare(USER_TEXT, "aborted")
    expect(requests.length).toBe(1)
    const all: Array<{ path: string; text: string }> = []
    collectStrings(requests[0], "messages", all)
    const prose = all
      .filter((s) => !PROTOCOL_PATH.test(s.path))
      .filter((s) => s.text !== USER_TEXT)
      .map((s) => s.text)
    // 15b: the marker has no text, so it adds no block at all.
    expect(prose).toEqual([])
  })

  for (const marker of ["aborted", "resumed"] as const) {
    it(`${marker} marker: no empty text block, the user text alone`, async () => {
      const { requests, persisted } = await runBare(USER_TEXT, marker)
      expect(STRIP_CACHE(requests[0] as Message[])).toEqual([
        { role: "user", content: [{ type: "text", text: USER_TEXT }] },
      ])
      expect(persisted).toEqual([[{ type: "text", text: USER_TEXT }]])
    })

    it(`${marker} marker, empty user text: no empty user message`, async () => {
      const { messages, persisted } = await runBare("", marker)
      for (const m of messages) expect(m.content.length).toBeGreaterThan(0)
      expect(messages.some((m) => m.role === "user")).toBe(false)
      expect(persisted).toEqual([])
    })

    it(`${marker} marker with a provider: the marker block is sent`, async () => {
      const kind = marker === "aborted" ? "runtime.turn_aborted" : "runtime.session_resumed"
      const { requests } = await runBare(USER_TEXT, marker, [
        { kinds: [kind], text: () => "MARKER" },
      ])
      expect(STRIP_CACHE(requests[0] as Message[])).toEqual([
        {
          role: "user",
          content: [
            { type: "text", text: "MARKER" },
            { type: "text", text: USER_TEXT },
          ],
        },
      ])
    })
  }
})

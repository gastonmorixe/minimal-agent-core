/**
 * Item 8: the compaction request passes `message.willSend`
 * (`LifecyclePort.beforeSend`) on BOTH compact paths (local summary and
 * remote `adapter.compact`). A redactor must see the request, a deny must
 * give the stub with no network call, and the 401 retry must reuse the
 * redacted request without a second hook call.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { resetDefaultAuthStoreForTests } from "../auth/auth-store.ts"
import type { CanonicalEvent } from "../llm/canonical-events.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { registerTestProvider, sseBodyFromEvents } from "../llm/test-fixtures.ts"
import { NetworkClient, NetworkResponse, type NetworkTransport } from "../network/index.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import {
  type LifecyclePort,
  NOOP_LIFECYCLE,
  type PolicyDecision,
  type SendSnapshot,
} from "../sdk/lifecycle.ts"

import { runCompact } from "./run-compact.ts"

const PROV = "compact-hook-prov"
/** Fixed system block so (f) can check object identity. */
const BILLING = {
  type: "text" as const,
  text: "billing",
  cache: { kind: "ephemeral" as const, ttl: "1h" as const, scope: "global" as const },
}
const MODEL = "compact-hook-model"

function summaryEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_hook",
      modelId: MODEL,
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    { type: "text_stop", index: 0 },
    { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
    { type: "message_stop" },
  ]
}

/** Stream that sends some text, then a retryable mid-stream error. */
function partialThenErrorEvents(text: string): CanonicalEvent[] {
  return [
    {
      type: "message_start",
      messageId: "msg_hook_partial",
      modelId: MODEL,
      initialUsage: { inputTokens: 1, outputTokens: 0 },
    },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text },
    {
      type: "stream_error",
      retryable: true,
      category: "api",
      upstreamType: "stream_closed_without_terminal",
      cause: new Error("flaky"),
    },
  ]
}

function scrub(s: string): string {
  return s.replaceAll("FAKESECRET", "[REDACTED]")
}

function scrubContent(c: string | ContentBlock[]): string | ContentBlock[] {
  if (typeof c === "string") return scrub(c)
  return c.map((b) => {
    if (b.type === "text") return { ...b, text: scrub(b.text) }
    if (b.type === "tool_result" && typeof b.content === "string") {
      return { ...b, content: scrub(b.content) }
    }
    return b
  })
}

/** Listener that replaces FAKESECRET in messages and system blocks. */
function redactingLifecycle(seen: SendSnapshot[]): LifecyclePort {
  return {
    async beforeSend(p: SendSnapshot): Promise<PolicyDecision<SendSnapshot>> {
      seen.push(p)
      const system =
        typeof p.system === "string"
          ? scrub(p.system)
          : p.system.map((b) => (b.type === "text" ? { ...b, text: scrub(b.text) } : b))
      return {
        action: "allow",
        payload: {
          ...p,
          messages: p.messages.map((m) => ({ ...m, content: scrubContent(m.content) })),
          system,
        },
      }
    },
  }
}

function denyLifecycle(calls: { n: number }, action: "deny" | "ask" = "deny"): LifecyclePort {
  return {
    async beforeSend(p: SendSnapshot): Promise<PolicyDecision<SendSnapshot>> {
      calls.n++
      return action === "ask"
        ? { action: "ask", reason: "fake policy ask", payload: p }
        : { action: "deny", reason: "fake policy deny" }
    },
  }
}

/** Wrap a port so each afterSend call is recorded. */
function withAfterSend(port: LifecyclePort, after: SendSnapshot[]): LifecyclePort {
  return {
    ...port,
    afterSend(p: SendSnapshot) {
      after.push(p)
    },
  }
}

/** Same as the host adapter with no listener: allow, payload unchanged. */
const passThroughLifecycle: LifecyclePort = {
  async beforeSend(p: SendSnapshot): Promise<PolicyDecision<SendSnapshot>> {
    return { action: "allow", payload: p }
  },
}

function history(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 8; i++) {
    out.push({ role: "user", content: `u${i} token=FAKESECRET` })
    out.push({ role: "assistant", content: `a${i}` })
  }
  return out
}

function reqJson(req: CanonicalRequest): string {
  const { signal: _s, ...rest } = req
  return JSON.stringify(rest)
}

describe("runCompact passes message.willSend (item 8)", () => {
  let dir: string
  const prevAuthFile = process.env.MINIMAL_AGENT_AUTH_FILE
  let netCalls = 0
  let runReqs: CanonicalRequest[] = []
  let compactReqs: CanonicalRequest[] = []
  let compactFail401 = 0
  let netFail401 = 0
  /** Count of local summary streams that end in a retryable error. */
  let netPartial = 0
  let client: NetworkClient
  let handle: ReturnType<typeof registerTestProvider>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-run-compact-hook-"))
    process.env.MINIMAL_AGENT_AUTH_FILE = join(dir, "auth.jsonc")
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    netCalls = 0
    runReqs = []
    compactReqs = []
    compactFail401 = 0
    netFail401 = 0
    netPartial = 0

    handle = registerTestProvider({ id: PROV, shortCode: "chp", models: [{ id: MODEL }] })
    const innerRun = handle.adapter.run.bind(handle.adapter)
    handle.adapter.run = (req, model, ctx) => {
      runReqs.push(req)
      return innerRun(req, model, ctx)
    }
    handle.adapter.compact = async (input) => {
      netCalls++
      compactReqs.push(input.req)
      if (compactFail401 > 0) {
        compactFail401--
        throw Object.assign(new Error("HTTP 401: token expired"), { status: 401 })
      }
      return {
        kind: "remote",
        replacementMessages: [
          { role: "user", content: "remote-compacted" },
          { role: "assistant", content: "ok" },
        ],
      }
    }
    handle.plugin.resolveSystemPrompt = (inp) => [
      BILLING,
      { type: "text", text: "identity FAKESECRET" },
      ...inp.body,
    ]

    const transport: NetworkTransport = {
      id: "fake",
      request: async () => {
        netCalls++
        if (netFail401 > 0) {
          netFail401--
          return new NetworkResponse({
            status: 401,
            headers: { "content-type": "application/json" },
            transport: { id: "fake", protocol: "h2" },
            body: new Response('{"error":"expired"}').body!,
          })
        }
        if (netPartial > 0) {
          netPartial--
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            transport: { id: "fake", protocol: "h2" },
            body: sseBodyFromEvents(partialThenErrorEvents("partial-summary")),
          })
        }
        return new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: sseBodyFromEvents(summaryEvents("fake-summary")),
        })
      },
    }
    client = new NetworkClient({ primary: transport })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetDefaultAuthStoreForTests()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevAuthFile === undefined) delete process.env.MINIMAL_AGENT_AUTH_FILE
    else process.env.MINIMAL_AGENT_AUTH_FILE = prevAuthFile
  })

  function base(mode: "local" | "remote", lifecycle?: LifecyclePort, notes?: string[]) {
    return {
      messages: history(),
      model: MODEL,
      providerId: PROV,
      auth: { type: "api-key" as const, token: "fake-key" },
      reason: "manual" as const,
      mode,
      networkClient: client,
      sleep: async () => {},
      lifecycle: lifecycle ?? NOOP_LIFECYCLE,
      ...(notes ? { appendNote: (t: string) => notes.push(t) } : {}),
    }
  }

  it("(a) local: listener sees the summary request, adapter gets the redacted body", async () => {
    const seen: SendSnapshot[] = []
    const stats = await runCompact(base("local", redactingLifecycle(seen)))
    expect(stats.summaryText).toBe("fake-summary")
    expect(seen.length).toBe(1)
    expect(JSON.stringify(seen[0]!.messages)).toContain("FAKESECRET")
    expect(seen[0]!.model).toBe(MODEL)
    expect(seen[0]!.providerId).toBe(PROV)
    expect(runReqs.length).toBe(1)
    const body = reqJson(runReqs[0]!)
    expect(body).not.toContain("FAKESECRET")
    expect(body).toContain("[REDACTED]")
  })

  it("(a) remote: listener sees the compact request, adapter gets the redacted body", async () => {
    const seen: SendSnapshot[] = []
    const stats = await runCompact(base("remote", redactingLifecycle(seen)))
    expect(stats.kind).toBe("remote")
    expect(seen.length).toBe(1)
    expect(JSON.stringify(seen[0]!.messages)).toContain("FAKESECRET")
    expect(compactReqs.length).toBe(1)
    const body = reqJson(compactReqs[0]!)
    expect(body).not.toContain("FAKESECRET")
    expect(body).toContain("[REDACTED]")
  })

  it("(b) local deny: stub checkpoint, zero network calls", async () => {
    const calls = { n: 0 }
    const notes: string[] = []
    const stats = await runCompact(base("local", denyLifecycle(calls), notes))
    expect(calls.n).toBe(1)
    expect(netCalls).toBe(0)
    expect(runReqs.length).toBe(0)
    expect(stats.kind).toBe("local")
    expect(stats.summaryText).toBeUndefined()
    expect(stats.messagesAfter).toBeGreaterThan(0)
    expect(notes.join("\n")).toContain(
      "compact: send policy denied the summary request (fake policy deny), using stub",
    )
    expect(notes.join("\n")).not.toContain("FAKESECRET")
  })

  it("(c) remote deny: stub checkpoint, zero network calls", async () => {
    const calls = { n: 0 }
    const notes: string[] = []
    const stats = await runCompact(base("remote", denyLifecycle(calls), notes))
    expect(calls.n).toBe(1)
    expect(netCalls).toBe(0)
    expect(compactReqs.length).toBe(0)
    expect(runReqs.length).toBe(0)
    expect(stats.kind).toBe("local")
    expect(notes.join("\n")).toContain(
      "compact: send policy denied remote compact (fake policy deny), using stub",
    )
    expect(notes.join("\n")).not.toContain("FAKESECRET")
  })

  it("(d) remote 401 retry: hook runs once, both attempts send the redacted body", async () => {
    const seen: SendSnapshot[] = []
    compactFail401 = 1
    const stats = await runCompact({
      ...base("remote", redactingLifecycle(seen)),
      auth: { type: "oauth", token: "old", refresh: async () => ({ type: "oauth", token: "new" }) },
    })
    expect(stats.kind).toBe("remote")
    expect(seen.length).toBe(1)
    expect(compactReqs.length).toBe(2)
    for (const r of compactReqs) expect(reqJson(r)).not.toContain("FAKESECRET")
  })

  it("(d) local 401 retry: hook runs once, both attempts send the redacted body", async () => {
    const seen: SendSnapshot[] = []
    netFail401 = 1
    const stats = await runCompact({
      ...base("local", redactingLifecycle(seen)),
      auth: { type: "oauth", token: "old", refresh: async () => ({ type: "oauth", token: "new" }) },
    })
    expect(stats.summaryText).toBe("fake-summary")
    expect(seen.length).toBe(1)
    expect(runReqs.length).toBe(2)
    for (const r of runReqs) expect(reqJson(r)).not.toContain("FAKESECRET")
  })

  it("(e) no listener: request byte-identical to no lifecycle", async () => {
    for (const mode of ["local", "remote"] as const) {
      runReqs = []
      compactReqs = []
      await runCompact(base(mode))
      const before = mode === "local" ? runReqs[0]! : compactReqs[0]!
      runReqs = []
      compactReqs = []
      await runCompact(base(mode, passThroughLifecycle))
      const after = mode === "local" ? runReqs[0]! : compactReqs[0]!
      expect(reqJson(after)).toBe(reqJson(before))
      runReqs = []
      compactReqs = []
      await runCompact(base(mode, {}))
      const empty = mode === "local" ? runReqs[0]! : compactReqs[0]!
      expect(reqJson(empty)).toBe(reqJson(before))
    }
  })

  it("(g) local: listener sees the legacy history with tool blocks, redaction reaches the flat summary", async () => {
    const hist: Message[] = [
      { role: "user", content: "run the tool" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "env" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "API_KEY=FAKESECRET" }],
      },
      { role: "assistant", content: "done" },
    ]
    const expected = structuredClone(hist)
    const seen: SendSnapshot[] = []
    // Redacts ONLY inside tool_result blocks: a flat text view cannot satisfy it.
    const toolResultRedactor: LifecyclePort = {
      async beforeSend(p: SendSnapshot): Promise<PolicyDecision<SendSnapshot>> {
        seen.push(structuredClone(p))
        const messages = p.messages.map((m) =>
          typeof m.content === "string"
            ? m
            : {
                ...m,
                content: m.content.map((b) =>
                  b.type === "tool_result" && typeof b.content === "string"
                    ? { ...b, content: scrub(b.content) }
                    : b,
                ),
              },
        )
        return { action: "allow", payload: { ...p, messages } }
      },
    }
    const stats = await runCompact({ ...base("local", toolResultRedactor), messages: hist })
    expect(stats.summaryText).toBe("fake-summary")
    expect(seen.length).toBe(1)
    const msgs = seen[0]!.messages
    expect(msgs).toEqual(expected)
    const blocks = msgs.flatMap((m) => (typeof m.content === "string" ? [] : m.content))
    const use = blocks.find((b) => b.type === "tool_use")
    const result = blocks.find((b) => b.type === "tool_result")
    expect(use?.type === "tool_use" ? use.id : undefined).toBe("tu_1")
    expect(result?.type === "tool_result" ? result.tool_use_id : undefined).toBe("tu_1")
    expect(typeof seen[0]!.system === "string" || Array.isArray(seen[0]!.system)).toBe(true)
    expect(runReqs.length).toBe(1)
    const flat = runReqs[0]!.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
    expect(flat).toContain("[REDACTED]")
    expect(flat).not.toContain("FAKESECRET")
  })

  it("(f) system blocks unchanged by the listener keep their cache objects", async () => {
    for (const mode of ["local", "remote"] as const) {
      runReqs = []
      compactReqs = []
      await runCompact(base(mode, redactingLifecycle([])))
      const req = mode === "local" ? runReqs[0]! : compactReqs[0]!
      const sys = req.system ?? []
      expect(sys[0]).toBe(BILLING)
      expect(sys[1]).toEqual({ type: "text", text: "identity [REDACTED]" })
      expect(sys.length).toBe(3)
    }
  })

  it("(h) ask decision: stub checkpoint, zero network calls, no wait", async () => {
    for (const mode of ["local", "remote"] as const) {
      netCalls = 0
      const calls = { n: 0 }
      const notes: string[] = []
      const stats = await runCompact(base(mode, denyLifecycle(calls, "ask"), notes))
      expect(calls.n).toBe(1)
      expect(netCalls).toBe(0)
      expect(stats.kind).toBe("local")
      expect(notes.join("\n")).toContain("(fake policy ask), using stub")
    }
  })

  it("(i) a throwing direct port: note holds the error name only, never the message", async () => {
    const throwing: LifecyclePort = {
      async beforeSend(): Promise<PolicyDecision<SendSnapshot>> {
        throw new Error("leak FAKESECRET")
      },
    }
    for (const mode of ["local", "remote"] as const) {
      netCalls = 0
      const notes: string[] = []
      const stats = await runCompact(base(mode, throwing, notes))
      expect(netCalls).toBe(0)
      expect(stats.kind).toBe("local")
      const all = [...notes, stats.summaryError ?? "", stats.remoteError ?? ""].join("\n")
      expect(all).not.toContain("FAKESECRET")
      expect(all).toContain("Error")
    }
  })

  it("(j) afterSend: called once with the redacted snapshot on success, never after a deny", async () => {
    for (const mode of ["local", "remote"] as const) {
      const after: SendSnapshot[] = []
      await runCompact(base(mode, withAfterSend(redactingLifecycle([]), after)))
      expect(after.length).toBe(1)
      expect(JSON.stringify(after[0])).toContain("[REDACTED]")
      expect(JSON.stringify(after[0])).not.toContain("FAKESECRET")
      const denied: SendSnapshot[] = []
      await runCompact(base(mode, withAfterSend(denyLifecycle({ n: 0 }), denied)))
      expect(denied.length).toBe(0)
    }
  })

  it("(n) afterSend: called once on the local saved-partial path", async () => {
    // Two partial streams: one clean retry, then the saved partial returns.
    netPartial = 2
    const after: SendSnapshot[] = []
    const stats = await runCompact(base("local", withAfterSend(redactingLifecycle([]), after)))
    expect(stats.kind).toBe("local")
    expect(stats.summaryText ?? "").toContain("partial-summary")
    expect(runReqs.length).toBe(2)
    expect(after.length).toBe(1)
    expect(JSON.stringify(after[0])).not.toContain("FAKESECRET")
  })

  it("(o) afterSend: called exactly once after a 401 retry, local and remote", async () => {
    for (const mode of ["local", "remote"] as const) {
      runReqs = []
      compactReqs = []
      if (mode === "local") netFail401 = 1
      else compactFail401 = 1
      const after: SendSnapshot[] = []
      const stats = await runCompact({
        ...base(mode, withAfterSend(redactingLifecycle([]), after)),
        auth: {
          type: "oauth",
          token: "old",
          refresh: async () => ({ type: "oauth", token: "new" }),
        },
      })
      expect(stats.kind).toBe(mode)
      if (mode === "local") expect(runReqs.length).toBe(2)
      else expect(compactReqs.length).toBe(2)
      expect(after.length).toBe(1)
    }
  })

  it("(p) a throwing afterSend never fails compaction", async () => {
    for (const mode of ["local", "remote"] as const) {
      let calls = 0
      const port: LifecyclePort = {
        ...redactingLifecycle([]),
        afterSend() {
          calls++
          throw new Error("observer FAKESECRET")
        },
      }
      const stats = await runCompact(base(mode, port))
      expect(calls).toBe(1)
      expect(stats.kind).toBe(mode)
      if (mode === "local") expect(stats.summaryText).toBe("fake-summary")
    }
  })

  it("(k) non-text system block: kept in place, never shown to the listener", async () => {
    // Plugin types allow text only: a non-text block arrives only from an untyped plugin.
    const IMG = { type: "image", source: { kind: "url", url: "https://x/i.png" } } as unknown as {
      type: "text"
      text: string
    }
    handle.plugin.resolveSystemPrompt = (inp) => [
      BILLING,
      IMG,
      { type: "text", text: "identity FAKESECRET" },
      ...inp.body,
    ]
    const seen: SendSnapshot[] = []
    await runCompact(base("remote", redactingLifecycle(seen)))
    expect(JSON.stringify(seen[0]!.system)).not.toContain("image")
    const sys = compactReqs[0]!.system ?? []
    expect(sys.length).toBe(4)
    expect(sys[0]).toBe(BILLING)
    expect(sys[1]).toBe(IMG)
    expect(sys[2]).toEqual({ type: "text", text: "identity [REDACTED]" })
  })

  it("(l) text block count change: non-text blocks first, then the listener's text", async () => {
    // Plugin types allow text only: a non-text block arrives only from an untyped plugin.
    const IMG = { type: "image", source: { kind: "url", url: "https://x/i.png" } } as unknown as {
      type: "text"
      text: string
    }
    handle.plugin.resolveSystemPrompt = (inp) => [BILLING, IMG, ...inp.body]
    const dropFirst: LifecyclePort = {
      async beforeSend(p: SendSnapshot): Promise<PolicyDecision<SendSnapshot>> {
        const system = Array.isArray(p.system) ? p.system.slice(1) : p.system
        return { action: "allow", payload: { ...p, system } }
      },
    }
    await runCompact(base("remote", dropFirst))
    const sys = compactReqs[0]!.system ?? []
    expect(sys.length).toBe(2)
    expect(sys[0]).toBe(IMG)
    expect(sys[1]?.type).toBe("text")
    expect(JSON.stringify(sys[1])).not.toContain("billing")
  })

  it("(m) wiring: AgentCore.compact passes its lifecycle into the compact send hook", async () => {
    for (const mode of ["local", "remote"] as const) {
      runReqs = []
      compactReqs = []
      const seen: SendSnapshot[] = []
      const core = new AgentCore({
        auth: { type: "api-key", token: "fake-key" },
        model: MODEL,
        providerId: PROV,
        systemPrompt: "",
        maxTokens: 4096,
        toolRegistry: { list: () => [] },
        toolExecutor: {
          async execute() {
            return { content: "", isError: false }
          },
        },
        transcriptSink: { write() {} },
        initialMessages: history(),
        networkClient: client,
        lifecycle: redactingLifecycle(seen),
        sendFn: async function* () {
          return { blocks: [], text: "", stopReason: "end_turn" }
        },
      })
      await core.compact({ mode })
      expect(seen.length).toBe(1)
      const req = mode === "local" ? runReqs[0] : compactReqs[0]
      expect(req).toBeDefined()
      expect(reqJson(req!)).not.toContain("FAKESECRET")
      expect(reqJson(req!)).toContain("[REDACTED]")
    }
  })
})

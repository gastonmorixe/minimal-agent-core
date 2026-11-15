/**
 * Unit tests for {@link buildAgentCore}: the async Tier-1 assembly seam.
 * Verifies it returns a runnable {@link AgentCore} that reflects the wired
 * adapters (tools listed, plugin prompt block folded into the system prompt,
 * no crash on the minimal null-collaborator config).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { sendOptionsToCanonical } from "../llm/codec/request-codec.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import { PluginLoader } from "../plugins/loader.ts"
import type { SessionEntry } from "../runtime/session.ts"
import { TOOL_DEFINITIONS } from "../tools/tools.ts"

import { buildAgentCore, openAgentCoreSession } from "./assemble.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return text
    text += value
  }
}

describe("buildAgentCore", () => {
  it("returns a runnable AgentCore with the minimal null-collaborator config", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    expect(await drain(core.run("go"))).toBe("hi")
  })

  it("folds the plugin prompt block into the system prompt sent to the transport", async () => {
    let capturedSystem: unknown
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      capturedSystem = opts.system
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const loader = {
      getPromptBlockAsync: async () =>
        '<ma::sys::tool name="Widget">MAGIC_MARKER_TEXT</ma::sys::tool>',
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    await drain(core.run("go"))
    // The plugin block text must appear somewhere in the resolved system prompt.
    const systemStr = JSON.stringify(capturedSystem)
    expect(systemStr).toContain("MAGIC_MARKER_TEXT")
  })

  it("advertises core tools (and plugin tools) on the request", async () => {
    let capturedTools: Array<{ name: string }> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      capturedTools = (opts.tools ?? []) as Array<{ name: string }>
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const loader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [{ name: "Widget", description: "w", input_schema: {} }],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    await drain(core.run("go"))
    const names = capturedTools.map((t) => t.name)
    // Core built-ins present, plugin tool appended.
    for (const t of TOOL_DEFINITIONS) expect(names).toContain(t.name)
    expect(names).toContain("Widget")
  })

  it("toolNamePolicy narrows advertised tools via the toolFilter port", async () => {
    let capturedTools: Array<{ name: string }> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      capturedTools = (opts.tools ?? []) as Array<{ name: string }>
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const loader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [
        { name: "Widget", description: "w", input_schema: {} },
        { name: "WebSearch", description: "s", input_schema: {} },
      ],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader,
      modeManager: null,
      toolNamePolicy: { kind: "allow-list", tools: ["WebSearch"] },
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    await drain(core.run("go"))
    expect(capturedTools.map((t) => t.name)).toEqual(["WebSearch"])
  })
})

describe("appendSystemPrompt (M2)", () => {
  // Markers make each part easy to find in the joined system text.
  const INSTRUCTIONS = "INSTRUCTIONS_MARKER"
  const SESSION_CTX = '<ma::sys::tool name="Widget">SESSION_CTX_MARKER</ma::sys::tool>'
  const APPENDED = "APPENDED_MARKER"

  function capture(): {
    sendFn: (opts: SendOptions) => AsyncGenerator<string, StreamedResponse, undefined>
    systemText: () => string
    rawJson: () => string
  } {
    let captured: unknown
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      captured = opts.system
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const systemText = (): string => {
      const blocks = (Array.isArray(captured) ? captured : []) as Array<{ text?: string }>
      return blocks.map((b) => b.text ?? "").join("\n")
    }
    return { sendFn, systemText, rawJson: () => JSON.stringify(captured) }
  }

  function loader(): PluginLoader {
    return {
      getPromptBlockAsync: async () => SESSION_CTX,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader
  }

  function deps(
    sendFn: (opts: SendOptions) => AsyncGenerator<string, StreamedResponse, undefined>,
    appendSystemPrompt?: string,
  ) {
    return {
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader: loader(),
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      systemPromptOverrides: { instructions: { kind: "replace" as const, text: INSTRUCTIONS } },
      ...(appendSystemPrompt !== undefined ? { appendSystemPrompt } : {}),
    }
  }

  it("buildAgentCore: places the text after instructions and before session context", async () => {
    const { sendFn, systemText } = capture()
    const core = await buildAgentCore(deps(sendFn, APPENDED))
    await drain(core.run("go"))
    const text = systemText()
    const iInstr = text.indexOf(INSTRUCTIONS)
    const iAppend = text.indexOf(APPENDED)
    const iCtx = text.indexOf("SESSION_CTX_MARKER")
    expect(iInstr).toBeGreaterThanOrEqual(0)
    expect(iAppend).toBeGreaterThan(iInstr)
    expect(iCtx).toBeGreaterThan(iAppend)
  })

  it("openAgentCoreSession: places the text after instructions and before session context", async () => {
    const { sendFn, systemText } = capture()
    const session = await openAgentCoreSession(deps(sendFn, APPENDED))
    for await (const _entry of session.run("go")) {
      // drain
    }
    session.close()
    const text = systemText()
    const iInstr = text.indexOf(INSTRUCTIONS)
    const iAppend = text.indexOf(APPENDED)
    const iCtx = text.indexOf("SESSION_CTX_MARKER")
    expect(iInstr).toBeGreaterThanOrEqual(0)
    expect(iAppend).toBeGreaterThan(iInstr)
    expect(iCtx).toBeGreaterThan(iAppend)
  })

  it("missing or blank value gives the old system prompt byte for byte", async () => {
    const base = capture()
    await drain((await buildAgentCore(deps(base.sendFn))).run("go"))
    const empty = capture()
    await drain((await buildAgentCore(deps(empty.sendFn, ""))).run("go"))
    const blank = capture()
    await drain((await buildAgentCore(deps(blank.sendFn, "  \n "))).run("go"))
    expect(base.systemText().length).toBeGreaterThan(0)
    // Whole system array (text plus cache_control), not only the text.
    expect(empty.rawJson()).toBe(base.rawJson())
    expect(blank.rawJson()).toBe(base.rawJson())
    expect(base.systemText()).not.toContain(APPENDED)
  })

  it("a full replace override still wins over the appended text", async () => {
    const { sendFn, systemText } = capture()
    const core = await buildAgentCore({
      ...deps(sendFn, APPENDED),
      systemPromptOverrides: { full: { kind: "replace" as const, text: "FULL_ONLY" } },
    })
    await drain(core.run("go"))
    expect(systemText()).toContain("FULL_ONLY")
    expect(systemText()).not.toContain(APPENDED)
  })

  async function startupHashesFor(append?: string) {
    const session = await openAgentCoreSession(deps(capture().sendFn, append))
    const hashes = session.startupHashes
    session.close()
    return hashes
  }

  it("resume hash: missing, empty, or blank append gives the old hash exactly", async () => {
    const base = await startupHashesFor()
    expect(await startupHashesFor("")).toEqual(base)
    expect(await startupHashesFor("  \n ")).toEqual(base)
  })

  it("resume hash: non-blank append changes systemHash only, and trim is applied", async () => {
    const base = await startupHashesFor()
    const a = await startupHashesFor(APPENDED)
    const b = await startupHashesFor("OTHER_APPEND")
    expect(a.systemHash).not.toBe(base.systemHash)
    expect(b.systemHash).not.toBe(a.systemHash)
    expect(a.toolsHash).toBe(base.toolsHash)
    expect(await startupHashesFor(`  ${APPENDED}\n`)).toEqual(a)
  })
})

describe("openAgentCoreSession", () => {
  const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    yield "hi"
    return {
      blocks: [{ type: "text" as const, text: "hi" }],
      text: "hi",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  const baseDeps = {
    auth: AUTH,
    model: "test-model",
    sendFn,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  }

  it("uses the given sessionId for the Session and every entry", async () => {
    const session = await openAgentCoreSession({ ...baseDeps, sessionId: "sid-test" })
    expect(session.id).toBe("sid-test")
    const entries: SessionEntry[] = []
    for await (const entry of session.run("go")) entries.push(entry)
    expect(entries.length).toBeGreaterThan(0)
    for (const entry of entries) expect(entry.sessionId).toBe("sid-test")
    session.close()
  })

  it("keeps a fresh UUID when no sessionId is given", async () => {
    const session = await openAgentCoreSession(baseDeps)
    expect(session.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    session.close()
  })

  it("sends loader diagnostics of a run to the session log as ch:diag entries (S20)", async () => {
    // A real loader with no roots and no injected logger: its default
    // logger and its event bus report through its diagnostics relay.
    const loader = await PluginLoader.load({})
    loader.bus().on("wp06.probe", () => {
      throw new Error("probe listener failed")
    })
    const probeSend = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      loader.bus().emit("wp06.probe", {})
      await new Promise((resolve) => setTimeout(resolve, 5))
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const session = await openAgentCoreSession({
      ...baseDeps,
      sendFn: probeSend,
      loader,
      sessionId: "sid-diag",
    })
    const diags: SessionEntry[] = []
    for await (const entry of session.run("go")) if (entry.ch === "diag") diags.push(entry)
    const probe = diags.find((e) => JSON.stringify(e).includes("probe listener failed"))
    expect(probe).toBeDefined()
    expect(probe?.sessionId).toBe("sid-diag")
    expect(loader.diagnostics().sessionId).toBe("sid-diag")
    session.close()
    // Close detaches the session scope again.
    expect(loader.diagnostics().sessionId).toBeUndefined()
  })

  it("routes loader diagnostics of two concurrent sessions to the session of each run (S20)", async () => {
    // Web opens many sessions on one loader. Each run's loader diagnostics
    // must reach the log of that run's session, not the last opened one.
    const loader = await PluginLoader.load({})
    for (const tag of ["a", "b"]) {
      loader.bus().on(`wp06.probe.${tag}`, () => {
        throw new Error(`probe listener failed for ${tag}`)
      })
    }
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let waiting = 0
    const sendFor = (tag: string) =>
      async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        // Hold both runs until both are in flight, then emit.
        waiting++
        if (waiting === 2) release()
        await gate
        loader.bus().emit(`wp06.probe.${tag}`, {})
        await new Promise((resolve) => setTimeout(resolve, 5))
        yield "hi"
        return {
          blocks: [{ type: "text" as const, text: "hi" }],
          text: "hi",
          stopReason: "end_turn",
        } as StreamedResponse
      }
    const a = await openAgentCoreSession({
      ...baseDeps,
      sendFn: sendFor("a"),
      loader,
      sessionId: "sid-a",
    })
    const b = await openAgentCoreSession({
      ...baseDeps,
      sendFn: sendFor("b"),
      loader,
      sessionId: "sid-b",
    })
    const collect = async (run: AsyncIterable<SessionEntry>): Promise<string[]> => {
      const out: string[] = []
      for await (const entry of run) {
        const text = JSON.stringify(entry)
        if (entry.ch === "diag" && text.includes("probe listener failed")) out.push(text)
      }
      return out
    }
    const [diagsA, diagsB] = await Promise.all([collect(a.run("go")), collect(b.run("go"))])
    expect(diagsA.length).toBe(1)
    expect(diagsA[0]).toContain("failed for a")
    expect(diagsA[0]).toContain('"sessionId":"sid-a"')
    expect(diagsB.length).toBe(1)
    expect(diagsB[0]).toContain("failed for b")
    expect(diagsB[0]).toContain('"sessionId":"sid-b"')
    // Outside a run with two sessions attached, no session is the right
    // one, so the loader reports to its host-level handle.
    expect(loader.diagnostics().sessionId).toBeUndefined()
    a.close()
    b.close()
  })
})

describe("outputStrict (R2)", () => {
  function capture() {
    const canonical: unknown[] = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      canonical.push(sendOptionsToCanonical(opts).outputFormat)
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    return { sendFn, canonical }
  }
  const schema = { title: "Answer", type: "object" }
  const want = { type: "json_schema", schema, name: "Answer", strict: true }
  const deps = (sendFn: ReturnType<typeof capture>["sendFn"]) => ({
    auth: AUTH,
    model: "test-model",
    sendFn,
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    outputSchema: schema,
    outputStrict: true,
  })

  it("buildAgentCore: session strict reaches the canonical request", async () => {
    const { sendFn, canonical } = capture()
    const core = await buildAgentCore(deps(sendFn))
    await drain(core.run("go"))
    expect(canonical).toEqual([want])
  })

  it("openAgentCoreSession: session strict reaches the canonical request", async () => {
    const { sendFn, canonical } = capture()
    const session = await openAgentCoreSession(deps(sendFn))
    for await (const _ of session.run("go")) {
      /* drain */
    }
    expect(canonical).toEqual([want])
    session.close()
  })
})

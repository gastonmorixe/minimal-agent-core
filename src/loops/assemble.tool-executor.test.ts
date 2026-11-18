/**
 * Unit tests for {@link ToolExecutorAdapter}: the verbatim-executeToolRound
 * binding to the {@link ToolExecutor} port.
 *
 * Focus: (1) plugin-tool dispatch flows through and its content/isError map
 * onto {@link ToolExecResult}; (2) the abort signal is forwarded; (3) the
 * tool_use id is preserved END-TO-END when the adapter is driven by a real
 * {@link AgentCore} (the sacred `tool_result.id === item_started.id` join).
 */

import { describe, expect, it } from "bun:test"

import { ToolRegistryAdapter } from "../adapters/tool-registry-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { AgentEvent, EventSink } from "../sdk/events.ts"
import { allowDecision, type LifecyclePort } from "../sdk/lifecycle.ts"
import { internalOutcomeOf } from "../sdk/tool-outcome-record.ts"
import { SidebandCodecMissingError } from "../sideband/errors.ts"
import type { SidebandCodec, SidebandKind } from "../sideband/types.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { ToolExecutorAdapter } from "./assemble.ts"
import type { ToolResultChainEntry } from "./tool-result-chain.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/**
 * A loader stub exposing exactly one plugin tool via `dispatch`, mirroring the
 * in-repo pattern (Wave G deleted on-disk `./plugins`). Records the abort
 * signal it received so the forwarding test can assert on it.
 */
function makeLoaderStub(opts: {
  toolName: string
  content: string
  isError?: boolean
  onDispatch?: (signal?: AbortSignal) => void
}): PluginLoader {
  const stub = {
    hasTool: (name: string) => name === opts.toolName,
    dispatch: async (_trigger: unknown, _cwd: string, signal?: AbortSignal) => {
      opts.onDispatch?.(signal)
      return {
        kind: "tool_result" as const,
        content: opts.content,
        is_error: opts.isError ?? false,
      }
    },
    getExtraTools: () => [
      {
        name: opts.toolName,
        description: "a fixture tool",
        input_schema: { type: "object", properties: {} },
      },
    ],
    getPromptBlockAsync: async () => "",
    getPromptBlock: () => "",
    getToolAliases: () => new Map<string, string>(),
  }
  return stub as unknown as PluginLoader
}

function makeAdapter(loader: PluginLoader | null): ToolExecutorAdapter {
  return new ToolExecutorAdapter({
    loader,
    modeManager: null,
    blobStore: null,
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model: "test-model",
    store: null,
  })
}

describe("ToolExecutorAdapter.execute — plugin tool dispatch", () => {
  it("maps a plugin tool_result's content + is_error onto ToolExecResult", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "widget output" })
    const adapter = makeAdapter(loader)
    const result = await adapter.execute({
      type: "tool_use",
      id: "toolu_abc",
      name: "Widget",
      input: {},
    })
    expect(result.content).toBe("widget output")
    expect(result.isError).toBe(false)
  })

  it("maps an error tool_result to isError:true", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "boom", isError: true })
    const adapter = makeAdapter(loader)
    const result = await adapter.execute({
      type: "tool_use",
      id: "toolu_err",
      name: "Widget",
      input: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content).toBe("boom")
  })

  it("forwards the AbortSignal into plugin dispatch", async () => {
    let seenSignal: AbortSignal | undefined
    const loader = makeLoaderStub({
      toolName: "Widget",
      content: "ok",
      onDispatch: (signal) => {
        seenSignal = signal
      },
    })
    const adapter = makeAdapter(loader)
    const controller = new AbortController()
    await adapter.execute(
      { type: "tool_use", id: "toolu_sig", name: "Widget", input: {} },
      controller.signal,
    )
    expect(seenSignal).toBe(controller.signal)
  })
})

/** Collects every emitted AgentEvent. */
class CaptureEventSink implements EventSink {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

describe("ToolExecutorAdapter — tool_use id passthrough (sacred join)", () => {
  it("preserves tool_result.id === item_started.id through a real AgentCore run", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "done-by-widget" })
    const adapter = makeAdapter(loader)
    const registry = new ToolRegistryAdapter(loader)

    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use" as const, id: "toolu_JOIN_KEY", name: "Widget", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "final"
      return {
        blocks: [{ type: "text" as const, text: "final" }],
        text: "final",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const sink = new CaptureEventSink()
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 0,
      sendFn,
      eventSink: sink,
      toolRegistry: registry,
      toolExecutor: adapter,
    })

    // Drain the run.
    const gen = core.run("go")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const itemStarted = sink.events.find(
      (e) => e.type === "item_started" && e.itemType === "tool_use",
    )
    const toolResult = sink.events.find((e) => e.type === "tool_result")
    if (itemStarted?.type !== "item_started") throw new Error("no tool_use item_started")
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result")
    // The join key must survive the adapter untouched.
    expect(toolResult.id).toBe(itemStarted.id)
    expect(toolResult.id).toBe("toolu_JOIN_KEY")
    expect(toolResult.name).toBe("Widget")
    expect(toolResult.isError).toBe(false)
  })
})

describe("ToolExecutorAdapter — session id on the tool hook payloads", () => {
  it("each AgentCore gives its own sessionFacts sid to tool.willInvoke", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "ok" })
    const sids: Array<string | undefined> = []
    const lifecycle: LifecyclePort = {
      async beforeTool(p) {
        sids.push(p.sid)
        return allowDecision(p)
      },
    }
    for (const sid of ["sid-a", "sid-b"]) {
      const adapter = new ToolExecutorAdapter({
        loader,
        modeManager: null,
        blobStore: null,
        blobSkipTools: new Set(),
        feedbackTracker: new ToolFeedbackTracker(),
        model: "test-model",
        store: null,
        lifecycle,
      })
      let round = 0
      const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        round++
        if (round === 1) {
          return {
            blocks: [{ type: "tool_use" as const, id: `tu_${sid}`, name: "Widget", input: {} }],
            text: "",
            stopReason: "tool_use",
          } as StreamedResponse
        }
        return { blocks: [], text: "", stopReason: "end_turn" } as unknown as StreamedResponse
      }
      const core = new AgentCore({
        auth: AUTH,
        model: "test-model",
        systemPrompt: "",
        maxTokens: 0,
        sendFn,
        toolRegistry: new ToolRegistryAdapter(loader),
        toolExecutor: adapter,
        sessionFacts: () => ({ sid }),
      })
      const gen = core.run("go")
      for (;;) if ((await gen.next()).done) break
    }
    expect(sids).toEqual(["sid-a", "sid-b"])
  })
})

describe("ToolExecutorAdapter.execute — tool-result chain (spec v6.1 D1 items 4, 5)", () => {
  const registry = {
    kind: (name: string): SidebandKind | undefined =>
      name === "known" ? ({ kind: name } as unknown as SidebandKind) : undefined,
  }
  const stamp = (kind: string): ToolResultChainEntry => ({
    pluginId: "p",
    decl: { phase: "stamp", order: 0, transform: (s) => ({ ...s, kind }) },
  })
  const use = { type: "tool_use" as const, id: "toolu_chain", name: "Widget", input: {} }

  function adapterWith(extra: Record<string, unknown>, loader: PluginLoader | null) {
    return new ToolExecutorAdapter({
      loader,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set(),
      feedbackTracker: new ToolFeedbackTracker(),
      model: "test-model",
      store: null,
      ...extra,
    })
  }

  it("passes the chain and the registry deps into the round and maps the mark", async () => {
    // The stub loader has no toolResultChain / sidebandRegistry / diagnostics
    // methods: the adapter must not call them (the typeof guard).
    const loader = makeLoaderStub({ toolName: "Widget", content: "w" })
    const adapter = adapterWith(
      { toolResultChain: [stamp("known")], sidebandRegistry: registry },
      loader,
    )
    const result = await adapter.execute(use)
    expect(result.content).toBe("w")
    expect(result.sideband).toEqual({ kind: "known" })
  })

  it("falls back to the loader chain, registry and diagnostics (M4)", async () => {
    const stub = makeLoaderStub({ toolName: "Widget", content: "w" }) as unknown as Record<
      string,
      unknown
    >
    const seen: string[] = []
    const loaderDiagnostics = createDiagnostics({ emit: (e) => void seen.push(e.source) })
    let diagnosticsCalls = 0
    let kind = "known"
    const loader = {
      ...stub,
      toolResultChain: () => [stamp(kind)],
      sidebandRegistry: () => registry,
      diagnostics: () => {
        diagnosticsCalls++
        return loaderDiagnostics
      },
    } as unknown as PluginLoader
    // makeAdapter gives no chain, registry or `diagnostics` dep: the adapter
    // must use the loader methods for all three.
    const adapter = makeAdapter(loader)
    const result = await adapter.execute(use)
    expect(result.sideband).toEqual({ kind: "known" })
    expect(seen).toEqual([])
    // An unregistered kind: the drop goes to the loader.diagnostics() sink.
    kind = "nope"
    const dropped = await adapter.execute({ ...use, id: "toolu_chain_2" })
    expect("sideband" in dropped).toBe(false)
    expect(diagnosticsCalls).toBeGreaterThan(0)
    expect(seen).toContain("tool-result-chain.sideband-dropped")
  })

  it("an unregistered kind gives no sideband key; the dep diagnostics get the drop", async () => {
    const seen: string[] = []
    const diagnostics = createDiagnostics({ emit: (e) => void seen.push(e.source) })
    const loader = makeLoaderStub({ toolName: "Widget", content: "w" })
    const adapter = adapterWith(
      { toolResultChain: [stamp("nope")], sidebandRegistry: registry, diagnostics },
      loader,
    )
    const result = await adapter.execute(use)
    expect("sideband" in result).toBe(false)
    expect(seen.some((s) => s.startsWith("tool-result-chain"))).toBe(true)
  })

  it("a stub loader with no chain methods runs and gives the same result shape", async () => {
    const loader = makeLoaderStub({ toolName: "Widget", content: "w" })
    const result = await makeAdapter(loader).execute(use)
    expect(result).toEqual({ content: "w", isError: false })
    expect("sideband" in result).toBe(false)
  })

  it("a round result carries the outcome only on the internal channel (spec v6.1 D8 rule 8)", async () => {
    // Since the M1+M2 join the tool round sets the persisted outcome on the
    // block. The public result has no `outcome` key: the record rides on the
    // internal channel (F18), and a host `outcome` key is never copied.
    const loader = makeLoaderStub({ toolName: "Widget", content: "w" })
    const result = await makeAdapter(loader).execute(use)
    expect("outcome" in result).toBe(false)
    expect(JSON.stringify(result)).toBe(JSON.stringify({ content: "w", isError: false }))
    expect(internalOutcomeOf(result)).toEqual({ v: 1, bodyEnd: 1, annotations: [] })
  })

  describe("owner rule 5: core renders the text of a registered kind (E8 S2)", () => {
    const decl = {
      kind: "known",
      owner: "p",
      direction: "to-model",
      placement: "tool-result",
      attrs: {},
      body: "text",
      trust: "untrusted",
      summary: "s",
    } as SidebandKind
    const annotate = (): ToolResultChainEntry => ({
      pluginId: "p",
      decl: {
        phase: "post-blob",
        order: 0,
        transform: (s) => ({
          ...s,
          annotations: [
            ...s.annotations,
            { kind: "known", text: "hand-written", join: "\n\n", body: "b", owner: "p" },
          ],
        }),
      },
    })
    const loaderWith = (reg: unknown, seen: string[] = []) =>
      ({
        ...(makeLoaderStub({ toolName: "Widget", content: "w" }) as unknown as Record<
          string,
          unknown
        >),
        toolResultChain: () => [annotate()],
        sidebandRegistry: () => reg,
        diagnostics: () =>
          createDiagnostics({
            emit: (e) => void seen.push(`${e.source}:${JSON.stringify(e.structuredData ?? {})}`),
          }),
      }) as unknown as PluginLoader

    it("the returned text is the RENDERED text, not the hand-written one", async () => {
      const calls: unknown[] = []
      const codec = {
        render: (d: unknown, msg: unknown) => {
          calls.push([d, msg])
          return "RENDERED"
        },
        neutralize: (t: string) => t,
      } as unknown as SidebandCodec
      const reg = { kind: (n: string) => (n === "known" ? decl : undefined), codec: () => codec }
      const result = await makeAdapter(loaderWith(reg)).execute(use)
      expect(result.content).toBe("w\n\nRENDERED")
      expect(String(result.content)).not.toContain("hand-written")
      expect(calls).toEqual([[decl, { body: "b", kind: "known" }]])
      expect(internalOutcomeOf(result)?.annotations).toHaveLength(1)
    })

    it("a codec() that throws the missing-codec error: annotation dropped, result kept, no-codec", async () => {
      const seen: string[] = []
      const reg = {
        kind: () => decl,
        codec: (): SidebandCodec => {
          throw new SidebandCodecMissingError()
        },
      }
      const result = await makeAdapter(loaderWith(reg, seen)).execute(use)
      expect(result.content).toBe("w")
      expect(result.isError).toBe(false)
      const failed = seen.filter((x) => x.startsWith("tool-result-chain.sideband-render-failed"))
      expect(failed).toHaveLength(1)
      expect(failed[0]).toContain('"cause":"no-codec"')
    })

    it("a registry with no codec function: no renderer in the context, annotation dropped (no-codec)", async () => {
      const seen: string[] = []
      const result = await makeAdapter(loaderWith({ kind: () => decl }, seen)).execute(use)
      expect(result.content).toBe("w")
      const failed = seen.filter((x) => x.startsWith("tool-result-chain.sideband-render-failed"))
      expect(failed).toHaveLength(1)
      expect(failed[0]).toContain('"cause":"no-codec"')
    })
  })
})

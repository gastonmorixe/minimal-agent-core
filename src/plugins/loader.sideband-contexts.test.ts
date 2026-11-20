/**
 * Design step 5: each plugin and core run-time context gets the one
 * sideband API of the session. A tool handler, an event handler, a hook, a
 * prompt fragment, a synthetic text provider, a turn attachment factory and
 * the AgentCore see the same object as `loader.sideband()`. With no codec
 * plugin, its `ready` is false. The boot order: the contract check, then the
 * chain boot, then the text step (a `fail` mode check throws before a
 * transform or codec module import).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  clearTurnAttachmentFactories,
  instantiateTurnAttachments,
  registerTurnAttachmentFactory,
} from "../agent/turn-attachments.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { ContractCheckFailedError } from "../errors/contract-check.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { buildAgentCore, ToolExecutorAdapter } from "../loops/assemble.ts"
import * as toolRound from "../loops/tool-round.ts"
import { ModeManager } from "../modes/modes.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { SidebandApi } from "../sideband/types.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { chainProbeManifest, writeChainProbe } from "./loader.chain-probe.fixtures.ts"
import { CORE_TOOLS, ROOT, toolManifest, withHeadless, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const BASE = join(ROOT, "sideband-contexts")
const NO_PROJECT = join(ROOT, "nope-project")
const KEY = "__sbContexts"

type Seen = Record<string, unknown>
const seen = (): Seen => (globalThis as Record<string, unknown>)[KEY] as Seen

const record = (slot: string) =>
  `(globalThis.${KEY} ??= {})[${JSON.stringify(slot)}] = ctx.sideband`

function writeProbePlugin(dir: string): void {
  writePackage(
    dir,
    "sb-ctx",
    {
      ...withHeadless(toolManifest("sb-ctx", "SbCtxThrow", "./tool.ts"), {
        events: [
          {
            id: "ping",
            on: "sbctx.ping",
            handler: { type: "module", path: "./event.ts", export: "default" },
          },
        ],
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./hook.ts", export: "default" },
          },
        ],
        promptFragments: [
          { id: "frag", handler: { type: "module", path: "./frag.ts", export: "default" } },
        ],
      }),
      permissions: ["hooks:editor.key"],
      syntheticText: [{ id: "p", entry: "./synthetic.js" }],
    },
    {
      "tool.ts": `export default async function handler(ctx) { ${record("tool")}; throw new Error("boom") }`,
      "event.ts": `export default function handler(ctx) { ${record("event")} }`,
      "hook.ts": `export default function handler(payload, ctx) { ${record("hook")} }`,
      "frag.ts": `export default function handler(ctx) { ${record("fragment")}; return "frag text" }`,
      "synthetic.js": `export default () => ({
  kinds: ["tool_result.handler_error"],
  text: (kind, facts, sb) => { (globalThis.${KEY} ??= {}).synthetic = sb; return "PROVIDED" },
})`,
    },
  )
}

describe("design step 5: the sideband API in each context", () => {
  let loader: PluginLoader

  beforeAll(async () => {
    rmSync(BASE, { recursive: true, force: true })
    mkdirSync(BASE, { recursive: true })
    writeProbePlugin(BASE)
    loader = await PluginLoader.load({
      userDir: BASE,
      roots: { project: [NO_PROJECT] },
      coreToolNames: CORE_TOOLS,
      diagnostics: createDiagnostics({ emit: () => {} }),
      logger: () => {},
    })
  })
  afterAll(() => {
    rmSync(BASE, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>)[KEY]
  })
  afterEach(() => clearTurnAttachmentFactories())

  it("the loader API is not ready with no codec plugin", () => {
    expect(loader.sideband().ready).toBe(false)
    expect(loader.sideband()).toBe(loader.sideband())
  })

  it("a tool handler and a synthetic text provider get the loader API", async () => {
    const r = await loader.dispatch(
      { type: "tool", name: "SbCtxThrow", input: {}, tool_use_id: "t1" },
      process.cwd(),
    )
    expect(r.kind === "tool_result" ? r.content : "").toBe("PROVIDED")
    expect(seen().tool).toBe(loader.sideband())
    expect(seen().synthetic).toBe(loader.sideband())
  })

  it("a hook handler gets the loader API", () => {
    loader.hooks().emitSync("editor.key", { key: "Up" })
    expect(seen().hook).toBe(loader.sideband())
  })

  it("an event handler gets the loader API", async () => {
    loader.bus().emit("sbctx.ping", {})
    for (let i = 0; i < 50 && seen()?.event === undefined; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect(seen().event).toBe(loader.sideband())
  })

  it("a prompt fragment gets the loader API", async () => {
    await loader.getPromptBlockAsync()
    expect(seen().fragment).toBe(loader.sideband())
  })

  it("a turn attachment factory and the AgentCore get the loader API", async () => {
    let got: unknown
    registerTurnAttachmentFactory("test/sb", (ctx) => {
      got = ctx.sideband
      return null
    })
    const auth: AuthResult = { type: "api-key", token: "t" }
    const core = await buildAgentCore({
      auth,
      model: "test-model",
      sendFn: async function* () {
        yield "ok"
        return { blocks: [], text: "ok", stopReason: "end_turn" } as StreamedResponse
      },
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      turnAttachmentContext: { sessionId: "sid" },
    })
    expect(got).toBe(loader.sideband())
    expect(core.sideband).toBe(loader.sideband())
  })

  it("a ModeManager with no resolver gets the core resolver, and its provider the loader API", async () => {
    const mm = new ModeManager([{ id: "ask", label: "ASK" }], "ask")
    const auth: AuthResult = { type: "api-key", token: "t" }
    const core = await buildAgentCore({
      auth,
      model: "test-model",
      sendFn: async function* () {
        yield "ok"
        return { blocks: [], text: "ok", stopReason: "end_turn" } as StreamedResponse
      },
      loader,
      modeManager: mm,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    const bound = mm.activeStampFacts()?.text
    expect(bound).toBe(core.syntheticText)
    expect(bound).toBe(loader.syntheticText())
    delete seen().synthetic
    expect(bound?.resolve("tool_result.handler_error", { message: "m" })).toBe("PROVIDED")
    expect(seen().synthetic).toBe(loader.sideband())
  })

  it("the tool executor gives the loader API to the round as ctx.sidebandApi", async () => {
    let got: SidebandApi | undefined
    const spy = spyOn(toolRound, "executeToolRound").mockImplementation(async (use, ctx) => {
      got = ctx.sidebandApi
      return { type: "tool_result", tool_use_id: use.id, content: "ok" }
    })
    try {
      const adapter = new ToolExecutorAdapter({
        loader,
        modeManager: null,
        blobStore: null,
        blobSkipTools: new Set(),
        feedbackTracker: new ToolFeedbackTracker(),
        model: "test-model",
        store: null,
      })
      await adapter.execute({ type: "tool_use", id: "t2", name: "SbCtxThrow", input: {} })
    } finally {
      spy.mockRestore()
    }
    expect(got).toBe(loader.sideband())
  })

  it("a second load gives a different API object", async () => {
    const second = await PluginLoader.load({
      userDir: BASE,
      roots: { project: [NO_PROJECT] },
      coreToolNames: CORE_TOOLS,
      diagnostics: createDiagnostics({ emit: () => {} }),
      logger: () => {},
    })
    expect(second.sideband()).toBe(second.sideband())
    expect(second.sideband()).not.toBe(loader.sideband())
  })

  // Today's behavior (see `coreTextOf`): an explicit `sideband` reaches the
  // providers only with explicit providers. With the loader's resolver, each
  // provider gets the loader API.
  it("an explicit deps.sideband wins for the providers only with explicit providers", async () => {
    const explicit: SidebandApi = { ...NO_SIDEBAND }
    const base = {
      auth: { type: "api-key", token: "t" } as AuthResult,
      model: "test-model",
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
      sideband: explicit,
    }
    const viaLoader = await buildAgentCore(base)
    expect(viaLoader.sideband).toBe(explicit)
    expect(viaLoader.syntheticText.resolve("tool_result.handler_error", {})).toBe("PROVIDED")
    expect(seen().synthetic).toBe(loader.sideband())

    const viaProviders = await buildAgentCore({
      ...base,
      syntheticTextProviders: loader.syntheticTextProviders(),
    })
    expect(viaProviders.sideband).toBe(explicit)
    expect(viaProviders.syntheticText.resolve("tool_result.handler_error", {})).toBe("PROVIDED")
    expect(seen().synthetic).toBe(explicit)
  })
})

describe("design step 5: no loader", () => {
  afterEach(() => clearTurnAttachmentFactories())

  it("a turn attachment factory gets NO_SIDEBAND when the caller gives none", async () => {
    let got: { ready: boolean } | undefined
    registerTurnAttachmentFactory("test/none", (ctx) => {
      got = ctx.sideband
      return null
    })
    await instantiateTurnAttachments({ sessionId: null })
    expect(got).toBe(NO_SIDEBAND)
    expect(got?.ready).toBe(false)
  })

  it("the resolver passes the API as the third argument; a 2-parameter provider still works", () => {
    const args: unknown[] = []
    const three: SyntheticTextProvider = {
      kinds: ["continue.max_tokens"],
      text: (_k, _f, sb) => {
        args.push(sb)
        return "three"
      },
    }
    const two: SyntheticTextProvider = { kinds: ["assistant.placeholder"], text: () => "two" }
    const diag = createDiagnostics({ emit: () => {} })
    const bare = createSyntheticTextResolver([three, two], diag)
    expect(bare.resolve("continue.max_tokens", {})).toBe("three")
    expect(bare.resolve("assistant.placeholder", {})).toBe("two")
    expect(args).toEqual([NO_SIDEBAND])
    const api = { ...NO_SIDEBAND }
    const given = createSyntheticTextResolver([three], diag, () => api)
    given.resolve("continue.max_tokens", {})
    expect(args[1]).toBe(api)
  })

  it('a 3-parameter provider that throws still records provider_failed and gives ""', () => {
    const events: LogEvent[] = []
    let got: unknown
    const throws: SyntheticTextProvider = {
      kinds: ["continue.max_tokens"],
      text: (_k, _f, sb) => {
        got = sb
        throw new Error("boom")
      },
    }
    const api = { ...NO_SIDEBAND }
    const resolver = createSyntheticTextResolver(
      [throws],
      createDiagnostics({ emit: (e) => events.push(e) }),
      () => api,
    )
    expect(resolver.resolve("continue.max_tokens", {})).toBe("")
    expect(got).toBe(api)
    expect(events.map((e) => [e.source, e.structuredData])).toEqual([
      ["synthetic.provider_failed", { kind: "continue.max_tokens" }],
    ])
  })

  it("a bare AgentCore has NO_SIDEBAND", async () => {
    const core = await buildAgentCore({
      auth: { type: "api-key", token: "t" },
      model: "test-model",
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    expect(core.sideband).toBe(NO_SIDEBAND)
  })
})

describe("boot order: contract check, chain boot, text step (finding m1)", () => {
  const ORDER = join(ROOT, "sideband-boot-order")
  const PROBE = "__sbBootOrderProbe"
  const imports = (): string[] => {
    const g = globalThis as Record<string, unknown>
    g[PROBE] ??= []
    return g[PROBE] as string[]
  }
  const record = (tag: string) => `;(globalThis.${PROBE} ??= []).push(${JSON.stringify(tag)})\n`

  /**
   * A chain probe whose transforms and codec modules record their import.
   * Each gives one boot diagnostic: a bad stage (`tool-result-chain.decl-invalid`)
   * and a codec that is not a function (`sideband.codec-load-failed`).
   */
  function writeRecordingProbe(dir: string, tag: string): void {
    const opts = {
      id: `order-${tag}`,
      toolName: `Order${tag}Tool`,
      transformsSource: `${record(`${tag}:transforms`)}export default [42]\n`,
      codecSource: `${record(`${tag}:codec`)}export default 42\n`,
    }
    const pkg = writeChainProbe(dir, opts)
    // A kinds mismatch gives one synthetic.kinds_mismatch diagnostic in the text step.
    writeFileSync(
      join(pkg, "manifest.json"),
      JSON.stringify({
        ...chainProbeManifest(opts),
        syntheticText: [{ id: "s", entry: "./synthetic.js", kinds: ["assistant.placeholder"] }],
      }),
    )
    writeFileSync(
      join(pkg, "synthetic.js"),
      `export default () => ({ kinds: ["continue.max_tokens"], text: () => "x" })\n`,
    )
  }

  const load = (dir: string, mode: "warn" | "fail", events: LogEvent[] = []) =>
    PluginLoader.load({
      roots: { embedded: [dir], project: [NO_PROJECT] },
      diagnostics: createDiagnostics({ emit: (e) => events.push(e) }),
      disabledPluginIds: new Set(),
      requiredContracts: ["no.such.contract"],
      contractCheckMode: mode,
      logger: () => {},
    })

  beforeAll(() => {
    rmSync(ORDER, { recursive: true, force: true })
    writeRecordingProbe(join(ORDER, "fail"), "fail")
    writeRecordingProbe(join(ORDER, "warn"), "warn")
  })
  afterAll(() => {
    rmSync(ORDER, { recursive: true, force: true })
    delete (globalThis as Record<string, unknown>)[PROBE]
  })

  it("fail mode throws ContractCheckFailedError before a transform or codec import", async () => {
    await expect(load(join(ORDER, "fail"), "fail")).rejects.toBeInstanceOf(ContractCheckFailedError)
    expect(imports().filter((i) => i.startsWith("fail:"))).toEqual([])
  })

  it("a normal boot: contract check, then chain and sideband, then synthetic diagnostics", async () => {
    const events: LogEvent[] = []
    await load(join(ORDER, "warn"), "warn", events)
    // Positive control: the probe records the imports of a boot that runs.
    expect(imports().filter((i) => i.startsWith("warn:"))).toEqual([
      "warn:transforms",
      "warn:codec",
    ])
    const sources = events.map((e) => e.source)
    const at = (source: string) => {
      const i = sources.indexOf(source)
      expect({ source, found: i >= 0 }).toEqual({ source, found: true })
      return i
    }
    const contract = at("boot.contract_missing")
    const chain = at("tool-result-chain.decl-invalid")
    const codec = at("sideband.codec-load-failed")
    const synthetic = at("synthetic.kinds_mismatch")
    expect(contract).toBeLessThan(chain)
    expect(chain).toBeLessThan(codec)
    expect(codec).toBeLessThan(synthetic)
  })
})

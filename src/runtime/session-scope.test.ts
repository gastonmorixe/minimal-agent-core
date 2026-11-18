/**
 * The plugin scope of a runtime session (`infra/session-scope.ts`): many
 * sessions in one process, one shared plugin loader. A plugin tool, an event
 * handler, the token counters and the net-dbg folder see the session of the
 * run, not the identity of the process (the web bug: SessionInfo / ModelInfo
 * reported the boot model and the process id in every web session).
 *
 * @module runtime/session-scope.test
 */

import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { ToolRegistryAdapter } from "../adapters/tool-registry-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import { currentSessionScope, runInSessionScope } from "../infra/session-scope.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import { _resetNetDbgSessionDirForTest, beginRequest } from "../logging/net-dbg.ts"
import { ToolExecutorAdapter } from "../loops/assemble.ts"
import { ROOT, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { addSessionUsage, clearSessionTokens, getSessionTokens } from "../session/session-tokens.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { createRuntime } from "./runtime.ts"
import type { Session } from "./session.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const HOME_SS = join(ROOT, "home-session-scope")
const BOOT_AGENT = Object.freeze({
  sessionId: "process-uuid",
  pid: 1,
  model: "boot-default-model",
  version: "0.0.0",
})

/** Reports what the handler context says about the session. */
const PROBE = `
export default async function handler(ctx) {
  const info = ctx.queryModelInfo?.()
  return {
    kind: "tool_result",
    content: JSON.stringify({
      agent: ctx.agent ?? null,
      envSid: ctx.env.MINIMAL_AGENT_SESSION_ID ?? null,
      envModel: ctx.env.MINIMAL_AGENT_MODEL ?? null,
      modelInfo: info ? info.modelId : null,
      target: ctx.queryTarget?.() ?? null,
      tokens: ctx.host?.sessionInfo?.tokens() ?? null,
    }),
  };
}
`

let loader: PluginLoader

/** Register `id` for `providerId`, so the model-info snapshot resolves it. */
function registerFixture(id: string, providerId: string): void {
  registerModel({
    id,
    providerId,
    surfaceId: "test",
    displayName: `Display ${id}`,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
}

beforeAll(async () => {
  for (const p of ["prov-a", "prov-b"]) {
    registerProvider({
      id: p,
      displayName: p,
      surfaces: ["test"],
      validate: () => ({ ok: true, errors: [] }),
      run: () => {
        throw new Error("not used: the sessions use sendFn")
      },
    })
  }
  registerFixture("model-a", "prov-a")
  registerFixture("model-c", "prov-a")
  registerFixture("model-b", "prov-b")
  mkdirSync(HOME_SS, { recursive: true })
  const manifest = toolManifest("probe", "ScopeProbe", "./h.ts") as ReturnType<
    typeof toolManifest
  > & { capabilities?: string[] }
  manifest.capabilities = ["session-info:read"]
  writePackage(HOME_SS, "probe", manifest, { "h.ts": PROBE })
  loader = await PluginLoader.load({
    userDir: HOME_SS,
    roots: { project: [join(ROOT, "nope-project-ss")] },
    coreToolNames: new Set(),
    agent: BOOT_AGENT,
    modelInfoProvider: () => undefined,
  })
})

afterAll(() => {
  clearModelRegistry()
  clearProviderRegistry()
  rmSync(HOME_SS, { recursive: true, force: true })
})

/** The probe results, by session: the transport reads them from the second request. */
const seen = new Map<string, Record<string, unknown>>()

/** A transport that calls the probe once, then records its result and answers. */
function probeOnce(key: () => string) {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use", id: "t1", name: "ScopeProbe", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    const last = opts.messages.at(-1)
    const block = Array.isArray(last?.content)
      ? last.content.find((b) => b.type === "tool_result")
      : undefined
    const c = block && "content" in block ? block.content : ""
    const text =
      typeof c === "string" ? c : (c as Array<{ text?: string }>).map((x) => x.text ?? "").join("")
    seen.set(key(), JSON.parse(text) as Record<string, unknown>)
    return { blocks: [{ type: "text", text: "ok" }], text: "ok", stopReason: "end_turn" }
  }
}

function openScoped(runtime: ReturnType<typeof createRuntime>, model: string, providerId: string) {
  const id = randomUUID()
  return runtime.openSession({
    id,
    auth: AUTH,
    model,
    providerId,
    sendFn: probeOnce(() => id),
    toolRegistry: new ToolRegistryAdapter(loader),
    toolExecutor: new ToolExecutorAdapter({
      loader,
      modeManager: null,
      blobStore: null,
      blobSkipTools: new Set<string>(),
      feedbackTracker: new ToolFeedbackTracker(),
      model,
      store: null,
      fileTrackingStore: null,
    }),
    pluginScope: { version: "9.9.9" },
  })
}

/** Run one turn and return what the probe reported. */
async function probe(session: Session): Promise<Record<string, unknown>> {
  for await (const _ of session.run("go")) {
    /* drain */
  }
  const r = seen.get(session.id)
  if (!r) throw new Error(`no probe result for ${session.id}`)
  return r
}

describe("runtime session plugin scope", () => {
  it("each session's plugin tool sees its own id, model and target, not the boot values", async () => {
    const runtime = createRuntime()
    const a = openScoped(runtime, "model-a", "prov-a")
    const b = openScoped(runtime, "model-b", "prov-b")
    // The two turns run at the same time: the scope follows each turn.
    const [ra, rb] = await Promise.all([probe(a), probe(b)])
    for (const [r, s, model, providerId] of [
      [ra, a, "model-a", "prov-a"],
      [rb, b, "model-b", "prov-b"],
    ] as const) {
      expect(r.agent).toEqual({ sessionId: s.id, pid: process.pid, model, version: "9.9.9" })
      expect(r.envSid).toBe(s.id)
      expect(r.envModel).toBe(model)
      expect(r.modelInfo).toBe(model)
      expect(r.target).toEqual({ providerId, model })
    }
    expect(a.id).not.toBe(b.id)
    runtime.close()
  })

  it("a target switch shows in the next tool call of that session only", async () => {
    const runtime = createRuntime()
    const a = openScoped(runtime, "model-a", "prov-a")
    const b = openScoped(runtime, "model-b", "prov-b")
    a.agentCore().switchTarget({ model: "model-c" }, { quiet: true })
    const [ra, rb] = await Promise.all([probe(a), probe(b)])
    expect(ra.modelInfo).toBe("model-c")
    expect((ra.agent as { model: string }).model).toBe("model-c")
    expect(rb.modelInfo).toBe("model-b")
    runtime.close()
  })

  it("the tool gets the token counters of its own session", async () => {
    const runtime = createRuntime()
    const a = openScoped(runtime, "model-a", "prov-a")
    const scope = a.pluginScope()
    if (!scope) throw new Error("no scope")
    scope.tokens.addUsage({ input_tokens: 7, output_tokens: 3 })
    const r = await probe(a)
    expect((r.tokens as { input: number; turns: number }).input).toBe(7)
    expect((r.tokens as { input: number; turns: number }).turns).toBe(1)
    runtime.close()
  })

  it("a session without pluginScope keeps the loader's own identity (one-session hosts)", async () => {
    const runtime = createRuntime()
    const id = randomUUID()
    const s = runtime.openSession({
      id,
      auth: AUTH,
      model: "model-a",
      sendFn: probeOnce(() => id),
      toolRegistry: new ToolRegistryAdapter(loader),
      toolExecutor: new ToolExecutorAdapter({
        loader,
        modeManager: null,
        blobStore: null,
        blobSkipTools: new Set<string>(),
        feedbackTracker: new ToolFeedbackTracker(),
        model: "model-a",
        store: null,
        fileTrackingStore: null,
      }),
    })
    expect(s.pluginScope()).toBeUndefined()
    const r = await probe(s)
    expect(r.agent).toEqual(BOOT_AGENT)
    expect(r.envSid).toBe("process-uuid")
    runtime.close()
  })
})

describe("session scope: usage and net-dbg", () => {
  it("usage in a scoped run adds to that session and to the process, not to an other session", async () => {
    clearSessionTokens()
    const runtime = createRuntime()
    const a = openScoped(runtime, "model-a", "prov-a")
    const b = openScoped(runtime, "model-b", "prov-b")
    const sa = a.pluginScope()
    const sb = b.pluginScope()
    if (!sa || !sb) throw new Error("no scope")
    await runInSessionScope(sa, async () => addSessionUsage({ input_tokens: 10, output_tokens: 1 }))
    await runInSessionScope(sb, async () => addSessionUsage({ input_tokens: 20, output_tokens: 2 }))
    expect(sa.tokens.snapshot().input).toBe(10)
    expect(sb.tokens.snapshot().input).toBe(20)
    expect(getSessionTokens().input).toBe(30)
    expect(currentSessionScope()).toBeUndefined()
    clearSessionTokens()
    runtime.close()
  })

  it("each scoped session records into its own net-dbg folder", () => {
    const home = join(ROOT, "home-netdbg-scope")
    rmSync(home, { recursive: true, force: true })
    const saved = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = home
    _resetNetDbgSessionDirForTest()
    try {
      const runtime = createRuntime()
      const a = openScoped(runtime, "model-a", "prov-a")
      const b = openScoped(runtime, "model-b", "prov-b")
      const sa = a.pluginScope()
      const sb = b.pluginScope()
      if (!sa || !sb) throw new Error("no scope")
      const req = { url: "https://x.test/v1", method: "POST", headers: {}, body: "{}" }
      runInSessionScope(sa, () => beginRequest(req))
      runInSessionScope(sb, () => beginRequest(req))
      const dirs = readdirSync(join(home, "net-dbg"))
      expect(dirs.filter((d) => d.endsWith(`-minimal-agent-${a.id}`))).toHaveLength(1)
      expect(dirs.filter((d) => d.endsWith(`-minimal-agent-${b.id}`))).toHaveLength(1)
      runtime.close()
    } finally {
      _resetNetDbgSessionDirForTest()
      if (saved === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = saved
      if (existsSync(home)) rmSync(home, { recursive: true, force: true })
    }
  })
})

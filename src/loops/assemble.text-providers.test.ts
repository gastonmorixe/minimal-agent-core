/**
 * B1 wiring: the loader's synthetic text providers reach AgentCore on every
 * boot path (`buildAgentCore`, `openAgentCoreSession`, and the runtime
 * `openSession` with an explicit value). Each test drives a real turn that
 * ends on `max_tokens`, so the core resolves `continue.max_tokens`.
 *
 * @module loops/assemble.text-providers.test
 */

import { describe, expect, it } from "bun:test"

import type { SyntheticTextProvider } from "../../plugin-api/src/types/synthetic-text.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { StreamedResponse } from "../client/types.ts"
import type { TransportFn } from "../llm/transport/types.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { createRuntime } from "../runtime/runtime.ts"
import type { AgentCore } from "../sdk/agent-core.ts"

import { type BuildAgentCoreDeps, buildAgentCore, openAgentCoreSession } from "./assemble.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

function truncThenDone(): TransportFn {
  let round = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    round++
    const text = round === 1 ? "partial" : "done"
    return {
      blocks: [{ type: "text" as const, text }],
      text,
      stopReason: round === 1 ? "max_tokens" : "end_turn",
    } as StreamedResponse
  }
}

function stub(text: string): SyntheticTextProvider {
  return { kinds: ["continue.max_tokens"], text: () => text }
}

function fakeLoader(providers: readonly SyntheticTextProvider[]): PluginLoader {
  return {
    getPromptBlockAsync: async () => null,
    getExtraTools: () => [],
    getToolAliases: () => new Map<string, string>(),
    hasTool: () => false,
    syntheticTextProviders: () => providers,
    toolTextProviders: () => [],
  } as unknown as PluginLoader
}

function baseDeps(extra: Partial<BuildAgentCoreDeps>): BuildAgentCoreDeps {
  return {
    auth: AUTH,
    model: "test-model",
    sendFn: truncThenDone(),
    loader: null,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
    ...extra,
  }
}

/** The `ma::agent` nudge texts the core added to the history. */
function nudges(core: AgentCore): string[] {
  const out: string[] = []
  for (const m of core.messages) {
    if (m.role !== "user" || !Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === "text" && b.text.startsWith("X-")) out.push(b.text)
  }
  return out
}

async function runCore(core: AgentCore): Promise<string[]> {
  const gen = core.run("go")
  while (!(await gen.next()).done) {}
  return nudges(core)
}

describe("B1: loader synthetic text providers reach AgentCore", () => {
  it("buildAgentCore defaults to loader.syntheticTextProviders()", async () => {
    const core = await buildAgentCore(baseDeps({ loader: fakeLoader([stub("X-loader")]) }))
    expect(await runCore(core)).toEqual(["X-loader"])
  })

  it("buildAgentCore: an explicit value wins over the loader", async () => {
    const core = await buildAgentCore(
      baseDeps({
        loader: fakeLoader([stub("X-loader")]),
        syntheticTextProviders: [stub("X-explicit")],
      }),
    )
    expect(await runCore(core)).toEqual(["X-explicit"])
  })

  it("openAgentCoreSession defaults to loader.syntheticTextProviders()", async () => {
    const session = await openAgentCoreSession(
      baseDeps({ loader: fakeLoader([stub("X-session")]) }),
    )
    try {
      expect(await runCore(session.agentCore())).toEqual(["X-session"])
    } finally {
      session.close()
    }
  })

  it("runtime openSession forwards an explicit value", async () => {
    const session = createRuntime().openSession({
      auth: AUTH,
      model: "test-model",
      sendFn: truncThenDone(),
      syntheticTextProviders: [stub("X-runtime")],
    })
    try {
      expect(await runCore(session.agentCore())).toEqual(["X-runtime"])
    } finally {
      session.close()
    }
  })
})

describe("MINOR-4: AgentCore reuses the loader's one resolver", () => {
  /** A loader whose resolver answers with its own text, unlike its providers. */
  function loaderWithResolver(calls: string[]): PluginLoader {
    const resolver: SyntheticTextResolver = {
      resolve: (kind, _facts, fallback) => {
        calls.push(kind)
        return kind === "continue.max_tokens" ? "X-resolver" : fallback()
      },
    }
    return {
      ...(fakeLoader([stub("X-providers")]) as unknown as Record<string, unknown>),
      syntheticText: () => resolver,
    } as unknown as PluginLoader
  }

  it("buildAgentCore uses loader.syntheticText() and builds no second resolver", async () => {
    const calls: string[] = []
    const core = await buildAgentCore(baseDeps({ loader: loaderWithResolver(calls) }))
    expect(await runCore(core)).toEqual(["X-resolver"])
    expect(calls).toContain("continue.max_tokens")
  })

  it("openAgentCoreSession uses loader.syntheticText()", async () => {
    const calls: string[] = []
    const session = await openAgentCoreSession(baseDeps({ loader: loaderWithResolver(calls) }))
    try {
      expect(await runCore(session.agentCore())).toEqual(["X-resolver"])
    } finally {
      session.close()
    }
  })

  it("explicit providers win: the core builds its own resolver from them", async () => {
    const core = await buildAgentCore(
      baseDeps({ loader: loaderWithResolver([]), syntheticTextProviders: [stub("X-explicit")] }),
    )
    expect(await runCore(core)).toEqual(["X-explicit"])
  })
})

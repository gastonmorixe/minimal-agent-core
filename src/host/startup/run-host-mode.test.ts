/**
 * Unit tests for {@link runHostMode}: the `HostRuntime` effort getters
 * after a model switch, `turn.willStart` on `HostSession.run`, and the
 * shutdown signals (first signal aborts, a second signal or the grace
 * period ends the process).
 *
 * @module host/startup/run-host-mode.test
 */

import { EventEmitter } from "node:events"

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { HostModeContext, HostModeHandler } from "../../host-public/host-mode.ts"
import { defaultCapabilities } from "../../llm/capabilities.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "../../llm/model-registry.ts"
import type { SendOptions, StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { SessionEntry } from "../../runtime/session.ts"
import { createLifecyclePort } from "../sdk-adapters/build-agent-core.ts"

import { type RunHostModeInput, runHostMode } from "./run-host-mode.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PROVIDER = "host-mode-test-prov"

function registerFixtureModel(id: string, levels: readonly string[]): void {
  const entry: ModelEntry = {
    id,
    providerId: PROVIDER,
    surfaceId: "test",
    displayName: id,
    capabilities: {
      ...defaultCapabilities(),
      effort: { levels, default: "low" } as ModelEntry["capabilities"]["effort"],
    },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
  registerModel(entry)
}

/** The chain result a fake `turn.willStart` listener gives. */
type WillStart = { payload: { text: string }; halted: boolean }

/** A loader stub: one host mode, plus a `turn.willStart` chain. */
function stubLoader(
  handler: HostModeHandler,
  willStart?: (text: string) => WillStart,
): PluginLoader {
  const stub = {
    findHostMode: (id: string) =>
      id === "test"
        ? {
            spec: {
              id: "test",
              description: "test",
              entry: { type: "module", path: "x.ts" },
            },
            pluginId: "p",
            packageDir: "/",
            entryAbsolute: "/x.ts",
            handler,
          }
        : undefined,
    hooks: () => ({
      emitChain: async (channel: string, payload: { text: string }) => {
        if (channel !== "turn.willStart" || !willStart) return { payload, halted: false }
        return willStart(payload.text)
      },
    }),
  }
  return stub as unknown as PluginLoader
}

/** A transport that records the last user text and ends the turn. */
function recordingSend(sent: string[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    const last = opts.messages.at(-1)
    const content = last?.content
    if (typeof content === "string") sent.push(content)
    else if (Array.isArray(content)) {
      for (const b of content) if (b.type === "text") sent.push(b.text)
    }
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function makeInput(
  handler: HostModeHandler,
  opts: {
    sent?: string[]
    willStart?: (text: string) => WillStart
    effort?: string
    exitProcess?: (code: number) => void
    signalGraceMs?: number
    signals?: EventEmitter
  } = {},
): RunHostModeInput {
  const stderrLines: string[] = []
  return {
    hostModeId: "test",
    hostModeArgv: [],
    promptSource: { kind: "none" },
    loader: stubLoader(handler, opts.willStart),
    sessionDeps: {
      auth: AUTH,
      model: "model-a",
      providerId: PROVIDER,
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      sendFn: recordingSend(opts.sent ?? []),
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    },
    sessionId: "sid-host-mode",
    hostLifecycle: createLifecyclePort(null),
    stderr: { write: (s: string) => stderrLines.push(s) > 0 },
    ...(opts.exitProcess ? { exitProcess: opts.exitProcess } : {}),
    ...(opts.signalGraceMs !== undefined ? { signalGraceMs: opts.signalGraceMs } : {}),
    // Never the real process: other test files listen for real signals.
    signalSource: (opts.signals ?? new EventEmitter()) as unknown as Pick<
      NodeJS.Process,
      "on" | "removeListener"
    >,
  }
}

async function drain(iter: AsyncIterable<SessionEntry>): Promise<void> {
  for await (const _ of iter) {
    // drain only
  }
}

describe("runHostMode", () => {
  const savedExitCode = process.exitCode
  afterEach(() => {
    clearModelRegistry()
    process.exitCode = savedExitCode
  })

  it("getEffort reads the live core after setModel resets the effort", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    registerFixtureModel("model-b", [])
    const seen: Array<string | undefined> = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      seen.push(ctx.runtime.getEffort())
      const session = await ctx.runtime.openSession()
      seen.push(ctx.runtime.getEffort())
      ctx.runtime.setModel("model-b")
      seen.push(ctx.runtime.getEffort())
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler, { effort: "high" }))
    expect(seen).toEqual(["high", "high", undefined])
    expect(process.exitCode).toBe(0)
  })

  it("setEffort validates against the live model and getEffort shows it", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const seen: Array<string | undefined> = []
    let error = ""
    const handler = async (ctx: HostModeContext): Promise<number> => {
      expect(() => ctx.runtime.setEffort("low")).toThrow(/no session open/)
      const session = await ctx.runtime.openSession()
      ctx.runtime.setEffort("low")
      seen.push(ctx.runtime.getEffort())
      try {
        ctx.runtime.setEffort("ultra")
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      seen.push(ctx.runtime.getEffort())
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler))
    expect(seen).toEqual(["low", "low"])
    expect(error.length).toBeGreaterThan(0)
  })

  it("HostSession.run applies a turn.willStart rewrite before the model request", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const sent: string[] = []
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const run = session.run("hello", { emitDeltas: true, signal: new AbortController().signal })
      await drain(run)
      expect((await run.result).outcome).toBe("completed")
      // A new prompt right after the entries end must not see "in progress".
      await drain(session.run("next", { emitDeltas: true, signal: new AbortController().signal }))
      await session.close()
      expect(() =>
        session.run("late", { emitDeltas: true, signal: new AbortController().signal }),
      ).toThrow(/closed/)
      return 0
    }
    const willStart = (text: string): WillStart => ({
      payload: { text: `${text} (rewritten)` },
      halted: false,
    })
    await runHostMode(makeInput(handler, { sent, willStart }))
    expect(sent.some((t) => t.includes("hello (rewritten)"))).toBe(true)
    expect(sent.some((t) => t.includes("next (rewritten)"))).toBe(true)
  })

  it("HostSession.run stops a halted turn with the turn.blocked error and no model request", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const sent: string[] = []
    let iterError: unknown
    let resultError: unknown
    let ranAgain = false
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const run = session.run("hello", { emitDeltas: true, signal: new AbortController().signal })
      try {
        await drain(run)
      } catch (e) {
        iterError = e
      }
      try {
        await run.result
      } catch (e) {
        resultError = e
      }
      // The session stays usable after a halted turn.
      const next = session.run("again", { emitDeltas: true, signal: new AbortController().signal })
      await drain(next).catch(() => {})
      ranAgain = true
      await session.close()
      return 0
    }
    const willStart = (text: string): WillStart => ({ payload: { text }, halted: true })
    await runHostMode(makeInput(handler, { sent, willStart }))
    expect(sent).toEqual([])
    expect(iterError).toBeInstanceOf(Error)
    expect((iterError as Error & { code?: string }).code).toBe("turn.blocked")
    expect((iterError as Error).message).toBe(
      "turn.willStart: prompt blocked by lifecycle policy hook.",
    )
    expect(resultError).toBe(iterError)
    expect(ranAgain).toBe(true)
  })

  it("HostSession.run throws at once when a turn is already in progress", async () => {
    registerFixtureModel("model-a", ["low", "high"])
    const handler = async (ctx: HostModeContext): Promise<number> => {
      const session = await ctx.runtime.openSession()
      const signal = new AbortController().signal
      const first = session.run("one", { emitDeltas: true, signal })
      expect(() => session.run("two", { emitDeltas: true, signal })).toThrow(/in progress/)
      await drain(first)
      await session.close()
      return 0
    }
    await runHostMode(makeInput(handler))
    expect(process.exitCode).toBe(0)
  })

  it("the first SIGTERM aborts ctx.abort, and the handler's code is the exit code", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    const handler = async (ctx: HostModeContext): Promise<number> => {
      queueMicrotask(() => signals.emit("SIGTERM"))
      await new Promise<void>((resolve) => ctx.abort.addEventListener("abort", () => resolve()))
      return 7
    }
    await runHostMode(makeInput(handler, { exitProcess: (c) => exits.push(c), signals }))
    expect(exits).toEqual([])
    expect(process.exitCode).toBe(7)
    expect(signals.listenerCount("SIGTERM")).toBe(0)
    expect(signals.listenerCount("SIGINT")).toBe(0)
  })

  it("a second signal ends the process when the handler does not react", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    let release: () => void = () => {}
    const handler = async (): Promise<number> => {
      signals.emit("SIGINT")
      signals.emit("SIGINT")
      await new Promise<void>((resolve) => {
        release = resolve
        if (exits.length > 0) resolve()
      })
      return 0
    }
    await runHostMode(makeInput(handler, { exitProcess: (c) => exits.push(c), signals }))
    release()
    expect(exits).toEqual([130])
  })

  it("the grace period ends the process when the handler ignores the first signal", async () => {
    const exits: number[] = []
    const signals = new EventEmitter()
    const handler = async (): Promise<number> => {
      signals.emit("SIGTERM")
      await new Promise<void>((resolve) => {
        const poll = setInterval(() => {
          if (exits.length > 0) {
            clearInterval(poll)
            resolve()
          }
        }, 5)
      })
      return 0
    }
    await runHostMode(
      makeInput(handler, { exitProcess: (c) => exits.push(c), signalGraceMs: 20, signals }),
    )
    expect(exits).toEqual([143])
  })
})

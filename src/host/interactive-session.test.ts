/**
 * Contract tests for the Tier-2 interactive host facade.
 *
 * These tests intentionally exercise the real `buildAgentCore` wiring rather
 * than replacing the underlying AgentCore. The session owns interactive-only
 * behavior, while the engine stays usable by headless hosts.
 *
 * Interactive-only behavior is injected through deterministic host seams, so
 * routing and reflection policy can be characterized without timers or TUI
 * singletons.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"

import {
  InteractiveSession,
  type ReflectionCheckpointContext,
  TranscriptRouter,
} from "./interactive-session.ts"
import type { BuildAgentCoreDeps } from "./sdk-adapters/build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

type RunOptions = NonNullable<Parameters<InteractiveSession["run"]>[1]>

function response(
  text: string,
  stopReason: "end_turn" | "tool_use" | "max_tokens" = "end_turn",
): StreamedResponse {
  return {
    blocks: text.length > 0 ? [{ type: "text", text }] : [],
    text,
    stopReason,
  } as StreamedResponse
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  for (;;) {
    const next = await gen.next()
    if (next.done) return text
    text += next.value
  }
}

function baseDeps(sendFn: BuildAgentCoreDeps["sendFn"]): BuildAgentCoreDeps {
  return {
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
}

async function createSession(sendFn: BuildAgentCoreDeps["sendFn"]): Promise<InteractiveSession> {
  return InteractiveSession.create(baseDeps(sendFn))
}

describe("InteractiveSession", () => {
  it("creates through real host wiring and exposes public facade behavior", async () => {
    const loader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader
    const activeMode = { id: "focus" }
    const modes = {
      active: () => activeMode,
      activeId: () => activeMode.id,
      promptPrefix: (prefix: string) => prefix,
      consumePendingAttachment: () => null,
    } as unknown as ModeManager
    const requestMessages: Message[][] = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      requestMessages.push(structuredClone(opts.messages) as Message[])
      yield "ok"
      return response("ok")
    }
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      loader,
      modeManager: modes,
    })

    expect(session.agentCore()).toBeDefined()
    expect(session.pluginLoader()).toBe(loader)
    expect(session.modes()).toBe(modes)
    expect(session.getActiveMode()).toBe(activeMode)
    expect(session.getModel()).toBe("test-model")
    session.setModel("other-model")
    expect(session.getModel()).toBe("other-model")

    session.notePreviousTurnAborted()
    await drain(session.run("after abort"))
    session.noteSessionResumed()
    await drain(session.run(""))

    expect(session.history()).toHaveLength(4)
    expect(JSON.stringify(requestMessages[0])).toContain("turn-aborted")
    expect(JSON.stringify(requestMessages[1])).toContain("session-resumed")
    expect(session.rollbackPendingTurn()).toBe(false)
  })

  it("forwards supplied interactive callbacks and signal on every transport invocation", async () => {
    let round = 0
    const transportOptions: SendOptions[] = []
    const lifecycle: string[] = []
    const queued: string[] = []
    const notices: string[] = []
    const controller = new AbortController()
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      transportOptions.push(opts)
      round++
      void opts.onThinkingStart?.()
      void opts.onThinkingDelta?.(`thought-${round}`)
      void opts.onThinkingStop?.()
      void opts.onTextStop?.()
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "max_tokens",
        } as StreamedResponse
      }
      yield "done"
      return response("done")
    }
    const session = await createSession(sendFn)
    const opts: RunOptions = {
      onThinkingStart: () => {
        lifecycle.push("thinking-start")
      },
      onThinkingChunk: (chunk) => {
        lifecycle.push(chunk)
      },
      onThinkingStop: () => {
        lifecycle.push("thinking-stop")
      },
      onTextStop: () => {
        lifecycle.push("text-stop")
      },
      onNotice: (notice) => {
        notices.push(notice.kind)
      },
      drainQueuedUserText: () => "queued prompt",
      onQueueInject: (text) => {
        queued.push(text)
      },
      signal: controller.signal,
    }

    await drain(session.run("go", opts))

    expect(lifecycle).toEqual([
      "thinking-start",
      "thought-1",
      "thinking-stop",
      "text-stop",
      "thinking-start",
      "thought-2",
      "thinking-stop",
      "text-stop",
    ])
    expect(transportOptions).toHaveLength(2)
    for (const invocation of transportOptions) {
      expect(invocation.signal).toBe(controller.signal)
      expect(invocation.onThinkingStart).toBe(opts.onThinkingStart)
      expect(invocation.onThinkingStop).toBe(opts.onThinkingStop)
      expect(invocation.onTextStop).toBe(opts.onTextStop)
      expect(invocation.onThinkingDelta).toBe(opts.onThinkingChunk)
    }
    expect(queued).toEqual(["queued prompt"])
    expect(notices).toEqual(["max_tokens_salvaged"])
  })

  it("restores transcript routing across sequential leases, throws, aborts, and early close", () => {
    const fallback: string[] = []
    const first: string[] = []
    const second: string[] = []
    const router = new TranscriptRouter((line) => fallback.push(line))

    const runWithLease = (writer: (line: string) => void, outcome: "return" | "throw"): void => {
      const release = router.acquire(writer)
      try {
        router.write(outcome)
        if (outcome === "throw") throw new Error("failed")
      } finally {
        release()
      }
    }

    runWithLease((line) => first.push(line), "return")
    router.write("after return")
    expect(() => runWithLease(() => {}, "throw")).toThrow("failed")
    router.write("after throw")

    const abort = new AbortController()
    const releaseAbort = router.acquire((line) => second.push(line))
    try {
      abort.abort()
      router.write(abort.signal.aborted ? "aborted" : "live")
    } finally {
      releaseAbort()
    }
    router.write("after abort")

    const releaseEarly = router.acquire((line) => second.push(line))
    releaseEarly()
    router.write("after early close")

    expect(first).toEqual(["return"])
    expect(second).toEqual(["aborted"])
    expect(fallback).toEqual(["after return", "after throw", "after abort", "after early close"])
  })

  it("rejects overlapping transcript leases without disturbing the active route", () => {
    const routed: string[] = []
    const router = new TranscriptRouter()
    const release = router.acquire((line) => routed.push(line))
    expect(() => router.acquire()).toThrow("already has an active run")
    router.write("still active")
    release()
    expect(routed).toEqual(["still active"])
  })

  it("releases run routing when the consumer closes the generator early", async () => {
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      yield `chunk-${invocation}`
      return response(`chunk-${invocation}`)
    }
    const fallback: string[] = []
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      writeTranscript: (line) => fallback.push(line),
    })

    const first = session.run("first", { onTranscriptLine: () => {} })
    expect(await first.next()).toEqual({ done: false, value: "chunk-1" })
    await first.return(response("closed"))

    expect(await drain(session.run("second"))).toBe("chunk-2")
    expect(invocation).toBe(2)
  })

  it("forwards reflection context and waits for host completion", async () => {
    const contexts: ReflectionCheckpointContext[] = []
    const ordering: string[] = []
    let complete: (() => void) | undefined
    const checkpointDone = new Promise<void>((resolve) => {
      complete = resolve
    })
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      ordering.push(`send-${invocation}`)
      if (invocation <= 50) {
        return {
          blocks: [{ type: "tool_use", id: `tool-${invocation}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return response("done")
    }
    const controller = new AbortController()
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      reflectionCheckpoint: {
        async wait(context) {
          contexts.push(context)
          ordering.push("checkpoint")
          await checkpointDone
          ordering.push("completed")
        },
      },
    })

    const running = drain(session.run("go", { signal: controller.signal }))
    while (contexts.length === 0) await Promise.resolve()
    expect(invocation).toBe(50)
    expect(contexts).toEqual([{ round: 50, cooldownMs: 60_000, signal: controller.signal }])
    complete?.()
    expect(await running).toBe("")
    expect(ordering.slice(-3)).toEqual(["checkpoint", "completed", "send-51"])
  })

  it("delegates reflection skip and abort semantics to the injected behavior", async () => {
    const outcomes: string[] = []
    const controller = new AbortController()
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      if (invocation <= 100) {
        return {
          blocks: [{ type: "tool_use", id: `tool-${invocation}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      return response("done")
    }
    const session = await InteractiveSession.create({
      ...baseDeps(sendFn),
      reflectionCheckpoint: {
        async wait({ round, signal }) {
          outcomes.push(round === 50 ? "skipped" : "aborted")
          if (round === 100) controller.abort()
          expect(signal).toBe(controller.signal)
        },
      },
    })

    await expect(drain(session.run("go", { signal: controller.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(outcomes).toEqual(["skipped", "aborted"])
    expect(invocation).toBe(100)
  })

  it("routes transcript output to the run callback and preserves thrown and aborted outcomes", async () => {
    let invocation = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      invocation++
      if (invocation === 1) {
        return {
          blocks: [{ type: "tool_use", id: "unknown", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      if (invocation === 3) throw new Error("transport failed")
      yield "ok"
      return response("ok")
    }
    const session = await createSession(sendFn)
    const transcript: string[] = []

    await drain(session.run("success", { onTranscriptLine: (line) => transcript.push(line) }))
    await expect(drain(session.run("failure", { onTranscriptLine: () => {} }))).rejects.toThrow(
      "transport failed",
    )

    const abort = new AbortController()
    abort.abort()
    await expect(drain(session.run("abort", { signal: abort.signal }))).rejects.toMatchObject({
      name: "AbortError",
    })
    expect(transcript.join("\n")).toContain("NoSuchTool")
  })
})

/**
 * Tests for the typed `llm.requestWillSend` channel and the redacted
 * request snapshot: zero cost with no subscriber, one build for N
 * subscribers, throw isolation, allowlist redaction, by-reference arrays and
 * cache breakpoints as indexes.
 */

import { describe, expect, it } from "bun:test"

import * as publicShim from "@minimal-agent/core/host/request-inspector"

import type { AuthResult } from "../../auth/auth.ts"
import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import type { NetworkClient } from "../../network/index.ts"
import type { Message } from "../messages.ts"

import {
  createRequestInspector,
  processRequestInspector,
  REQUEST_INSPECTOR_SOURCE,
  REQUEST_WILL_SEND,
  type RequestWillSendEvent,
  requestSnapshot,
} from "./request-inspector.ts"
import type { SendOptions, SystemBlock } from "./types.ts"

const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

function recorder(): { events: LogEvent[]; diagnostics: ReturnType<typeof createDiagnostics> } {
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e) => events.push(e) }, { sessionId: "sess-1" })
  return { events, diagnostics }
}

function event(diagnostics = recorder().diagnostics): RequestWillSendEvent {
  return {
    sessionId: diagnostics.sessionId,
    ts: 1,
    request: requestSnapshot({ auth: { type: "oauth", token: "t" }, messages }),
    diagnostics,
  }
}

describe("createRequestInspector — subscriptions", () => {
  it("reports subscribers, and unsubscribe is idempotent", () => {
    const ch = createRequestInspector()
    expect(ch.hasSubscribers()).toBe(false)
    const off = ch.subscribe(() => {})
    expect(ch.hasSubscribers()).toBe(true)
    off()
    off()
    expect(ch.hasSubscribers()).toBe(false)
  })

  it("keeps two subscriptions of the same function apart", () => {
    const ch = createRequestInspector()
    let calls = 0
    const h = (): void => {
      calls++
    }
    const offA = ch.subscribe(h)
    ch.subscribe(h)
    offA()
    offA()
    expect(ch.hasSubscribers()).toBe(true)
    ch.publish(() => event())
    expect(calls).toBe(1)
  })
})

describe("createRequestInspector — zero cost", () => {
  it("never calls build with no subscriber", () => {
    const ch = createRequestInspector()
    let built = 0
    ch.publish(() => {
      built++
      return event()
    })
    expect(built).toBe(0)
  })

  it("never calls a throwing build with no subscriber", () => {
    const ch = createRequestInspector()
    expect(() =>
      ch.publish(() => {
        throw new Error("build must not run")
      }),
    ).not.toThrow()
  })

  it("never calls build after the last unsubscribe", () => {
    const ch = createRequestInspector()
    ch.subscribe(() => {})()
    let built = 0
    ch.publish(() => {
      built++
      return event()
    })
    expect(built).toBe(0)
  })

  it("calls build exactly once for N subscribers, and they share one event", () => {
    const ch = createRequestInspector()
    const seen: RequestWillSendEvent[] = []
    for (let i = 0; i < 3; i++) ch.subscribe((e) => seen.push(e))
    let built = 0
    ch.publish(() => {
      built++
      return event()
    })
    expect(built).toBe(1)
    expect(seen).toHaveLength(3)
    expect(seen[1]).toBe(seen[0])
    expect(seen[2]).toBe(seen[0])
  })
})

describe("createRequestInspector — throw isolation", () => {
  it("a throwing handler does not stop the next one, and is reported as a Warning", () => {
    const ch = createRequestInspector()
    const { events, diagnostics } = recorder()
    let second = 0
    ch.subscribe(() => {
      throw new Error("boom")
    })
    ch.subscribe(() => {
      second++
    })
    expect(() => ch.publish(() => event(diagnostics), diagnostics)).not.toThrow()
    expect(second).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].source).toBe(REQUEST_INSPECTOR_SOURCE)
    expect(events[0].message).toContain("boom")
    expect(events[0].structuredData).toEqual({ phase: "handler" })
    expect(events[0].sessionId).toBe("sess-1")
  })

  it("reports a handler throw on the event's diagnostics when publish has none", () => {
    const ch = createRequestInspector()
    const { events, diagnostics } = recorder()
    ch.subscribe(() => {
      throw new Error("late")
    })
    ch.publish(() => event(diagnostics))
    expect(events.map((e) => e.structuredData)).toEqual([{ phase: "handler" }])
  })

  it("a throwing build calls no handler and does not throw", () => {
    const ch = createRequestInspector()
    const { events, diagnostics } = recorder()
    let calls = 0
    ch.subscribe(() => {
      calls++
    })
    expect(() =>
      ch.publish(() => {
        throw new Error("bad build")
      }, diagnostics),
    ).not.toThrow()
    expect(calls).toBe(0)
    expect(events.map((e) => e.structuredData)).toEqual([{ phase: "build" }])
  })

  it("a diagnostics handle that throws does not break publish", () => {
    const ch = createRequestInspector()
    ch.subscribe(() => {
      throw new Error("boom")
    })
    const bad = {
      sessionId: undefined,
      emit: () => {},
      debug: () => {},
      warn: () => {
        throw new Error("sink down")
      },
    }
    expect(() => ch.publish(() => event(), bad)).not.toThrow()
  })
})

describe("processRequestInspector", () => {
  it("returns the same instance on each call", () => {
    expect(processRequestInspector()).toBe(processRequestInspector())
  })

  it("is the instance the public subpath exports", () => {
    expect(publicShim.processRequestInspector()).toBe(processRequestInspector())
    expect(publicShim.REQUEST_WILL_SEND).toBe("llm.requestWillSend")
    expect(REQUEST_WILL_SEND).toBe("llm.requestWillSend")
    expect("requestSnapshot" in publicShim).toBe(false)
  })
})

describe("requestSnapshot", () => {
  const base = (): SendOptions => ({ auth: { type: "oauth", token: "t" }, messages })

  it("has only the allowlisted keys, and the optional ones only when set", () => {
    expect(Object.keys(requestSnapshot(base())).sort()).toEqual(
      ["cache", "messages", "model", "requestType", "stream", "system", "tools"].sort(),
    )
    const full = requestSnapshot({
      ...base(),
      model: "m",
      maxTokens: 10,
      thinking: { type: "adaptive" },
      outputConfig: { effort: "high" },
      speed: "fast",
      temperature: 0.5,
      onThinkingDelta: () => {},
      contextManagement: null,
    })
    expect(Object.keys(full).sort()).toEqual(
      [
        "cache",
        "maxTokens",
        "messages",
        "model",
        "outputConfig",
        "requestType",
        "speed",
        "stream",
        "system",
        "thinking",
        "tools",
      ].sort(),
    )
  })

  it("never holds auth, credentials, the network client, the signal or ports", () => {
    const auth: AuthResult = { type: "oauth", token: "SECRET-TOKEN-123" }
    const snap = requestSnapshot({
      ...base(),
      auth,
      credentialName: "cred-x",
      networkClient: { secret: "SECRET-TOKEN-123" } as unknown as NetworkClient,
      signal: new AbortController().signal,
      diagnostics: recorder().diagnostics,
    })
    const text = JSON.stringify(snap)
    expect(text).not.toContain("SECRET-TOKEN-123")
    expect(text).not.toContain("cred-x")
    for (const key of ["auth", "credentialName", "networkClient", "signal", "diagnostics"]) {
      expect(key in snap).toBe(false)
    }
  })

  it("keeps the caller's arrays by reference", () => {
    const system: SystemBlock[] = [{ type: "text", text: "s" }]
    const tools = [{ name: "Bash", input_schema: {} }]
    const opts = { ...base(), system, tools }
    const snap = requestSnapshot(opts)
    expect(snap.messages).toBe(opts.messages)
    expect(snap.system).toBe(system)
    expect(snap.tools).toBe(tools)
  })

  it("is deep-readonly at the type level (no freeze at runtime)", () => {
    const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: "x" }] }]
    const snap = requestSnapshot({ ...base(), messages: msgs })
    // Type-only checks: the function never runs, so no value changes.
    const mutate = (): void => {
      // @ts-expect-error the snapshot messages are readonly
      snap.messages.push(msgs[0])
      const content = snap.messages[0].content
      if (typeof content !== "string") {
        // @ts-expect-error a content block is readonly
        content[0].type = "text"
      }
      // @ts-expect-error the system blocks are readonly
      snap.system[0].text = "y"
      // @ts-expect-error the tools are readonly
      snap.tools[0].name = "z"
    }
    expect(typeof mutate).toBe("function")
    expect(Object.isFrozen(snap.messages)).toBe(false)
  })

  it("applies the defaults", () => {
    const snap = requestSnapshot(base())
    expect(snap.stream).toBe(true)
    expect(snap.requestType).toBe("conversation")
    expect(snap.tools).toEqual([])
    expect(snap.system).toEqual([])
    expect(snap.model).toBeUndefined()
    expect(requestSnapshot({ ...base(), thinking: false }).thinking).toBeUndefined()
  })

  it("gives cache breakpoints as indexes", () => {
    const cc = { type: "ephemeral" } as const
    const system: SystemBlock[] = [
      { type: "text", text: "a" },
      { type: "text", text: "b", cache_control: cc },
      { type: "text", text: "c", cache_control: cc },
    ]
    const msgs: Message[] = [
      { role: "user", content: "a string message never counts" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "x", cache_control: cc },
          { type: "text", text: "y" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "x" },
          { type: "text", text: "z", cache_control: cc },
        ],
      },
      { role: "assistant", content: [] },
    ]
    const snap = requestSnapshot({ ...base(), system, messages: msgs })
    expect(snap.cache).toEqual({ system: [1, 2], messages: [2] })
  })
})

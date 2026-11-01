import { describe, expect, it } from "bun:test"

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { runInDiagnosticsScope } from "../../diagnostics/run-scope.ts"

import { createDiagnosticsRelay } from "./diagnostics-relay.ts"

/** A handle that records every event it gets. */
function recorder(sessionId?: string) {
  const events: LogEvent[] = []
  const handle = createDiagnostics({ emit: (e) => events.push(e) }, sessionId ? { sessionId } : {})
  return { events, handle }
}

describe("createDiagnosticsRelay", () => {
  it("sends to the base handle until a target is attached", () => {
    const base = recorder()
    const relay = createDiagnosticsRelay(base.handle)
    relay.warn("plugin-loader", "one")
    expect(base.events.map((e) => e.message)).toEqual(["one"])
    expect(relay.sessionId).toBeUndefined()
  })

  it("sends to the attached session scope, with its session id, until detach", () => {
    const base = recorder()
    const session = recorder("s-1")
    const relay = createDiagnosticsRelay(base.handle)
    const detach = relay.attach(session.handle)
    relay.notice("plugin-loader", "two")
    expect(relay.sessionId).toBe("s-1")
    expect(session.events.map((e) => [e.message, e.sessionId])).toEqual([["two", "s-1"]])
    expect(base.events).toEqual([])
    detach()
    detach()
    relay.notice("plugin-loader", "three")
    expect(base.events.map((e) => e.message)).toEqual(["three"])
  })

  it("with one session left attached, detach of an older one keeps it", () => {
    const a = recorder("a")
    const b = recorder("b")
    const relay = createDiagnosticsRelay(recorder().handle)
    const detachA = relay.attach(a.handle)
    relay.attach(b.handle)
    detachA()
    relay.info("plugin-loader", "x")
    expect(b.events.map((e) => e.sessionId)).toEqual(["b"])
    expect(a.events).toEqual([])
  })

  it("routes by the run scope, and to the base with two sessions and no scope", async () => {
    const base = recorder()
    const a = recorder("a")
    const b = recorder("b")
    const relay = createDiagnosticsRelay(base.handle)
    relay.attach(a.handle)
    relay.attach(b.handle)
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1))
    await Promise.all([
      runInDiagnosticsScope(a.handle, async () => {
        await tick()
        relay.warn("plugin-loader", "from a")
      }),
      runInDiagnosticsScope(b.handle, async () => {
        relay.warn("plugin-loader", "from b")
        await tick()
      }),
    ])
    relay.warn("plugin-loader", "no scope")
    expect(a.events.map((e) => e.message)).toEqual(["from a"])
    expect(b.events.map((e) => e.message)).toEqual(["from b"])
    expect(base.events.map((e) => e.message)).toEqual(["no scope"])
  })
})

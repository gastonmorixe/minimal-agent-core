import { describe, expect, it } from "bun:test"

import { type StatusActivity, StatusBus } from "../status.ts"

import { NetworkActivityObserver, NetworkActivityTracker } from "./activity-observer.ts"
import { type NetworkRequest, NetworkResponse } from "./types.ts"

function makeRequest(overrides: Partial<NetworkRequest> = {}): NetworkRequest {
  return {
    id: "req-1",
    label: "messages.send",
    method: "POST",
    url: "https://api.anthropic.com/v1/messages?beta=true",
    headers: { authorization: "Bearer redacted" },
    body: '{"hello":"world"}',
    ...overrides,
  }
}

function makeResponse(overrides: { protocol?: string; status?: number } = {}): NetworkResponse {
  return new NetworkResponse({
    status: overrides.status ?? 200,
    headers: {},
    transport: {
      id: "h2-test",
      protocol: overrides.protocol as never,
    },
  })
}

describe("NetworkActivityObserver", () => {
  it("attach returns a tracker and registers it in the observer", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()

    const tracker = obs.attach("req-1", handle)
    expect(tracker).toBeInstanceOf(NetworkActivityTracker)
    expect(obs.size()).toBe(1)

    obs.detach("req-1")
    expect(obs.size()).toBe(0)

    handle.clear()
  })

  it("onRequest records sentBytes from a string body and extracts host", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    const body = '{"a":1,"b":"hello"}'
    obs.onRequest(makeRequest({ id: "req-1", body }))

    const snap = bus.currentStatus()
    const activity = snap?.activity
    expect(activity?.direction).toBe("up")
    expect(activity?.sentBytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(activity?.target?.host).toBe("api.anthropic.com")

    handle.clear()
  })

  it("onRequest records sentBytes from a Uint8Array body", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    const body = new Uint8Array(2048)
    obs.onRequest(makeRequest({ id: "req-1", body }))

    expect(bus.currentStatus()?.activity?.sentBytes).toBe(2048)
    handle.clear()
  })

  it("onRequest handles a missing body as 0 bytes", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    obs.onRequest(makeRequest({ id: "req-1", body: undefined }))
    expect(bus.currentStatus()?.activity?.sentBytes).toBe(0)
    handle.clear()
  })

  it("onResponse fills in target.protocol", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending", {
      activity: { target: { host: "api.anthropic.com" } },
    })
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    obs.onResponse(makeRequest({ id: "req-1" }), makeResponse({ protocol: "h2" }))

    const target = bus.currentStatus()?.activity?.target
    expect(target?.host).toBe("api.anthropic.com")
    expect(target?.protocol).toBe("h2")
    handle.clear()
  })

  it("onChunk accumulates recvBytes and flips direction to down", () => {
    const bus = new StatusBus()
    const handle = bus.create("Streaming")
    const obs = new NetworkActivityObserver()
    let now = 1_000
    obs.attach("req-1", handle, { now: () => now, throttleMs: 100 })

    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(512))
    now += 200 // beyond throttle
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(1024))
    now += 200
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(2048))

    const activity = bus.currentStatus()?.activity
    expect(activity?.direction).toBe("down")
    expect(activity?.recvBytes).toBe(512 + 1024 + 2048)
    handle.clear()
  })

  it("onChunk throttles emits within throttleMs but accumulates internally", () => {
    const bus = new StatusBus()
    const handle = bus.create("Streaming")
    const obs = new NetworkActivityObserver()
    let now = 1_000
    const tracker = obs.attach("req-1", handle, {
      now: () => now,
      throttleMs: 100,
    })

    // Three rapid chunks within the same throttle window. The first emits
    // immediately (lastEmit = 0). Two further chunks at now+10 and now+50
    // are accumulated internally but not emitted.
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(100))
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(100)

    now += 10
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(50))
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(100) // not emitted yet
    expect(tracker.receivedBytes()).toBe(150) // but accumulated

    now += 40
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(25))
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(100)
    expect(tracker.receivedBytes()).toBe(175)

    // Cross the throttle boundary — next chunk should emit.
    now += 100
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(10))
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(185)

    handle.clear()
  })

  it("onEnd flushes the final recvBytes value with direction=idle", () => {
    const bus = new StatusBus()
    const handle = bus.create("Streaming")
    const obs = new NetworkActivityObserver()
    let now = 1_000
    obs.attach("req-1", handle, { now: () => now, throttleMs: 100 })

    // Accumulate three quick chunks; only the first emits.
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(500))
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(500))
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(500))

    expect(bus.currentStatus()?.activity?.recvBytes).toBe(500) // mid-flight

    obs.onEnd(makeRequest({ id: "req-1" }))

    const final = bus.currentStatus()?.activity
    expect(final?.direction).toBe("idle")
    expect(final?.recvBytes).toBe(1500) // all chunks counted

    handle.clear()
  })

  it("onError flushes recvBytes and switches direction to idle", () => {
    const bus = new StatusBus()
    const handle = bus.create("Streaming")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle, { throttleMs: 0 })

    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(750))
    obs.onError(makeRequest({ id: "req-1" }), new Error("network failed"))

    const final = bus.currentStatus()?.activity
    expect(final?.direction).toBe("idle")
    expect(final?.recvBytes).toBe(750)

    handle.clear()
  })

  it("attach sets the hint when provided", () => {
    const bus = new StatusBus()
    const handle = bus.create("Calling Bash")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle, { hint: "cd /tmp && ls" })

    obs.onRequest(makeRequest({ id: "req-1", body: "x" }))
    expect(bus.currentStatus()?.activity?.hint).toBe("cd /tmp && ls")
    handle.clear()
  })

  it("dispatches to the correct tracker when two requests overlap", () => {
    const bus = new StatusBus()
    const handleA = bus.create("A")
    const handleB = bus.create("B")
    const obs = new NetworkActivityObserver()
    obs.attach("req-A", handleA, { throttleMs: 0 })
    obs.attach("req-B", handleB, { throttleMs: 0 })

    obs.onRequest(makeRequest({ id: "req-A", body: "aaa" }))
    obs.onRequest(makeRequest({ id: "req-B", body: "bbbbbb" }))
    obs.onChunk(makeRequest({ id: "req-A" }), new Uint8Array(11))
    obs.onChunk(makeRequest({ id: "req-B" }), new Uint8Array(22))

    // currentStatus() returns the TOP-of-stack entry (B was created
    // last, before A was cleared). Drill back by clearing B first.
    expect(bus.currentStatus()?.label).toBe("B")
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(22)
    expect(bus.currentStatus()?.activity?.sentBytes).toBe(6)

    handleB.clear()

    expect(bus.currentStatus()?.label).toBe("A")
    expect(bus.currentStatus()?.activity?.recvBytes).toBe(11)
    expect(bus.currentStatus()?.activity?.sentBytes).toBe(3)

    handleA.clear()
  })

  it("detach prevents further updates from reaching the handle", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle, { throttleMs: 0 })

    obs.onRequest(makeRequest({ id: "req-1", body: "hello" }))
    expect(bus.currentStatus()?.activity?.sentBytes).toBe(5)

    obs.detach("req-1")

    // After detach, further callbacks are silent no-ops.
    obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(99))
    expect(bus.currentStatus()?.activity?.sentBytes).toBe(5)
    expect(bus.currentStatus()?.activity?.recvBytes).toBeUndefined()

    handle.clear()
  })

  it("invalid URL in onRequest doesn't crash — host stays undefined", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending")
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    obs.onRequest(makeRequest({ id: "req-1", url: "not-a-url", body: "x" }))
    const activity = bus.currentStatus()?.activity
    expect(activity?.sentBytes).toBe(1)
    expect(activity?.target?.host).toBeUndefined()

    handle.clear()
  })

  it("onResponse without a protocol does not overwrite an existing target", () => {
    const bus = new StatusBus()
    const handle = bus.create("Sending", {
      activity: { target: { host: "api.anthropic.com", model: "opus-4-7" } },
    })
    const obs = new NetworkActivityObserver()
    obs.attach("req-1", handle)

    obs.onResponse(makeRequest({ id: "req-1" }), makeResponse({ protocol: undefined }))

    const target = bus.currentStatus()?.activity?.target
    expect(target?.host).toBe("api.anthropic.com")
    expect(target?.model).toBe("opus-4-7")
    expect(target?.protocol).toBeUndefined()

    handle.clear()
  })

  it("type smoke: StatusActivity payloads round-trip through the observer", () => {
    const a: StatusActivity = { phase: "stream", recvBytes: 100 }
    expect(a.phase).toBe("stream")
  })

  describe("lastChunkAt — stalled-detector heartbeat", () => {
    // Layer 3 (May 2026): the tracker bumps `lastChunkAt` on EVERY chunk,
    // even when the status update is throttle-coalesced. The renderer's
    // stalled detector (in `formatActivityInfix`) reads this to decide
    // when to flip to the amber `⋯ stalled · last byte Ns ago` form.
    // Decoupling per-chunk timestamp from throttled emit is load-bearing:
    // a steady stream of small SSE pings within the throttle window
    // would otherwise look stalled because the last EMIT was >2s ago,
    // even though the wire is healthy.

    it("emits lastChunkAt on every throttle-window emit", () => {
      const bus = new StatusBus()
      const handle = bus.create("Streaming")
      const obs = new NetworkActivityObserver()
      let now = 5_000
      obs.attach("req-1", handle, { now: () => now, throttleMs: 100 })

      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(100))
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBe(5_000)

      now += 200
      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(50))
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBe(5_200)

      handle.clear()
    })

    it("bumps lastChunkAt internally even on throttle-coalesced chunks", () => {
      // Crucially: the tracker's internal lastChunkAt MUST advance on
      // every chunk, not just on emitted ones. Otherwise the next
      // post-throttle emit (which carries `lastChunkAt` to the renderer)
      // would lag the actual wire timestamp by up to throttleMs, and a
      // burst of pings followed by a real stall would look stalled
      // throttleMs too early.
      const bus = new StatusBus()
      const handle = bus.create("Streaming")
      const obs = new NetworkActivityObserver()
      let now = 1_000
      const tracker = obs.attach("req-1", handle, { now: () => now, throttleMs: 100 })

      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(100)) // emitted
      expect(tracker.lastChunkTimestamp()).toBe(1_000)

      now += 10 // within throttle window
      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(10)) // NOT emitted
      expect(tracker.lastChunkTimestamp()).toBe(1_010) // but internal stamp bumped

      now += 200 // cross throttle boundary
      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(10)) // emitted
      // The emitted lastChunkAt must be the wire timestamp of THIS chunk,
      // not the previous emitted-chunk stamp.
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBe(1_210)

      handle.clear()
    })

    it("onEnd flushes lastChunkAt of the most recent chunk (not now())", () => {
      const bus = new StatusBus()
      const handle = bus.create("Streaming")
      const obs = new NetworkActivityObserver()
      let now = 2_000
      obs.attach("req-1", handle, { now: () => now, throttleMs: 100 })

      obs.onChunk(makeRequest({ id: "req-1" }), new Uint8Array(100))
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBe(2_000)

      now = 3_500 // 1.5s gap before onEnd
      obs.onEnd(makeRequest({ id: "req-1" }))
      // The onEnd flush should NOT mark the end-of-stream moment as a
      // "chunk" — the stream is closed, not delivering data. Preserve
      // the last actual chunk's timestamp so the renderer can still
      // detect "no bytes arrived for the trailing 1.5s before close".
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBe(2_000)
      expect(bus.currentStatus()?.activity?.direction).toBe("idle")
    })

    it("onEnd without any prior chunk does not stamp a 0 lastChunkAt", () => {
      // Edge case: an empty-body response (e.g. 204 No Content). The
      // tracker never saw a chunk, so lastChunkAt should be undefined,
      // NOT 0. A literal 0 would render as "last byte 5000s ago" in the
      // renderer because it's the unix epoch.
      const bus = new StatusBus()
      const handle = bus.create("Streaming")
      const obs = new NetworkActivityObserver()
      obs.attach("req-1", handle, { now: () => 1_000 })

      obs.onEnd(makeRequest({ id: "req-1" }))
      expect(bus.currentStatus()?.activity?.lastChunkAt).toBeUndefined()
    })
  })
})

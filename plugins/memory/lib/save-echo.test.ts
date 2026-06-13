/**
 * Tests for the save-echo plumbing.
 *
 * Coverage:
 *   - Type guard `isMemorySavedPayload` accepts well-formed and rejects
 *     malformed payloads.
 *   - `SaveEchoCollector.attach` wires up the bus subscription and
 *     buffers events; `consumeAll` drains and returns ContentBlocks.
 *   - `consumeAll` is idempotent — second call returns [] until new
 *     events arrive.
 *   - `detach` removes the listener (subsequent emits don't queue).
 *   - `enqueue` works without the bus (tests + tool path).
 *   - `renderEcho` preview truncation, evicted attribute, attr escaping.
 */

import { describe, expect, it } from "bun:test"

import {
  type EventBusSlice,
  type EventContextSlice,
  isMemorySavedPayload,
  MEMORY_SAVED,
  type MemorySavedPayload,
  renderEcho,
  SaveEchoCollector,
  type Unsubscribe,
} from "./save-echo.ts"

/**
 * Minimal in-test event bus satisfying the plugin's structural slices
 * ({@link EventBusSlice} + emit). Dispatches on the microtask tick, like
 * the host's real `EventBus`, so the tests' `await Promise.resolve()`
 * boundary observes delivered events. Re-declared locally because the
 * plugin imports nothing from the host repo (decoupling contract).
 */
class FakeBus implements EventBusSlice {
  private readonly listeners = new Map<string, Set<(ctx: EventContextSlice) => void>>()
  private disposed = false

  on(event: string, listener: (ctx: EventContextSlice) => void): Unsubscribe {
    if (this.disposed) return () => {}
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  emit(event: string, payload?: unknown): void {
    if (this.disposed) return
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      queueMicrotask(() => fn({ payload }))
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

describe("isMemorySavedPayload", () => {
  it("accepts a well-formed payload", () => {
    expect(isMemorySavedPayload({ scope: "project", id: "abc", body: "hi" })).toBe(true)
  })

  it("accepts evicted as number", () => {
    expect(isMemorySavedPayload({ scope: "short-term", id: "1", body: "x", evicted: 1 })).toBe(true)
  })

  it("accepts all three scopes", () => {
    expect(isMemorySavedPayload({ scope: "global", id: "a", body: "" })).toBe(true)
    expect(isMemorySavedPayload({ scope: "project", id: "a", body: "" })).toBe(true)
    expect(isMemorySavedPayload({ scope: "short-term", id: "a", body: "" })).toBe(true)
  })

  it("rejects null/undefined/primitives", () => {
    expect(isMemorySavedPayload(null)).toBe(false)
    expect(isMemorySavedPayload(undefined)).toBe(false)
    expect(isMemorySavedPayload("hi")).toBe(false)
    expect(isMemorySavedPayload(42)).toBe(false)
  })

  it("rejects unknown scope values", () => {
    expect(isMemorySavedPayload({ scope: "user", id: "a", body: "" })).toBe(false)
    expect(isMemorySavedPayload({ scope: "", id: "a", body: "" })).toBe(false)
  })

  it("rejects empty/missing id", () => {
    expect(isMemorySavedPayload({ scope: "project", id: "", body: "" })).toBe(false)
    expect(isMemorySavedPayload({ scope: "project", body: "" })).toBe(false)
  })

  it("rejects non-string body", () => {
    expect(isMemorySavedPayload({ scope: "project", id: "x", body: 42 })).toBe(false)
  })

  it("rejects non-number evicted", () => {
    expect(isMemorySavedPayload({ scope: "project", id: "x", body: "y", evicted: "1" })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SaveEchoCollector — bus path
// ---------------------------------------------------------------------------

describe("SaveEchoCollector + EventBus", () => {
  it("buffers emitted events and drains them on consumeAll", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)

    bus.emit(MEMORY_SAVED, { scope: "project", id: "p1", body: "hello" })
    bus.emit(MEMORY_SAVED, { scope: "short-term", id: "1", body: "scratch" })

    // Bus dispatches via queueMicrotask — wait one tick.
    await Promise.resolve()

    expect(collector.pendingCount()).toBe(2)
    const blocks = collector.consumeAll()
    expect(blocks.length).toBe(2)
    expect(blocks[0]?.type).toBe("text")
    if (blocks[0]?.type === "text") {
      expect(blocks[0].text).toContain('scope="project"')
      expect(blocks[0].text).toContain('id="p1"')
      expect(blocks[0].text).toContain("hello")
    }
    if (blocks[1]?.type === "text") {
      expect(blocks[1].text).toContain('scope="short-term"')
      expect(blocks[1].text).toContain('id="1"')
    }

    bus.dispose()
  })

  it("consumeAll is idempotent — second call returns []", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)
    bus.emit(MEMORY_SAVED, { scope: "project", id: "x", body: "y" })
    await Promise.resolve()

    expect(collector.consumeAll().length).toBe(1)
    expect(collector.consumeAll().length).toBe(0)
    expect(collector.consumeAll().length).toBe(0)

    bus.dispose()
  })

  it("queues new events after a drain", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)

    bus.emit(MEMORY_SAVED, { scope: "project", id: "a", body: "a" })
    await Promise.resolve()
    expect(collector.consumeAll().length).toBe(1)

    bus.emit(MEMORY_SAVED, { scope: "project", id: "b", body: "b" })
    await Promise.resolve()
    expect(collector.consumeAll().length).toBe(1)

    bus.dispose()
  })

  it("ignores malformed payloads silently", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)

    bus.emit(MEMORY_SAVED, { scope: "weird", id: "x", body: "" })
    bus.emit(MEMORY_SAVED, "not an object")
    bus.emit(MEMORY_SAVED, null)
    await Promise.resolve()

    expect(collector.consumeAll().length).toBe(0)
    bus.dispose()
  })

  it("detach removes the listener — subsequent emits don't queue", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)
    collector.detach()

    bus.emit(MEMORY_SAVED, { scope: "project", id: "x", body: "y" })
    await Promise.resolve()

    expect(collector.consumeAll().length).toBe(0)
    bus.dispose()
  })

  it("detach also drops any already-queued events", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)
    bus.emit(MEMORY_SAVED, { scope: "project", id: "x", body: "y" })
    await Promise.resolve()

    expect(collector.pendingCount()).toBe(1)
    collector.detach()
    expect(collector.pendingCount()).toBe(0)
    bus.dispose()
  })

  it("detach is idempotent", () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)
    collector.detach()
    expect(() => collector.detach()).not.toThrow()
    bus.dispose()
  })
})

// ---------------------------------------------------------------------------
// SaveEchoCollector — direct enqueue (test/tool path)
// ---------------------------------------------------------------------------

describe("SaveEchoCollector.enqueue", () => {
  it("queues without going through the bus", () => {
    const c = new SaveEchoCollector()
    c.enqueue({ scope: "global", id: "g1", body: "global thing" })
    expect(c.pendingCount()).toBe(1)
    const blocks = c.consumeAll()
    expect(blocks.length).toBe(1)
    if (blocks[0]?.type === "text") {
      expect(blocks[0].text).toContain('scope="global"')
      expect(blocks[0].text).toContain('id="g1"')
    }
  })
})

// ---------------------------------------------------------------------------
// renderEcho — preview, evicted, attr escaping
// ---------------------------------------------------------------------------

describe("renderEcho", () => {
  it("emits scope + id + body for short bodies", () => {
    const out = renderEcho({ scope: "project", id: "abc-1234", body: "hi" })
    expect(out).toBe(
      '<ma::agent::memory-saved scope="project" id="abc-1234">hi</ma::agent::memory-saved>',
    )
  })

  it("truncates bodies longer than 60 chars with …", () => {
    const long = "a".repeat(120)
    const out = renderEcho({ scope: "project", id: "x", body: long })
    expect(out).toContain("a".repeat(59))
    expect(out).toContain("…")
    // The opening tag + 59 a's + …, no extra a's:
    const inner = out.replace(/^.*?>/, "").replace(/<\/.*$/, "")
    expect(inner.length).toBe(60)
  })

  it("collapses internal whitespace in the preview", () => {
    const out = renderEcho({ scope: "project", id: "x", body: "a\nb\n\nc  d" })
    expect(out).toContain("a b c d")
  })

  it("emits evicted attribute when > 0", () => {
    const out = renderEcho({ scope: "short-term", id: "21", body: "x", evicted: 1 })
    expect(out).toContain('evicted="1"')
  })

  it("omits evicted attribute when 0 or absent", () => {
    expect(renderEcho({ scope: "short-term", id: "1", body: "x", evicted: 0 })).not.toContain(
      "evicted",
    )
    expect(renderEcho({ scope: "short-term", id: "1", body: "x" })).not.toContain("evicted")
  })

  it("escapes < in body to prevent tag confusion", () => {
    const out = renderEcho({
      scope: "project",
      id: "x",
      body: "see <bad>tag</bad>",
    })
    expect(out).not.toContain("<bad>")
    expect(out).toContain("&lt;bad&gt;")
  })

  it("escapes \" and & in id (defensive — id format doesn't normally have them)", () => {
    const out = renderEcho({
      scope: "project",
      id: 'evil"&id',
      body: "x",
    })
    expect(out).toContain("&quot;")
    expect(out).toContain("&amp;")
  })
})

// ---------------------------------------------------------------------------
// End-to-end shape sanity (matches the spec the agent expects)
// ---------------------------------------------------------------------------

describe("end-to-end shape", () => {
  it("emitting then consuming produces the expected ContentBlock shape", async () => {
    const bus = new FakeBus()
    const collector = SaveEchoCollector.attach(bus)

    const payload: MemorySavedPayload = {
      scope: "project",
      id: "lwq8tg-a8f3",
      body: "Project memory body example",
    }
    bus.emit(MEMORY_SAVED, payload)
    await Promise.resolve()

    const blocks = collector.consumeAll()
    expect(blocks).toEqual([
      {
        type: "text",
        text: '<ma::agent::memory-saved scope="project" id="lwq8tg-a8f3">Project memory body example</ma::agent::memory-saved>',
      },
    ])

    bus.dispose()
  })
})

/**
 * Headless default host ports (spec v2 section 2.6, S47).
 *
 * @module runtime/host-ports-defaults.test
 */

import { describe, expect, it } from "bun:test"

import type { AskUserRequest } from "../sdk/host-ports.ts"

import {
  NOOP_COMPACT_SOURCE,
  NOOP_INPUT_QUEUE,
  NOOP_REFLECTION_GATE,
  PendingAskRegistry,
} from "./host-ports-defaults.ts"

const REQUEST: AskUserRequest = {
  askId: "ask:0",
  code: "test",
  title: "Pick one",
  detail: "",
  options: [{ id: "a", label: "A" }],
}

describe("PendingAskRegistry", () => {
  it("resolves ask() with the answer() call for the same askId", async () => {
    const registry = new PendingAskRegistry({ deadlineMs: 60_000 })
    const pending = registry.ask(REQUEST)
    expect(registry.answer("ask:0", "a")).toBe(true)
    expect(await pending).toBe("a")
  })

  it("returns false for an unknown or already-answered askId", () => {
    const registry = new PendingAskRegistry({ deadlineMs: 60_000 })
    expect(registry.answer("nope", "a")).toBe(false)
    const pending = registry.ask(REQUEST)
    expect(registry.answer("ask:0", "a")).toBe(true)
    expect(registry.answer("ask:0", "a")).toBe(false)
    void pending
  })

  it("declines (resolves null) when the signal aborts", async () => {
    const registry = new PendingAskRegistry({ deadlineMs: 60_000 })
    const controller = new AbortController()
    const pending = registry.ask(REQUEST, controller.signal)
    controller.abort()
    expect(await pending).toBeNull()
    // Already settled by the abort; a later answer() is a no-op.
    expect(registry.answer("ask:0", "a")).toBe(false)
  })

  it("declines every still-pending ask on declineAll()", async () => {
    const registry = new PendingAskRegistry({ deadlineMs: 60_000 })
    const a = registry.ask({ ...REQUEST, askId: "ask:0" })
    const b = registry.ask({ ...REQUEST, askId: "ask:1" })
    registry.declineAll()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
  })
})

describe("PendingAskRegistry deadline (decision 11/34)", () => {
  it("resolves with the default option when the deadline ends", async () => {
    const seen: Array<string | null> = []
    const registry = new PendingAskRegistry({
      deadlineMs: 10,
      onDeadline: (_request, answer) => seen.push(answer),
    })
    const answer = await registry.ask({
      ...REQUEST,
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B", isDefault: true },
      ],
    })
    expect(answer).toBe("b")
    expect(seen).toEqual(["b"])
    expect(registry.answer("ask:0", "a")).toBe(false)
  })

  it("declines (resolves null) when the deadline ends and no option is the default", async () => {
    const registry = new PendingAskRegistry({ deadlineMs: 10 })
    expect(await registry.ask(REQUEST)).toBeNull()
  })

  it("an answer before the deadline wins, and the deadline does not fire after it", async () => {
    let fired = 0
    const registry = new PendingAskRegistry({ deadlineMs: 10, onDeadline: () => fired++ })
    const pending = registry.ask(REQUEST)
    expect(registry.answer("ask:0", "a")).toBe(true)
    expect(await pending).toBe("a")
    await Bun.sleep(30)
    expect(fired).toBe(0)
  })

  it("rejects a missing, zero, negative, or infinite deadline", () => {
    for (const deadlineMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PendingAskRegistry({ deadlineMs })).toThrow(/deadlineMs/)
    }
  })
})

describe("no-op ports", () => {
  it("never queue text, never gate a checkpoint, never hold a compact request", async () => {
    expect(NOOP_INPUT_QUEUE.take()).toBeNull()
    expect(NOOP_COMPACT_SOURCE.take()).toBeNull()
    await NOOP_REFLECTION_GATE.beforeCheckpoint(1)
  })
})

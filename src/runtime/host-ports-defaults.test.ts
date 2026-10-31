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
    const registry = new PendingAskRegistry()
    const pending = registry.ask(REQUEST)
    expect(registry.answer("ask:0", "a")).toBe(true)
    expect(await pending).toBe("a")
  })

  it("returns false for an unknown or already-answered askId", () => {
    const registry = new PendingAskRegistry()
    expect(registry.answer("nope", "a")).toBe(false)
    const pending = registry.ask(REQUEST)
    expect(registry.answer("ask:0", "a")).toBe(true)
    expect(registry.answer("ask:0", "a")).toBe(false)
    void pending
  })

  it("declines (resolves null) when the signal aborts", async () => {
    const registry = new PendingAskRegistry()
    const controller = new AbortController()
    const pending = registry.ask(REQUEST, controller.signal)
    controller.abort()
    expect(await pending).toBeNull()
    // Already settled by the abort; a later answer() is a no-op.
    expect(registry.answer("ask:0", "a")).toBe(false)
  })

  it("declines every still-pending ask on declineAll()", async () => {
    const registry = new PendingAskRegistry()
    const a = registry.ask({ ...REQUEST, askId: "ask:0" })
    const b = registry.ask({ ...REQUEST, askId: "ask:1" })
    registry.declineAll()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
  })
})

describe("no-op ports", () => {
  it("never queue text, never gate a checkpoint, never hold a compact request", async () => {
    expect(NOOP_INPUT_QUEUE.take()).toBeNull()
    expect(NOOP_COMPACT_SOURCE.take()).toBeNull()
    await NOOP_REFLECTION_GATE.beforeCheckpoint(1)
  })
})

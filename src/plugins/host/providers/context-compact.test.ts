import { describe, expect, it } from "bun:test"

import { buildPluginHost } from "../factory.ts"

import {
  clearPendingCompact,
  createContextCompactApi,
  takePendingCompact,
} from "./context-compact.ts"

describe("context:compact queue", () => {
  it("queues opts and drains via take", () => {
    clearPendingCompact()
    const api = createContextCompactApi()
    const res = api.requestCompact({ reason: "manual", focus: "trim logs" })
    expect(res).toEqual({ queued: true })
    expect(takePendingCompact()).toEqual({ reason: "manual", focus: "trim logs" })
    expect(takePendingCompact()).toBeNull()
  })

  it("clear drops the slot", () => {
    createContextCompactApi().requestCompact({ reason: "auto" })
    clearPendingCompact()
    expect(takePendingCompact()).toBeNull()
  })

  it("factory grants compact only when declared", () => {
    clearPendingCompact()
    const granted = buildPluginHost({ capabilities: ["context:compact"] })
    expect(granted.compact).toBeDefined()
    const denied = buildPluginHost({ capabilities: [] })
    expect(denied.compact).toBeUndefined()
    clearPendingCompact()
  })
})

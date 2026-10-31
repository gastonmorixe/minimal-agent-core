/**
 * The status port (spec S23): phase codes and numbers only, no label and no
 * spinner theme. The engine never reads a global status bus; a host that
 * wants live status (byte counters, a tool's name) supplies a `StatusPort`.
 *
 * @module bus/status-port.test
 */

import { describe, expect, it } from "bun:test"

import { NOOP_LIVE_STATUS, NOOP_STATUS_PORT, type StatusFields } from "./status-port.ts"

describe("StatusFields", () => {
  it("has a phase and no label, at the type level", () => {
    const fields: StatusFields = { phase: "running_tool", toolName: "Grep" }
    expect(fields.phase).toBe("running_tool")
    expect(Object.hasOwn(fields, "label")).toBe(false)
    expect(Object.hasOwn(fields, "spinnerTheme")).toBe(false)
  })
})

describe("NOOP_STATUS_PORT", () => {
  it("opens a live status that goes nowhere and never throws", () => {
    const live = NOOP_STATUS_PORT.open({ phase: "sending" })
    expect(() => live.update({ phase: "receiving" })).not.toThrow()
    expect(() => live.updateActivity({ direction: "down", recvBytes: 10 })).not.toThrow()
    expect(() => live.clear()).not.toThrow()
  })

  it("NOOP_LIVE_STATUS is itself a valid, inert LiveStatus", () => {
    expect(() => NOOP_LIVE_STATUS.update({ phase: "retrying" })).not.toThrow()
    expect(() => NOOP_LIVE_STATUS.clear()).not.toThrow()
  })
})

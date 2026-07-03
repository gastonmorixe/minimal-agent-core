import { afterEach, describe, expect, it } from "bun:test"

import { emptyUsageReports } from "@minimal-agent/plugin-api/utils/usage-report"

import { DEFAULT_PERIOD_INDEX } from "./overlay.ts"
import { _resetForTests, closeOverlay, getOverlayState, openOverlay } from "./state.ts"

afterEach(() => _resetForTests())

describe("usage overlay state singleton", () => {
  it("starts closed", () => {
    expect(getOverlayState().open).toBe(false)
    expect(getOverlayState().reports).toBeNull()
  })

  it("openOverlay stores reports + resets selection by default", () => {
    const reports = emptyUsageReports(Date.now())
    openOverlay(reports)
    const s = getOverlayState()
    expect(s.open).toBe(true)
    expect(s.index).toBe(DEFAULT_PERIOD_INDEX)
    expect(s.reports).toBe(reports)
  })

  it("openOverlay honors an explicit start index", () => {
    openOverlay(emptyUsageReports(Date.now()), 2)
    expect(getOverlayState().index).toBe(2)
  })

  it("closeOverlay clears reports + open flag", () => {
    openOverlay(emptyUsageReports(Date.now()))
    closeOverlay()
    const s = getOverlayState()
    expect(s.open).toBe(false)
    expect(s.reports).toBeNull()
    expect(s.index).toBe(DEFAULT_PERIOD_INDEX)
  })
})

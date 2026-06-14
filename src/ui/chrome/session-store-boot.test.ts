import { describe, expect, it } from "bun:test"

import { stripAnsi } from "../../term-width.ts"

import {
  renderLiveSessionWarning,
  renderSessionDriftWarning,
  renderStoreUnavailableWarning,
} from "./session-store-boot.ts"

describe("session-store boot chrome", () => {
  it("renders startup persistence warnings", () => {
    expect(renderStoreUnavailableWarning("session", "disk full").map(stripAnsi)).toEqual([
      "  warn session store unavailable: disk full",
    ])
    expect(renderStoreUnavailableWarning("blob", "disabled").map(stripAnsi)).toEqual([
      "  warn blob store unavailable: disabled",
    ])
  })

  it("renders resume hazard warnings", () => {
    expect(
      renderLiveSessionWarning({ sid: "sid-1", pid: 123, since: "today" }).map(stripAnsi),
    ).toEqual([
      "  warn session sid-1 appears live (pid 123, since today); resuming anyway will fork the conversation",
    ])
    expect(renderSessionDriftWarning().map(stripAnsi)).toEqual([
      "  warn system prompt or tool set changed since this session was saved — resuming anyway",
    ])
  })
})

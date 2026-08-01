/**
 * Startup provider boot: resume credential-pin skip goes through diag, not stderr.
 *
 * Provider ids in fixtures are intentionally neutral (`alpha` / `beta`) —
 * core architecture forbids real provider tokens in `src/` code.
 *
 * @module host/startup/provider-boot.test
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"

import {
  getDiagnosticBus,
  type LogEvent,
  resetDiagnosticBus,
  Severity,
} from "../../bus/diagnostic-bus.ts"
import { clearModelRegistry, clearProviderRegistry } from "../../llm/model-registry.ts"
import { clearProviderPlugins } from "../../llm/provider-plugin.ts"
import { registerTestProvider } from "../../llm/test-fixtures.ts"

import { resolveStartupProviderState } from "./provider-boot.ts"

describe("resolveStartupProviderState resume pin skip", () => {
  const prevTestAuth = process.env.MINIMAL_AGENT_TEST_AUTH
  let events: LogEvent[] = []
  let unsubscribe: (() => void) | undefined

  beforeEach(() => {
    resetDiagnosticBus()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    events = []
    unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    process.env.MINIMAL_AGENT_TEST_AUTH = "1"
    registerTestProvider({
      id: "beta",
      displayName: "Beta",
      models: [{ id: "beta-fast", displayName: "Beta Fast" }],
    })
  })

  afterEach(() => {
    unsubscribe?.()
    unsubscribe = undefined
    resetDiagnosticBus()
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    if (prevTestAuth === undefined) delete process.env.MINIMAL_AGENT_TEST_AUTH
    else process.env.MINIMAL_AGENT_TEST_AUTH = prevTestAuth
  })

  it("REGRESSION: provider-mismatched resume pin emits diag.warn, not console.error", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const state = await resolveStartupProviderState({
        opts: {
          model: "beta-fast",
          provider: "beta",
        },
        userConfig: {},
        env: {},
        resumeCredentialName: "alpha-oauth-2",
        resumeProviderId: "alpha",
      })

      expect(state.selectedProviderId).toBe("beta")
      expect(state.credentialName).toBeUndefined()

      const pinWarns = events.filter(
        (e) => e.source === "auth.resume-pin" && e.severity === Severity.Warning,
      )
      expect(pinWarns).toHaveLength(1)
      expect(pinWarns[0]?.message).toContain('pin "alpha-oauth-2" skipped')
      expect(pinWarns[0]?.message).toContain("session was alpha")
      expect(pinWarns[0]?.message).toContain("using beta default")
      expect(pinWarns[0]?.structuredData).toEqual({
        pin: "alpha-oauth-2",
        "session-provider": "alpha",
        "selected-provider": "beta",
      })

      const painted = errSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .filter((line) => line.includes("alpha-oauth-2") || line.includes("auth.resume-pin"))
      expect(painted).toEqual([])
    } finally {
      errSpy.mockRestore()
    }
  })

  it("does not emit auth.resume-pin when session provider matches", async () => {
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    try {
      const state = await resolveStartupProviderState({
        opts: {
          model: "beta-fast",
          provider: "beta",
          cliCredentialName: "Beta Default Cred",
        },
        userConfig: {},
        env: {},
        resumeCredentialName: "Beta Default Cred",
        resumeProviderId: "beta",
      })

      expect(state.credentialName).toBe("Beta Default Cred")
      expect(events.filter((e) => e.source === "auth.resume-pin")).toEqual([])
    } finally {
      errSpy.mockRestore()
    }
  })
})

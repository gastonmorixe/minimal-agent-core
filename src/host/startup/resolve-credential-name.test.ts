/**
 * Precedence for CLI / config / resume credential pins.
 *
 * Provider ids in fixtures are intentionally neutral (`alpha` / `beta`) —
 * core architecture forbids real provider tokens in `src/` code.
 *
 * @module host/startup/resolve-credential-name.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { SessionStore } from "../../session/session-store.ts"

import {
  peekResumeCredentialName,
  peekResumeCredentialPin,
  resolveCredentialName,
} from "./resolve-credential-name.ts"

describe("resolveCredentialName", () => {
  it("prefers CLI over config and resume meta", () => {
    expect(
      resolveCredentialName({
        cliCredentialName: "pinned-cred-3",
        configCredentialName: "Default Stored Cred",
        resumeCredentialName: "pinned-cred-2",
        resumeProviderId: "alpha",
        selectedProviderId: "beta",
      }),
    ).toEqual({ credentialName: "pinned-cred-3" })
  })

  it("prefers config over resume meta when CLI is absent", () => {
    expect(
      resolveCredentialName({
        configCredentialName: "Default Stored Cred",
        resumeCredentialName: "pinned-cred-3",
        resumeProviderId: "alpha",
        selectedProviderId: "beta",
      }),
    ).toEqual({ credentialName: "Default Stored Cred" })
  })

  it("REGRESSION: resume meta pin is used when CLI and config omit credentialName", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "pinned-cred-3",
        resumeProviderId: "alpha",
        selectedProviderId: "alpha",
      }),
    ).toEqual({ credentialName: "pinned-cred-3" })
  })

  it("uses resume pin when session provider matches selected provider", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "alpha-oauth-2",
        resumeProviderId: "alpha",
        selectedProviderId: "alpha",
      }),
    ).toEqual({ credentialName: "alpha-oauth-2" })
  })

  it("REGRESSION: skips resume pin when session provider differs from selected", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "alpha-oauth-2",
        resumeProviderId: "alpha",
        selectedProviderId: "beta",
      }),
    ).toEqual({
      resumePinSkipped: {
        pin: "alpha-oauth-2",
        sessionProvider: "alpha",
        selectedProvider: "beta",
      },
    })
  })

  it("keeps resume pin when meta.provider is absent (legacy compat)", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "pinned-cred-3",
        selectedProviderId: "beta",
      }),
    ).toEqual({ credentialName: "pinned-cred-3" })
  })

  it("returns empty result when nothing is pinned", () => {
    expect(resolveCredentialName({})).toEqual({})
  })

  it("treats blank strings as absent", () => {
    expect(
      resolveCredentialName({
        cliCredentialName: "  ",
        configCredentialName: "",
        resumeCredentialName: "pinned-cred-3",
        resumeProviderId: "alpha",
        selectedProviderId: "alpha",
      }),
    ).toEqual({ credentialName: "pinned-cred-3" })
  })

  it("does not emit resumePinSkipped when resume pin is blank", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "  ",
        resumeProviderId: "alpha",
        selectedProviderId: "beta",
      }),
    ).toEqual({})
  })

  it("CLI still wins even when resume would have been skipped", () => {
    expect(
      resolveCredentialName({
        cliCredentialName: "Beta Default Cred",
        resumeCredentialName: "alpha-oauth-2",
        resumeProviderId: "alpha",
        selectedProviderId: "beta",
      }),
    ).toEqual({ credentialName: "Beta Default Cred" })
  })
})

describe("peekResumeCredentialPin", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("reads credentialName and provider from the target session meta for resume", () => {
    const home = mkdtempSync(join(tmpdir(), "ma-peek-cred-"))
    dirs.push(home)
    const prev = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = home
    try {
      SessionStore.open({
        sid: "peek-cred-sid",
        model: "test-model",
        cwd: "/tmp",
        systemHash: "s",
        toolsHash: "t",
        agentVersion: "0.0.0",
        provider: "alpha",
        credentialName: "alpha-oauth-2",
      })
      expect(peekResumeCredentialPin("peek-cred-sid")).toEqual({
        credentialName: "alpha-oauth-2",
        providerId: "alpha",
      })
      expect(peekResumeCredentialName("peek-cred-sid")).toBe("alpha-oauth-2")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
    }
  })

  it("returns credentialName only when provider is omitted (legacy)", () => {
    const home = mkdtempSync(join(tmpdir(), "ma-peek-cred-legacy-"))
    dirs.push(home)
    const prev = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = home
    try {
      SessionStore.open({
        sid: "peek-cred-legacy-sid",
        model: "test-model",
        cwd: "/tmp",
        systemHash: "s",
        toolsHash: "t",
        agentVersion: "0.0.0",
        credentialName: "pinned-cred-3",
      })
      expect(peekResumeCredentialPin("peek-cred-legacy-sid")).toEqual({
        credentialName: "pinned-cred-3",
      })
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
    }
  })

  it("returns empty for missing / unpinned sessions without throwing", () => {
    expect(peekResumeCredentialPin(undefined)).toEqual({})
    expect(peekResumeCredentialPin("does-not-exist-sid-zzzz")).toEqual({})
    expect(peekResumeCredentialName(undefined)).toBeUndefined()
    expect(peekResumeCredentialName("does-not-exist-sid-zzzz")).toBeUndefined()
  })
})

/**
 * Precedence for CLI / config / resume credential pins.
 *
 * @module host/startup/resolve-credential-name.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { SessionStore } from "../../session/session-store.ts"

import { peekResumeCredentialName, resolveCredentialName } from "./resolve-credential-name.ts"

describe("resolveCredentialName", () => {
  it("prefers CLI over config and resume meta", () => {
    expect(
      resolveCredentialName({
        cliCredentialName: "pinned-cred-3",
        configCredentialName: "Default Stored Cred",
        resumeCredentialName: "pinned-cred-2",
      }),
    ).toBe("pinned-cred-3")
  })

  it("prefers config over resume meta when CLI is absent", () => {
    expect(
      resolveCredentialName({
        configCredentialName: "Default Stored Cred",
        resumeCredentialName: "pinned-cred-3",
      }),
    ).toBe("Default Stored Cred")
  })

  it("REGRESSION: resume meta pin is used when CLI and config omit credentialName", () => {
    expect(
      resolveCredentialName({
        resumeCredentialName: "pinned-cred-3",
      }),
    ).toBe("pinned-cred-3")
  })

  it("returns undefined when nothing is pinned", () => {
    expect(resolveCredentialName({})).toBeUndefined()
  })

  it("treats blank strings as absent", () => {
    expect(
      resolveCredentialName({
        cliCredentialName: "  ",
        configCredentialName: "",
        resumeCredentialName: "pinned-cred-3",
      }),
    ).toBe("pinned-cred-3")
  })
})

describe("peekResumeCredentialName", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("reads credentialName from the target session meta for resume", () => {
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
        credentialName: "pinned-cred-3",
      })
      expect(peekResumeCredentialName("peek-cred-sid")).toBe("pinned-cred-3")
    } finally {
      if (prev === undefined) delete process.env.MINIMAL_AGENT_HOME
      else process.env.MINIMAL_AGENT_HOME = prev
    }
  })

  it("returns undefined for missing / unpinned sessions without throwing", () => {
    expect(peekResumeCredentialName(undefined)).toBeUndefined()
    expect(peekResumeCredentialName("does-not-exist-sid-zzzz")).toBeUndefined()
  })
})

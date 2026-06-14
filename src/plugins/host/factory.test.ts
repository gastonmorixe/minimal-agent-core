import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { SessionStore } from "../../session-store.ts"

import { buildPluginHost } from "./factory.ts"

const dir = mkdtempSync(join(tmpdir(), "plugin-host-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const store = SessionStore.open({
  sid: "host-sid",
  model: "m",
  cwd: "/p",
  systemHash: "s",
  toolsHash: "t",
  agentVersion: "0",
  dir,
})
store.appendUser("hello host")

describe("buildPluginHost", () => {
  it("populates ONLY granted namespaces (deny-by-default)", () => {
    const host = buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: dir })
    expect(host.sessions).toBeDefined()
    expect(host.blobs).toBeUndefined()
    expect(host.clock).toBeUndefined()
    expect(host.logger).toBeUndefined()
  })

  it("grants multiple namespaces together", () => {
    const host = buildPluginHost({
      capabilities: ["sessions:read", "blobs:read", "clock"],
      sessionsDir: dir,
    })
    expect(host.sessions).toBeDefined()
    expect(host.blobs).toBeDefined()
    expect(host.clock).toBeDefined()
  })

  it("the host object is frozen", () => {
    const host = buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: dir })
    expect(Object.isFrozen(host)).toBe(true)
    expect(Object.isFrozen(host.sessions)).toBe(true)
    expect(() => {
      ;(host as { sessions?: unknown }).sessions = undefined
    }).toThrow()
  })

  it("granted sessions API actually reads the injected dir", async () => {
    const host = buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: dir })
    const meta = await host.sessions?.meta("host-sid")
    expect(meta?.firstPrompt).toContain("hello host")
  })

  it("clock honors the injected now()", () => {
    const host = buildPluginHost({ capabilities: ["clock"], now: () => 1_000_000 })
    expect(host.clock?.now()).toBe(1_000_000)
    expect(host.clock?.iso()).toBe(new Date(1_000_000).toISOString())
  })

  it("ignores unknown capability strings without throwing", () => {
    const host = buildPluginHost({ capabilities: ["sessions:read", "bogus:cap"] })
    expect(host.sessions).toBeDefined()
  })
})

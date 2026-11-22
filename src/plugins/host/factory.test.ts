import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { type NetworkObserver, type NetworkRequest, NetworkResponse } from "../../network/index.ts"
import { SessionStore } from "../../session/session-store.ts"

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
    expect(meta?.firstPromptParts?.[0]).toContain("hello host")
  })

  it("binds sessions:write to the active SID and denies it without one", async () => {
    expect(
      buildPluginHost({ capabilities: ["sessions:write"], sessionsDir: dir }).sessionsWrite,
    ).toBeUndefined()

    const host = buildPluginHost({
      capabilities: ["sessions:write"],
      sessionsDir: dir,
      activeSessionId: "host-sid",
    })
    const begun = await host.sessionsWrite?.beginHistoryEdit({ targetUserId: "missing" })
    expect(begun).toMatchObject({ ok: false, code: "target_not_found" })
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

  describe("paths capability", () => {
    it("is undefined unless granted (deny-by-default)", () => {
      const host = buildPluginHost({ capabilities: ["clock"] })
      expect(host.paths).toBeUndefined()
    })

    it("exposes home / sessionsDir / netDbgDir resolved from the injected env", () => {
      const host = buildPluginHost({
        capabilities: ["paths"],
        env: { MINIMAL_AGENT_HOME: "/tmp/ma-host" },
      })
      expect(host.paths?.home()).toBe("/tmp/ma-host")
      expect(host.paths?.sessionsDir()).toBe("/tmp/ma-host/sessions")
      expect(host.paths?.netDbgDir()).toBe("/tmp/ma-host/net-dbg")
    })

    it("the paths API is frozen", () => {
      const host = buildPluginHost({
        capabilities: ["paths"],
        env: { MINIMAL_AGENT_HOME: "/tmp/x" },
      })
      expect(Object.isFrozen(host.paths)).toBe(true)
    })
  })
})

describe("buildPluginHost: network:observe", () => {
  it("is absent unless the manifest declares it", () => {
    expect(buildPluginHost({ capabilities: ["clock"] }).network).toBeUndefined()
  })

  it("attaches a guarded observer to the given client, and detaches it", () => {
    const attached: NetworkObserver[] = []
    const host = buildPluginHost({
      capabilities: ["network:observe"],
      pluginName: "wire-tap",
      networkClient: {
        addObserver(observer) {
          attached.push(observer)
          return () => {
            attached.splice(attached.indexOf(observer), 1)
          }
        },
      },
    })
    expect(Object.isFrozen(host.network)).toBe(true)

    const seen: string[] = []
    const stop = host.network!.observe({
      onChunk: (req, chunk) => seen.push(`${req.id}:${chunk.length}`),
    })
    expect(attached).toHaveLength(1)

    // The attached observer is the guarded adapter, not the plugin's object:
    // the plugin gets a copy of the chunk, never the live bytes.
    const live = new Uint8Array([1, 2, 3])
    const req: NetworkRequest = { id: "r1", label: "l", method: "GET", url: "https://x.test/" }
    attached[0]!.onChunk?.(
      req,
      live,
      new NetworkResponse({ status: 200, headers: {}, transport: { id: "t" } }),
    )
    expect(seen).toEqual(["r1:3"])

    stop()
    expect(attached).toHaveLength(0)
  })
})

describe("buildPluginHost / sessions:files (paste plugin v3, B2)", () => {
  const SID = "ba0ad20f-1111-4111-8111-111111111111"

  it("is granted only for the sessions:files capability", () => {
    expect(
      buildPluginHost({ capabilities: ["sessions:read"], sessionsDir: dir, pluginId: "demo" })
        .sessionFiles,
    ).toBeUndefined()
    const host = buildPluginHost({
      capabilities: ["sessions:files"],
      sessionsDir: dir,
      pluginId: "demo",
    })
    expect(host.sessionFiles).toBeDefined()
    expect(Object.isFrozen(host.sessionFiles)).toBe(true)
    expect(host.sessions).toBeUndefined()
  })

  it("is not granted without a safe plugin id", () => {
    expect(
      buildPluginHost({ capabilities: ["sessions:files"], sessionsDir: dir }).sessionFiles,
    ).toBeUndefined()
    expect(
      buildPluginHost({ capabilities: ["sessions:files"], sessionsDir: dir, pluginId: "../x" })
        .sessionFiles,
    ).toBeUndefined()
  })

  it("writes into <sessionsDir>/<sid>.files/<pluginId>/", () => {
    const host = buildPluginHost({
      capabilities: ["sessions:files"],
      sessionsDir: dir,
      pluginId: "demo",
    })
    expect(host.sessionFiles!.create(SID, "a.txt", "grant")).toBe("ok")
    expect(readFileSync(join(dir, `${SID}.files`, "demo", "a.txt"), "utf8")).toBe("grant")
  })
})

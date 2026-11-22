/**
 * Paste plugin v3, B4: a manifest hook can ask for the plugin host
 * (`"host": true`). Only a hook with the opt-in gets `ctx.host`, and the
 * host has only the manifest capabilities. End to end with the real loader.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { PluginHost } from "@minimal-agent/core/plugin-api/types/host-capabilities"

import { splitFlatManifest } from "../../test-utils/split-manifest.ts"
import { EventBus } from "../event-bus.ts"
import { PluginLoader } from "../loader.ts"

const KEY = "__b4HookHost"
const SID = "ba0ad20f-1111-4111-8111-111111111111"

type Seen = Record<string, { host?: PluginHost }>
const seen = (): Seen => ((globalThis as Record<string, unknown>)[KEY] ??= {}) as Seen

describe("PluginLoader / hook ctx.host (host: true)", () => {
  let root = ""
  let prevHome: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "b4-hook-host-"))
    prevHome = process.env.MINIMAL_AGENT_HOME
    process.env.MINIMAL_AGENT_HOME = join(root, ".minimal-agent")
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = prevHome
    delete (globalThis as Record<string, unknown>)[KEY]
    rmSync(root, { recursive: true, force: true })
  })

  function writePlugin(id: string, host?: boolean): void {
    const dir = join(root, "plugins", id)
    mkdirSync(dir, { recursive: true })
    const manifest = {
      id,
      name: id,
      version: "0.1.0",
      description: "test",
      capabilities: ["sessions:files"],
      permissions: ["hooks:message.willSend"],
      hooks: [
        {
          id: "send",
          channel: "message.willSend",
          handler: { type: "module", path: "./h.ts", export: "default" },
          ...(host !== undefined ? { host } : {}),
        },
      ],
    }
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(splitFlatManifest(manifest), null, 2))
    writeFileSync(
      join(dir, "h.ts"),
      `export default function (_payload, ctx) {
        const g = globalThis
        g.${KEY} = g.${KEY} ?? {}
        g.${KEY}[${JSON.stringify(id)}] = { host: ctx.host }
      }\n`,
    )
  }

  test("a hook with host:true sees ctx.host.sessionFiles; a hook without it sees no host", async () => {
    writePlugin("hook-in", true)
    writePlugin("hook-out")
    writePlugin("hook-false", false)
    const sessionsDir = join(root, "sessions")
    const bus = new EventBus(() => {})
    const loader = await PluginLoader.load({
      userDir: root,
      logger: () => {},
      bus,
      hostOptions: { sessionsDir },
    })
    try {
      await loader.hooks().emitChain("message.willSend", { messages: [], system: [] })
      const s = seen()
      expect(Object.keys(s).sort()).toEqual(["hook-false", "hook-in", "hook-out"])
      const host = s["hook-in"]?.host
      expect(host).toBeDefined()
      expect(host).toBe(loader.capabilityHostFor("hook-in"))
      expect(host?.capabilities).toEqual(["sessions:files"])
      expect(host?.sessions).toBeUndefined()
      // The API works, under the plugin id dir.
      expect(host?.sessionFiles?.create(SID, "a.txt", "x")).toBe("ok")
      expect(host?.sessionFiles?.read(SID, "a.txt")).toBe("x")
      expect(loader.capabilityHostFor("hook-out")?.sessionFiles?.read(SID, "a.txt")).toBeNull()
      expect(s["hook-out"]?.host).toBeUndefined()
      expect(s["hook-false"]?.host).toBeUndefined()
    } finally {
      bus.dispose()
    }
  })
})

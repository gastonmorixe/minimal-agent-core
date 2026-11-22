/**
 * `bootHost` `sessionsDir` and `isOwnedSession` (paste plugin v3, B5).
 *
 * A host that keeps its sessions in a custom dir (the web: `persistDir`)
 * gives that dir to `bootHost`, so `sessions:files` and `sessions:meta` find
 * `<dir>/<sid>.jsonl`. `null` is a memory-only host: no grant, one warning.
 * `undefined` keeps the default `<home>/sessions`.
 *
 * @module host-public/host-boot-sessions-dir.test
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { bootHost } from "@minimal-agent/core/host-kit/host-boot"

import { TOOL_HANDLER_BODY, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"
import { getSessionId } from "../session/session-id.ts"

const root = mkdtempSync(join(tmpdir(), "host-boot-sessions-dir-"))
const savedHome = process.env.MINIMAL_AGENT_HOME
const SID = "d17b0257-2222-4222-8222-222222222222"

afterAll(() => {
  if (savedHome === undefined) delete process.env.MINIMAL_AGENT_HOME
  else process.env.MINIMAL_AGENT_HOME = savedHome
  rmSync(root, { recursive: true, force: true })
})

let n = 0

/** A fresh home with one plugin that declares `capabilities`. */
function setup(pluginId: string, capabilities: string[]): { home: string; custom: string } {
  n += 1
  const home = join(root, `home-${n}`)
  const custom = join(root, `custom-${n}`)
  mkdirSync(custom, { recursive: true })
  writePackage(
    home,
    pluginId,
    { ...toolManifest(pluginId, `${pluginId.replace(/-/g, "_")}_tool`, "./tool.ts"), capabilities },
    { "tool.ts": TOOL_HANDLER_BODY },
  )
  return { home, custom }
}

const rootsOf = (home: string) => ({ user: [join(home, "plugins")] })

describe("bootHost sessionsDir / isOwnedSession", () => {
  it("a custom sessionsDir: sessions:files writes under <customDir>/<sid>.files/<pluginId>/", async () => {
    const { home, custom } = setup("b5-files", ["sessions:files"])
    writeFileSync(join(custom, `${SID}.jsonl`), "")
    const host = await bootHost({
      home,
      pluginRoots: rootsOf(home),
      sessionsDir: custom,
      isOwnedSession: (sid) => sid === SID,
    })
    const files = host.loader.capabilityHostFor("b5-files")?.sessionFiles
    expect(files).toBeDefined()
    expect(files?.create(SID, "a.txt", "hello")).toBe("ok")
    expect(files?.read(SID, "a.txt")).toBe("hello")
    const path = join(custom, `${SID}.files`, "b5-files", "a.txt")
    expect(readFileSync(path, "utf8")).toBe("hello")
    expect(existsSync(join(home, "sessions", `${SID}.files`))).toBe(false)
  })

  it("isOwnedSession is passed through: without it, the same sid is rejected outside the scope", async () => {
    const { home, custom } = setup("b5-owner", ["sessions:files", "sessions:meta"])
    writeFileSync(join(custom, `${SID}.jsonl`), "")
    const host = await bootHost({ home, pluginRoots: rootsOf(home), sessionsDir: custom })
    const caps = host.loader.capabilityHostFor("b5-owner")
    expect(caps?.sessionFiles?.create(SID, "a.txt", "x")).toBe("error")
    expect(() => caps?.sessionMeta?.getTitle(SID)).toThrow()

    const owned = await bootHost({
      home,
      pluginRoots: rootsOf(home),
      sessionsDir: custom,
      isOwnedSession: (sid) => sid === SID,
    })
    const ownedCaps = owned.loader.capabilityHostFor("b5-owner")
    expect(ownedCaps?.sessionFiles?.create(SID, "a.txt", "x")).toBe("ok")
    expect(ownedCaps?.sessionMeta?.getTitle(SID)).toBeDefined()
  })

  it("sessionsDir null: no sessionFiles or sessionMeta, and one diagnostic for the plugin", async () => {
    const { home } = setup("b5-memory", ["sessions:files", "sessions:meta", "paths"])
    const host = await bootHost({ home, pluginRoots: rootsOf(home), sessionsDir: null })
    const bootCount = host.diagnostics.length
    const caps = host.loader.capabilityHostFor("b5-memory")
    expect(caps).toBeDefined()
    expect(caps?.sessionFiles).toBeUndefined()
    expect(caps?.sessionMeta).toBeUndefined()
    expect(caps?.paths).toBeDefined()
    // A second host build of the same plugin gives no second warning.
    host.loader.capabilityHostFor("b5-memory")
    const warnings = host.diagnostics
      .slice(bootCount)
      .filter((d) => d.message.includes("b5-memory") && d.message.includes("memory-only"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.message).toContain("sessions:files")
  })

  it("default (undefined): sessions:files uses <home>/sessions, as before", async () => {
    const { home } = setup("b5-default", ["sessions:files"])
    const sid = getSessionId()
    const host = await bootHost({ home, pluginRoots: rootsOf(home) })
    mkdirSync(join(home, "sessions"), { recursive: true })
    writeFileSync(join(home, "sessions", `${sid}.jsonl`), "")
    const files = host.loader.capabilityHostFor("b5-default")?.sessionFiles
    expect(files?.create(sid, "a.txt", "d")).toBe("ok")
    expect(
      readFileSync(join(home, "sessions", `${sid}.files`, "b5-default", "a.txt"), "utf8"),
    ).toBe("d")
    // A sid the host does not own stays rejected.
    writeFileSync(join(home, "sessions", `${SID}.jsonl`), "")
    expect(files?.create(SID, "a.txt", "d")).toBe("error")
  })
})

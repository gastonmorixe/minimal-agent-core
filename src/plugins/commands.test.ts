/**
 * Tests for the slash-command host port: manifest validation, loader
 * registry (collection + first-wins collision), and `dispatchCommand`
 * (the CommandResult union, unknown/non-command pass-through, handler
 * throw → error result).
 *
 * @module plugins/commands.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { PluginLoader } from "./loader.ts"
import { ManifestError, parseManifest } from "./manifest.ts"

let ROOT: string

beforeEach(() => {
  ROOT = mkdtempSync(join(tmpdir(), "ma-cmds-"))
})
afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Write a plugin package with `commands[]` + a handler module. */
function writeCommandPlugin(id: string, names: string[], handlerBody: string): void {
  const dir = join(ROOT, "plugins", id)
  mkdirSync(dir, { recursive: true })
  const manifest = {
    id,
    name: id,
    version: "0.1.0",
    description: "test command plugin",
    commands: names.map((name) => ({
      name,
      summary: `the ${name} command`,
      argHint: "<args>",
      handler: { type: "module", path: "./cmd.ts", export: "default" },
    })),
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  writeFileSync(join(dir, "cmd.ts"), handlerBody)
}

const HANDLER = `
export default async function (ctx) {
  switch (ctx.argv) {
    case "expand": return { kind: "expand", prompt: "EXPANDED:" + ctx.name }
    case "notice": return { kind: "notice", lines: ["line one", "line two"] }
    case "block": return { kind: "notice", block: { icon: "⟳", title: "loop", info: "every 5m", body: ["do work"], footer: "id-1", color: "gold" } }
    case "error": return { kind: "error", message: "nope" }
    case "throw": throw new Error("handler exploded")
    case "bad": return { kind: "weird-unknown" }
    default: return { kind: "none" }
  }
}
`

async function loadFrom(): Promise<PluginLoader> {
  return PluginLoader.load({ embeddedDir: ROOT, homeDir: ROOT, projectDir: ROOT, logger: () => {} })
}

describe("manifest: commands[] validation", () => {
  const base = { id: "p", name: "P", version: "0.1.0", description: "d" }

  it("accepts a well-formed command", () => {
    const m = parseManifest(
      {
        ...base,
        commands: [
          { name: "loop", summary: "loop it", handler: { type: "module", path: "./h.ts" } },
        ],
      },
      "/x/manifest.json",
    )
    expect(m.commands?.[0]).toMatchObject({ name: "loop", summary: "loop it" })
  })

  it("rejects a non-array commands field", () => {
    expect(() => parseManifest({ ...base, commands: {} }, "/x")).toThrow(ManifestError)
  })

  it("rejects a bad command name", () => {
    expect(() =>
      parseManifest(
        {
          ...base,
          commands: [
            { name: "Bad Name", summary: "s", handler: { type: "module", path: "./h.ts" } },
          ],
        },
        "/x",
      ),
    ).toThrow(/command name must match/)
  })

  it("rejects a duplicate command name within a package", () => {
    const cmd = { name: "dup", summary: "s", handler: { type: "module", path: "./h.ts" } }
    expect(() => parseManifest({ ...base, commands: [cmd, cmd] }, "/x")).toThrow(
      /duplicate command/,
    )
  })

  it("rejects a missing summary", () => {
    expect(() =>
      parseManifest(
        { ...base, commands: [{ name: "x", handler: { type: "module", path: "./h.ts" } }] },
        "/x",
      ),
    ).toThrow(ManifestError)
  })

  it("rejects a subprocess handler (module-only for now)", () => {
    expect(() =>
      parseManifest(
        {
          ...base,
          commands: [{ name: "x", summary: "s", handler: { type: "subprocess", command: ["x"] } }],
        },
        "/x",
      ),
    ).toThrow(/must be type "module"/)
  })
})

describe("loader: command registry", () => {
  it("registers + lists commands", async () => {
    writeCommandPlugin("p", ["loop", "schedule"], HANDLER)
    const loader = await loadFrom()
    expect(loader.hasCommand("loop")).toBe(true)
    expect(loader.hasCommand("schedule")).toBe(true)
    expect(loader.hasCommand("nope")).toBe(false)
    const info = loader.listCommandInfo()
    expect(info.map((c) => c.name)).toEqual(["loop", "schedule"]) // sorted
    expect(info[0]).toMatchObject({ name: "loop", summary: "the loop command", pluginId: "p" })
  })

  it("first-wins on cross-plugin name collision", async () => {
    writeCommandPlugin("a-plugin", ["dup"], HANDLER)
    writeCommandPlugin("b-plugin", ["dup"], HANDLER.replace("EXPANDED:", "OTHER:"))
    const loader = await loadFrom()
    const cmds = loader.getCommands().filter((c) => c.spec.name === "dup")
    expect(cmds).toHaveLength(1)
    // Whichever loaded first keeps the slot; both exist on disk but the
    // registry holds exactly one "dup".
    expect(loader.hasCommand("dup")).toBe(true)
  })

  it("registerHostCommand installs a host-owned command into the menu", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    expect(loader.hasCommand("compact")).toBe(false)
    const ok = loader.registerHostCommand({
      pluginId: "host",
      packageDir: "",
      entryAbsolute: "",
      spec: {
        name: "compact",
        summary: "Compact model-facing context",
        handler: { type: "module", path: "", export: "default" },
      },
      invoke: async () => ({ kind: "notice", lines: ["compacted"] }),
    })
    expect(ok).toBe(true)
    expect(loader.hasCommand("compact")).toBe(true)
    const info = loader.listCommandInfo()
    expect(info.find((c) => c.name === "compact")).toMatchObject({
      name: "compact",
      pluginId: "host",
      summary: "Compact model-facing context",
    })
    expect(await loader.dispatchCommand("/compact")).toEqual({
      kind: "notice",
      lines: ["compacted"],
    })
  })

  it("registerHostCommand first-wins against an existing plugin command", async () => {
    writeCommandPlugin("p", ["compact"], HANDLER)
    const loader = await loadFrom()
    const ok = loader.registerHostCommand({
      pluginId: "host",
      packageDir: "",
      entryAbsolute: "",
      spec: {
        name: "compact",
        summary: "host compact",
        handler: { type: "module", path: "", export: "default" },
      },
      invoke: async () => ({ kind: "notice", lines: ["host"] }),
    })
    expect(ok).toBe(false)
    expect(loader.listCommandInfo().find((c) => c.name === "compact")?.pluginId).toBe("p")
  })
})

describe("loader: dispatchCommand", () => {
  it("returns null for a non-command line", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    expect(await loader.dispatchCommand("just a prompt")).toBeNull()
    expect(await loader.dispatchCommand("/usr/bin/env")).toBeNull()
  })

  it("returns null for an unknown command (falls through to prompt)", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    expect(await loader.dispatchCommand("/unknown thing")).toBeNull()
  })

  it("dispatches expand / notice / error / none", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    expect(await loader.dispatchCommand("/loop expand")).toEqual({
      kind: "expand",
      prompt: "EXPANDED:loop",
    })
    expect(await loader.dispatchCommand("/loop notice")).toEqual({
      kind: "notice",
      lines: ["line one", "line two"],
    })
    expect(await loader.dispatchCommand("/loop block")).toEqual({
      kind: "notice",
      block: {
        icon: "⟳",
        title: "loop",
        info: "every 5m",
        body: ["do work"],
        footer: "id-1",
        color: "gold",
      },
    })
    expect(await loader.dispatchCommand("/loop error")).toEqual({ kind: "error", message: "nope" })
    expect(await loader.dispatchCommand("/loop")).toEqual({ kind: "none" })
  })

  it("turns a handler throw into an error result", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    const r = await loader.dispatchCommand("/loop throw")
    expect(r?.kind).toBe("error")
    expect((r as { message: string }).message).toContain("handler exploded")
  })

  it("turns a malformed handler return into an error result", async () => {
    writeCommandPlugin("p", ["loop"], HANDLER)
    const loader = await loadFrom()
    const r = await loader.dispatchCommand("/loop bad")
    expect(r?.kind).toBe("error")
    expect((r as { message: string }).message).toContain("unknown result kind")
  })

  it("passes argv through to the handler", async () => {
    writeCommandPlugin(
      "p",
      ["echo"],
      `export default (ctx) => ({ kind: "notice", lines: ["argv=[" + ctx.argv + "]"] })`,
    )
    const loader = await loadFrom()
    const r = await loader.dispatchCommand("/echo  5m check the deploy  ")
    expect(r).toEqual({ kind: "notice", lines: ["argv=[5m check the deploy]"] })
  })

  it("ctx.emit is shape-aware: broadcast-sync goes to the HookBus, async to the EventBus", async () => {
    writeCommandPlugin(
      "p",
      ["paint"],
      `export default (ctx) => {
         ctx.emit("editor.footer.set", { lines: ["row"] }) // broadcast-sync (HookBus)
         ctx.emit("prompt.inject", { text: "go" })         // broadcast-async (EventBus)
         return { kind: "none" }
       }`,
    )
    const loader = await loadFrom()

    const syncSeen: unknown[] = []
    const asyncSeen: unknown[] = []
    // broadcast-sync channel: a listener registered through the Hooks
    // facade lands on the HookBus. If the command's emit weren't
    // shape-aware it would hit the EventBus and this listener never fires.
    loader.hooks().on("editor.footer.set", (payload: unknown) => void syncSeen.push(payload), {
      caller: "agent",
      priority: 1,
      label: "test:footer",
    })
    // broadcast-async channel goes through the EventBus.
    loader.bus().on("prompt.inject", (ctx) => void asyncSeen.push(ctx.payload))

    const r = await loader.dispatchCommand("/paint")
    expect(r).toEqual({ kind: "none" })
    expect(syncSeen).toEqual([{ lines: ["row"] }])
    // EventBus delivery is microtask-deferred; flush before asserting.
    await Promise.resolve()
    expect(asyncSeen).toEqual([{ text: "go" }])
  })
})

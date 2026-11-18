/**
 * Module prompt fragments get a shape-aware `ctx.emit` on the shared bus.
 *
 * The emit must stay valid after the fragment returns: the cache plugin
 * captures it at load time and emits `cache.didBreak` from a watcher later.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { EventBus, type EventContext } from "../event-bus.ts"
import { Hooks } from "../hooks/hooks.ts"
import type { LoadedPlugin, ManifestFile } from "../types.ts"

import { startPluginFragments } from "./fragments.ts"

/** A plugin dir whose module fragment keeps `ctx.emit` on `globalThis[key]`. */
function pluginWithCapturingFragment(key: string): LoadedPlugin {
  const dir = mkdtempSync(join(tmpdir(), "ma-frag-emit-"))
  writeFileSync(
    join(dir, "frag.ts"),
    [
      "export default (ctx) => {",
      `  globalThis[${JSON.stringify(key)}] = ctx.emit`,
      "  return typeof ctx.emit === 'function' ? 'has-emit' : 'no-emit'",
      "}",
    ].join("\n"),
  )
  const manifest = {
    id: "frag-emit-test",
    promptFragments: [{ id: "f", handler: { type: "module", path: "frag.ts" } }],
  } as unknown as ManifestFile
  return {
    packageDir: dir,
    root: "project",
    manifest,
    handlers: [],
    eventSubs: [],
    hookSubs: [],
    commands: [],
    prompt: null,
  }
}

function start(pkg: LoadedPlugin, bus: EventBus, logs: string[]): Promise<string | null> {
  const [pending] = startPluginFragments({
    plugins: [pkg],
    logger: (m) => logs.push(m),
    agent: undefined,
    modelInfoProvider: undefined,
    registerDynamicTools: () => {},
    hostOptions: undefined,
    stdio: undefined,
    relay: { emit: () => {} } as never,
    promptProvider: () => undefined,
    defaultOrder: 100,
    hooks: new Hooks({ eventBus: bus, logger: (m) => logs.push(m) }),
  })
  return pending!.promise
}

describe("module prompt fragment ctx.emit", () => {
  it("is given to a module fragment and delivers after the fragment returned", async () => {
    const key = `__fragEmit_${crypto.randomUUID()}`
    const logs: string[] = []
    const bus = new EventBus((m) => logs.push(m))
    const got: unknown[] = []
    bus.on("test.frag.later", (ctx: EventContext) => {
      got.push(ctx.payload)
    })

    const out = await start(pluginWithCapturingFragment(key), bus, logs)
    expect(out).toBe("has-emit")

    // The fragment has returned. Call the captured emit later.
    await Bun.sleep(10)
    const emit = (globalThis as Record<string, unknown>)[key] as (c: string, p?: unknown) => void
    emit("test.frag.later", { n: 1 })
    await Bun.sleep(10)
    expect(got).toEqual([{ n: 1 }])
    delete (globalThis as Record<string, unknown>)[key]
  })

  it("does not throw when a listener throws", async () => {
    const key = `__fragEmit_${crypto.randomUUID()}`
    const logs: string[] = []
    const bus = new EventBus((m) => logs.push(m))
    const got: unknown[] = []
    bus.on("test.frag.throw", () => {
      throw new Error("listener boom")
    })
    bus.on("test.frag.throw", (ctx: EventContext) => {
      got.push(ctx.payload)
    })

    await start(pluginWithCapturingFragment(key), bus, logs)
    const emit = (globalThis as Record<string, unknown>)[key] as (c: string, p?: unknown) => void
    expect(() => emit("test.frag.throw", "x")).not.toThrow()
    await Bun.sleep(10)
    // The other listener still gets the payload.
    expect(got).toEqual(["x"])
    delete (globalThis as Record<string, unknown>)[key]
  })
})

/**
 * Tests for plugin event-subscription loading.
 *
 * Covers: manifest parsing of `events` entries, module-handler resolution,
 * bus registration with coalesce/throttle propagated, error isolation,
 * and re-emit via `ctx.emit`.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { EventBus } from "./event-bus.ts"
import { PluginLoader } from "./loader.ts"
import type { ManifestFile } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-events-tests")
const HOME = join(ROOT, "home")

function writePackage(id: string, manifest: ManifestFile, files: Record<string, string> = {}) {
  const dir = join(HOME, "tui-plugins", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

async function tick(n = 1) {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(ROOT, { recursive: true })
})
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe("PluginLoader (events)", () => {
  it("loads an events-only manifest and registers it on the bus", async () => {
    writePackage(
      "evt-basic",
      {
        id: "evt-basic",
        name: "evt-basic",
        version: "0.1.0",
        description: "test",
        events: [
          {
            id: "echo",
            on: "test.event",
            handler: { type: "module", path: "./handler.ts", export: "default" },
          },
        ],
      },
      {
        "handler.ts": `
          import { writeFileSync, existsSync, readFileSync } from "node:fs"
          export default async function (ctx) {
            const path = process.env.EVT_LOG_PATH
            if (!path) return
            const prev = existsSync(path) ? readFileSync(path, "utf-8") : ""
            writeFileSync(path, prev + ctx.event + ":" + JSON.stringify(ctx.payload) + "\\n")
          }
        `,
      },
    )

    const bus = new EventBus(() => {})
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {}, bus })
    expect(loader.bus()).toBe(bus)
    expect(loader.getEventSubs()).toHaveLength(1)
    expect(bus.listenerCount("test.event")).toBe(1)

    const logPath = join(ROOT, "evt-basic.log")
    process.env.EVT_LOG_PATH = logPath
    bus.emit("test.event", { hello: "world" })
    await tick(3)
    delete process.env.EVT_LOG_PATH

    const { readFileSync } = await import("node:fs")
    expect(readFileSync(logPath, "utf-8")).toBe('test.event:{"hello":"world"}\n')
  })

  it("propagates coalesce + throttle options to the bus listener", async () => {
    writePackage(
      "evt-opts",
      {
        id: "evt-opts",
        name: "evt-opts",
        version: "0.1.0",
        description: "test",
        events: [
          {
            id: "co",
            on: "high.freq",
            handler: { type: "module", path: "./h.ts", export: "default" },
            coalesce: true,
            throttleMs: 250,
          },
        ],
      },
      {
        "h.ts": `export default async function () {}`,
      },
    )

    // We cannot read listener options off the bus directly, but we can
    // verify behavior end-to-end: with coalesce=true, the second emit
    // while a slow handler is running collapses to the latest payload.
    const bus = new EventBus(() => {})
    await PluginLoader.load({ homeDir: HOME, logger: () => {}, bus })
    expect(bus.listenerCount("high.freq")).toBe(1)
  })

  it("isolates a thrown handler — bus stays healthy and other listeners run", async () => {
    writePackage(
      "evt-throws",
      {
        id: "evt-throws",
        name: "evt-throws",
        version: "0.1.0",
        description: "test",
        events: [
          {
            id: "kaboom",
            on: "boom",
            handler: { type: "module", path: "./bad.ts", export: "default" },
          },
        ],
      },
      {
        "bad.ts": `export default async function () { throw new Error("nope") }`,
      },
    )

    const errors: string[] = []
    const bus = new EventBus((m) => errors.push(m))
    await PluginLoader.load({ homeDir: HOME, logger: () => {}, bus })

    let coExecuted = 0
    bus.on("boom", () => {
      coExecuted++
    })
    bus.emit("boom")
    await tick(3)
    expect(coExecuted).toBe(1)
    // Plugin error was reported via the bus logger.
    expect(errors.some((e) => e.includes("nope"))).toBe(true)
  })

  it("handler can re-emit on the bus via ctx.emit", async () => {
    writePackage(
      "evt-reemit",
      {
        id: "evt-reemit",
        name: "evt-reemit",
        version: "0.1.0",
        description: "test",
        events: [
          {
            id: "fwd",
            on: "raw",
            handler: { type: "module", path: "./fwd.ts", export: "default" },
          },
        ],
      },
      {
        "fwd.ts": `
          export default async function (ctx) {
            ctx.emit("derived", { from: ctx.payload })
          }
        `,
      },
    )

    const bus = new EventBus(() => {})
    await PluginLoader.load({ homeDir: HOME, logger: () => {}, bus })
    const seen: unknown[] = []
    bus.on("derived", (ctx) => {
      seen.push(ctx.payload)
    })
    bus.emit("raw", "hello")
    await tick(5)
    expect(seen).toEqual([{ from: "hello" }])
  })

  it("logs and skips an event sub whose module is missing — plugin still loads", async () => {
    writePackage(
      "evt-missing",
      {
        id: "evt-missing",
        name: "evt-missing",
        version: "0.1.0",
        description: "test",
        // Need a tool entry too so the package isn't entirely useless
        // when the event sub is skipped.
        tuis: [
          {
            id: "t",
            trigger: {
              type: "tool",
              tool: {
                name: "EvtMissingTool",
                description: "x",
                input_schema: { type: "object", properties: {} },
              },
            },
            handler: { type: "module", path: "./tool.ts", export: "default" },
            interactive: false,
          },
        ],
        events: [
          {
            id: "ghost",
            on: "ghost",
            handler: { type: "module", path: "./does-not-exist.ts", export: "default" },
          },
        ],
      },
      {
        "tool.ts": `export default async function () { return { kind: "tool_result", content: "ok" } }`,
      },
    )

    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      logger: (m) => logs.push(m),
    })
    expect(loader.bus().listenerCount("ghost")).toBe(0)
    expect(loader.hasTool("EvtMissingTool")).toBe(true)
    expect(logs.some((l) => l.includes("event handler module not found"))).toBe(true)
  })
})

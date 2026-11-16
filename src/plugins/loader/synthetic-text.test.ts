import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"
import { clearEmbeddedPlugins, embeddedPluginPackages, registerEmbeddedPlugins } from "../source.ts"
import type { LoadedPlugin } from "../types.ts"

import { collectSyntheticTextProviders, EMPTY_SYNTHETIC_HOLDER } from "./synthetic-text.ts"

const ROOT = resolve(__dirname, "../../../tmp/loader-synthetic-text-tests")
const EMBEDDED = join(ROOT, "embedded")
const USER = join(ROOT, "user")
const NO_PROJECT = join(ROOT, "nope-project")

const prov = (tag: string) =>
  `export function make() { return { kinds: ["continue.max_tokens"], text: () => "R:${tag}" } }
export default function () { return { kinds: ["tool_result.handler_error"], text: () => "D:${tag}" } }`

const SIDE = `globalThis.__stOutside = true
export default () => ({ kinds: [], text: () => "OUT" })`

function pkg(id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  writePackage(EMBEDDED, id, { id, name: id, version: "0.1.0", description: "t", ...extra }, files)
}

async function load(disabled: string[] = []) {
  const events: LogEvent[] = []
  const loader = await PluginLoader.load({
    embeddedDir: EMBEDDED,
    userDir: USER,
    roots: { project: [NO_PROJECT] },
    diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }),
    logger: () => {},
    disabledPluginIds: new Set(disabled),
  })
  return { loader, events }
}

const failed = (events: LogEvent[]) =>
  events.filter((e) => e.source === "synthetic_text.load_failed")
const texts = (l: PluginLoader) =>
  l.syntheticTextProviders().map((p) => p.text("tool_result.handler_error", {}))

describe("manifest syntheticText wiring", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
    mkdirSync(USER, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("collects the default export and picks a named export", async () => {
    pkg("st-a", { syntheticText: [{ id: "x", entry: "./p.js" }] }, { "p.js": prov("a") })
    pkg(
      "st-b",
      { syntheticText: [{ id: "x", entry: "./p.js", export: "make" }] },
      { "p.js": prov("b") },
    )
    const { loader, events } = await load()
    expect(loader.syntheticTextProviders().map((p) => p.kinds[0])).toEqual([
      "tool_result.handler_error",
      "continue.max_tokens",
    ])
    expect(failed(events)).toHaveLength(0)
  })

  it("reports a missing module, a throwing factory and junk once each", async () => {
    pkg("st-c", { syntheticText: [{ id: "x", entry: "./nope.js" }] })
    pkg(
      "st-d",
      { syntheticText: [{ id: "x", entry: "./p.js" }] },
      { "p.js": "export default () => { throw new Error('no') }" },
    )
    pkg(
      "st-e",
      { syntheticText: [{ id: "x", entry: "./p.js" }] },
      { "p.js": "export default () => ({ kinds: [] })" },
    )
    const { loader, events } = await load()
    expect(loader.syntheticTextProviders()).toHaveLength(0)
    const f = failed(events)
    expect(f).toHaveLength(3)
    expect(f.every((e) => e.message === "")).toBe(true)
    expect(
      f
        .map((e) => e.structuredData)
        .sort((a, b) => String(a?.pluginId).localeCompare(String(b?.pluginId))),
    ).toEqual([
      { pluginId: "st-c", id: "x" },
      { pluginId: "st-d", id: "x" },
      { pluginId: "st-e", id: "x" },
    ])
  })

  it("rejects an async factory without leaking a rejection", async () => {
    pkg(
      "st-f",
      { syntheticText: [{ id: "x", entry: "./p.js" }] },
      { "p.js": "export default async () => { throw new Error('late') }" },
    )
    const { loader, events } = await load()
    expect(loader.syntheticTextProviders()).toHaveLength(0)
    expect(failed(events)).toHaveLength(1)
  })

  it("rejects ../ and absolute entries without importing them", async () => {
    const g = globalThis as Record<string, unknown>
    delete g.__stOutside
    mkdirSync(join(EMBEDDED, "plugins"), { recursive: true })
    const outside = join(EMBEDDED, "plugins", "outside.js")
    writeFileSync(outside, SIDE)
    pkg("st-g", { syntheticText: [{ id: "x", entry: "../outside.js" }] })
    pkg("st-h", { syntheticText: [{ id: "y", entry: outside }] })
    const { loader, events } = await load()
    expect(g.__stOutside).toBeUndefined()
    expect(loader.syntheticTextProviders()).toHaveLength(0)
    expect(failed(events)).toHaveLength(2)
  })

  it("does not collect from a disabled plugin", async () => {
    pkg("st-i", { syntheticText: [{ id: "x", entry: "./p.js" }] }, { "p.js": prov("i") })
    const { loader } = await load(["st-i"])
    expect(loader.syntheticTextProviders()).toHaveLength(0)
  })

  it("does not collect from a shadowed plugin", async () => {
    pkg("st-j", { syntheticText: [{ id: "x", entry: "./p.js" }] }, { "p.js": prov("embedded") })
    writePackage(
      USER,
      "st-j",
      {
        id: "st-j",
        name: "st-j",
        version: "0.1.0",
        description: "t",
        syntheticText: [{ id: "x", entry: "./p.js" }],
      },
      { "p.js": prov("user") },
    )
    const { loader } = await load()
    expect(texts(loader)).toEqual(["D:user"])
    rmSync(join(USER, "plugins"), { recursive: true, force: true })
  })
})

describe("EMPTY_SYNTHETIC_HOLDER", () => {
  it("is deeply frozen", () => {
    expect(Object.isFrozen(EMPTY_SYNTHETIC_HOLDER)).toBe(true)
    expect(Object.isFrozen(EMPTY_SYNTHETIC_HOLDER.providers)).toBe(true)
    expect(Object.isFrozen(EMPTY_SYNTHETIC_HOLDER.resolver)).toBe(true)
  })

  it("rejects writes", () => {
    const h = EMPTY_SYNTHETIC_HOLDER as unknown as Record<string, unknown>
    expect(() => {
      h.providers = []
    }).toThrow()
    expect(() => (EMPTY_SYNTHETIC_HOLDER.providers as unknown[]).push(1)).toThrow()
    expect(() => {
      ;(EMPTY_SYNTHETIC_HOLDER.resolver as unknown as Record<string, unknown>).resolve = () => "x"
    }).toThrow()
  })

  it('returns "" for every kind (no provider)', () => {
    expect(EMPTY_SYNTHETIC_HOLDER.resolver.resolve("tool_result.handler_error", {})).toBe("")
  })

  it("an embedded package loads its provider through the module thunk", async () => {
    registerEmbeddedPlugins(
      {
        buildId: "t-st",
        packages: {
          "ma-x-plugin": {
            texts: {},
            modules: {
              "p.ts": async () => ({
                default: () => ({ kinds: ["tool_result.handler_error"], text: () => "EMB" }),
              }),
            },
            files: {},
          },
        },
      },
      { cacheRoot: join(ROOT, "no-cache") },
    )
    try {
      const dir = embeddedPluginPackages()[0]?.dir ?? ""
      const manifest = { id: "st-emb", syntheticText: [{ id: "x", entry: "./p.ts" }] }
      const events: LogEvent[] = []
      const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
      const got = await collectSyntheticTextProviders(
        [{ packageDir: dir, manifest } as unknown as LoadedPlugin],
        diagnostics,
      )
      expect(failed(events)).toHaveLength(0)
      expect(got.map((p) => p.text("tool_result.handler_error", {}))).toEqual(["EMB"])
    } finally {
      clearEmbeddedPlugins()
    }
  })
})

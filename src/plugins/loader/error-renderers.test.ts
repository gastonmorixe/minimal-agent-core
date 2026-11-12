import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { createErrorRendererRegistry } from "../../errors/index.ts"
import { writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"

const ROOT = resolve(__dirname, "../../../tmp/loader-error-renderer-tests")
const EMBEDDED = join(ROOT, "embedded")
const USER = join(ROOT, "user")
const NO_PROJECT = join(ROOT, "nope-project")
const ERR = { kind: "Boom", fields: { a: 1 } }

const FACTORY = `export function make() { return { kinds: "*", render: (e) => "R:" + e.kind } }
export default function () { return { kinds: ["Boom"], render: (e) => "D:" + e.kind } }`

const SIDE = `globalThis.__erOutside = true
export default () => ({ kinds: "*", render: () => "OUT" })`

function pkg(id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  writePackage(EMBEDDED, id, { id, name: id, version: "0.1.0", description: "t", ...extra }, files)
}

async function load(opts: { registry?: boolean; disabled?: string[] } = {}) {
  const events: LogEvent[] = []
  const logs: string[] = []
  const registry = opts.registry === false ? undefined : createErrorRendererRegistry()
  await PluginLoader.load({
    embeddedDir: EMBEDDED,
    userDir: USER,
    roots: { project: [NO_PROJECT] },
    diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }),
    logger: (m) => logs.push(m),
    disabledPluginIds: new Set(opts.disabled ?? []),
    ...(registry ? { errorRendererRegistry: registry } : {}),
  })
  return { registry, events, logs }
}

const failed = (events: LogEvent[]) =>
  events.filter((e) => e.source === "error_renderer.load_failed")

describe("manifest errorRenderers wiring", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
    mkdirSync(USER, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("registers the default export and no warning for an errorRenderers-only plugin", async () => {
    pkg("er-a", { errorRenderers: [{ id: "x", entry: "./r.js" }] }, { "r.js": FACTORY })
    const { registry, events, logs } = await load()
    expect(registry?.render(ERR)).toBe("D:Boom")
    expect(failed(events)).toHaveLength(0)
    const all = [...logs, ...events.map((e) => e.message)]
    expect(all.filter((l) => l.includes("declares no contributions"))).toHaveLength(0)
  })

  it("picks a named export", async () => {
    pkg(
      "er-b",
      { errorRenderers: [{ id: "x", entry: "./r.js", export: "make" }] },
      { "r.js": FACTORY },
    )
    expect((await load()).registry?.render(ERR)).toBe("R:Boom")
  })

  it("reports a missing module and keeps booting", async () => {
    pkg("er-c", { errorRenderers: [{ id: "x", entry: "./nope.js" }] })
    const { registry, events } = await load()
    expect(registry?.render(ERR)).toBeUndefined()
    const f = failed(events)
    expect(f).toHaveLength(1)
    expect(f[0]?.message).toBe("")
    expect(f[0]?.structuredData).toEqual({ pluginId: "er-c", id: "x" })
  })

  it("reports a throwing factory", async () => {
    pkg(
      "er-d",
      { errorRenderers: [{ id: "x", entry: "./r.js" }] },
      { "r.js": "export default () => { throw new Error('no') }" },
    )
    expect(failed((await load()).events)).toHaveLength(1)
  })

  it("reports a junk factory result", async () => {
    pkg(
      "er-e",
      { errorRenderers: [{ id: "x", entry: "./r.js" }] },
      { "r.js": "export default () => ({ kinds: '*' })" },
    )
    expect(failed((await load()).events)).toHaveLength(1)
  })

  it("refuses the host owner id", async () => {
    pkg("host", { errorRenderers: [{ id: "x", entry: "./r.js" }] }, { "r.js": FACTORY })
    const { registry, events } = await load()
    expect(registry?.render(ERR)).toBeUndefined()
    const refused = events.filter((e) => e.source === "error_renderer.owner_reserved")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.structuredData).toEqual({ pluginId: "host" })
  })

  it("does nothing without a registry", async () => {
    pkg("er-f", { errorRenderers: [{ id: "x", entry: "./nope.js" }] })
    const { events } = await load({ registry: false })
    expect(failed(events)).toHaveLength(0)
  })

  it("does not register a disabled plugin", async () => {
    pkg("er-g", { errorRenderers: [{ id: "x", entry: "./r.js" }] }, { "r.js": FACTORY })
    const { registry } = await load({ disabled: ["er-g"] })
    expect(registry?.render(ERR)).toBeUndefined()
  })

  it("rejects a ../ entry that escapes the package dir", async () => {
    const g = globalThis as Record<string, unknown>
    delete g.__erOutside
    mkdirSync(join(EMBEDDED, "plugins"), { recursive: true })
    writeFileSync(join(EMBEDDED, "plugins", "outside.js"), SIDE)
    pkg("er-h", { errorRenderers: [{ id: "x", entry: "../outside.js" }] })
    const { registry, events } = await load()
    expect(g.__erOutside).toBeUndefined()
    expect(registry?.render(ERR)).toBeUndefined()
    const f = failed(events)
    expect(f).toHaveLength(1)
    expect(f[0]?.message).toBe("")
    expect(f[0]?.structuredData).toEqual({ pluginId: "er-h", id: "x" })
  })

  it("rejects an absolute entry outside the package dir", async () => {
    const g = globalThis as Record<string, unknown>
    delete g.__erOutside
    const abs = join(ROOT, "abs-outside.js")
    writeFileSync(abs, SIDE)
    pkg("er-i", { errorRenderers: [{ id: "x", entry: abs }] })
    const { events } = await load()
    expect(g.__erOutside).toBeUndefined()
    expect(failed(events)).toHaveLength(1)
  })

  it("accepts a nested entry inside the package dir", async () => {
    pkg("er-j", { errorRenderers: [{ id: "x", entry: "./sub/mod.js" }] }, { "sub/mod.js": FACTORY })
    expect((await load()).registry?.render(ERR)).toBe("D:Boom")
  })

  it("fails once and leaks no rejection for an async factory", async () => {
    const seen: unknown[] = []
    const h = (r: unknown) => seen.push(r)
    process.on("unhandledRejection", h)
    pkg(
      "er-k",
      { errorRenderers: [{ id: "x", entry: "./r.js" }] },
      { "r.js": "export default () => Promise.reject(new Error('x'))" },
    )
    const { events } = await load()
    await new Promise((r) => setTimeout(r, 20))
    process.off("unhandledRejection", h)
    expect(failed(events)).toHaveLength(1)
    expect(seen).toHaveLength(0)
  })
})

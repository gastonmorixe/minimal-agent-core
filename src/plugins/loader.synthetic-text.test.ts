import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { pluginHandlerErrorResult } from "./loader/PROMPTS.ts"
import { CORE_TOOLS, ROOT, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const BOOM = `export default async function handler() { throw new Error("boom") }`
const provider = (text: string, kind = "tool_result.handler_error") =>
  `globalThis.__stFacts = []
export default () => ({ kinds: ["${kind}"], text: (k, f) => { globalThis.__stFacts.push(f); return ${JSON.stringify(text)} } })`

const BASE = join(ROOT, "synthetic-text-loader")
const NO_PROJECT = join(ROOT, "nope-project")

function dir(name: string) {
  const d = join(BASE, name)
  mkdirSync(d, { recursive: true })
  return d
}
function tool(d: string, id: string, name: string) {
  writePackage(d, id, toolManifest(id, name, "./h.ts"), { "h.ts": BOOM })
}
function prov(d: string, id: string, text: string) {
  writePackage(
    d,
    id,
    {
      id,
      name: id,
      version: "0.1.0",
      description: "t",
      syntheticText: [{ id: "p", entry: "./p.js" }],
    },
    { "p.js": provider(text) },
  )
}
async function load(d: string, events: LogEvent[] = []) {
  return PluginLoader.load({
    userDir: d,
    roots: { project: [NO_PROJECT] },
    coreToolNames: CORE_TOOLS,
    diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }),
    logger: () => {},
  })
}
async function boom(l: PluginLoader, name: string) {
  const r = await l.dispatch({ type: "tool", name, input: {}, tool_use_id: "t1" }, process.cwd())
  if (r.kind !== "tool_result") throw new Error("wrong kind")
  return r.content
}

describe("PluginLoader synthetic text", () => {
  beforeAll(() => mkdirSync(BASE, { recursive: true }))
  afterAll(() => rmSync(BASE, { recursive: true, force: true }))

  it("keeps the handler error bytes without a provider", async () => {
    const d = dir("none")
    tool(d, "t-none", "boom_none")
    const l = await load(d)
    const out = await boom(l, "boom_none")
    expect(out).toBe(pluginHandlerErrorResult("boom"))
    expect(out).toBe("Handler error: boom")
    expect(l.syntheticTextProviders()).toHaveLength(0)
  })

  it("uses the provider text and passes {detail}", async () => {
    const d = dir("one")
    tool(d, "t-one", "boom_one")
    prov(d, "p-one", "PROVIDED")
    const g = globalThis as Record<string, unknown>
    const l = await load(d)
    expect(await boom(l, "boom_one")).toBe("PROVIDED")
    expect(g.__stFacts).toEqual([{ detail: "boom" }])
  })

  it("keeps two loaders apart", async () => {
    const a = dir("two-a")
    const b = dir("two-b")
    tool(a, "t-a", "boom_a")
    prov(a, "p-a", "TEXT-A")
    tool(b, "t-b", "boom_b")
    prov(b, "p-b", "TEXT-B")
    const la = await load(a)
    const lb = await load(b)
    expect(await boom(la, "boom_a")).toBe("TEXT-A")
    expect(await boom(lb, "boom_b")).toBe("TEXT-B")
    expect(la.syntheticTextProviders()).toHaveLength(1)
    expect(lb.syntheticTextProviders()).toHaveLength(1)
    expect(la.syntheticTextProviders()[0]).not.toBe(lb.syntheticTextProviders()[0])
  })

  it("records one duplicate_owner and the first provider wins", async () => {
    const d = dir("dup")
    tool(d, "t-dup", "boom_dup")
    prov(d, "p-dup-1", "FIRST")
    prov(d, "p-dup-2", "SECOND")
    const events: LogEvent[] = []
    const l = await load(d, events)
    expect(events.filter((e) => e.source === "synthetic.duplicate_owner")).toHaveLength(1)
    expect(await boom(l, "boom_dup")).toBe(
      l.syntheticTextProviders()[0]?.text("tool_result.handler_error", {}),
    )
  })

  it("falls back on an empty answer and records empty_text once", async () => {
    const d = dir("empty")
    tool(d, "t-empty", "boom_empty")
    prov(d, "p-empty", "")
    const events: LogEvent[] = []
    const l = await load(d, events)
    expect(await boom(l, "boom_empty")).toBe("Handler error: boom")
    expect(events.filter((e) => e.source === "synthetic.empty_text")).toHaveLength(1)
  })
})

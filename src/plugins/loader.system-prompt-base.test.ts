import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import { collectSystemPromptParts, resolveBaseIdentity } from "./system-prompt-base.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-system-prompt-base-tests")
const EMBEDDED = join(ROOT, "embedded")
const NO_PROJECT = join(ROOT, "nope-project")

const base = (id: string) => ({ id, name: id, version: "0.1.0", description: "test" })
const tool = (name: string) => ({
  tuis: [
    {
      id: "only",
      trigger: {
        type: "tool",
        tool: { name, description: "d", input_schema: { type: "object", properties: {} } },
      },
      handler: { type: "module", path: "./h.ts" },
      interactive: false,
    },
  ],
})
const HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" })\n`
const TPL = `export default () => ({ render: (r) => "R:" + r.name, expand: (t) => "E:" + t })\n`
const spb = (text: string) =>
  `export default () => ({ identity: () => "id-${text}", instructionParts: () => [{ slot: "instructions", text: "${text}" }] })\n`
const SPB = { systemPromptBase: { id: "spb", entry: "./spb.ts" } }

function pkg(id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  writePackage(EMBEDDED, id, { ...base(id), ...extra }, { "h.ts": HANDLER, ...files })
}

async function load() {
  const events: LogEvent[] = []
  const messages: string[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  const loader = await PluginLoader.load({
    embeddedDir: EMBEDDED,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
    logger: (m) => messages.push(m),
  })
  return { loader, events, messages }
}

const conflicts = (events: LogEvent[]) =>
  events.filter((e) => e.source === "prompt.system_base_slot_conflict")

describe("S5.1b systemPromptBase manifest key", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("registers a declared provider in the loader holder", async () => {
    pkg("aaa-base", { ...tool("AaaTool"), ...SPB }, { "spb.ts": spb("hello") })
    const { loader, events } = await load()
    const holder = loader.systemPromptBase()
    expect(holder.entries).toHaveLength(1)
    expect(collectSystemPromptParts(holder).get("instructions")).toBe("hello")
    expect(resolveBaseIdentity(holder, { authKind: "k", modelId: "m" })).toBe("id-hello")
    expect(conflicts(events)).toHaveLength(0)
  })

  it("refuses the second plugin on one slot, boots, and reports one diagnostic", async () => {
    pkg("aaa-first", { ...tool("AaaTool"), ...SPB }, { "spb.ts": spb("one") })
    pkg("bbb-second", { ...tool("BbbTool"), ...SPB }, { "spb.ts": spb("two") })
    const { loader, events } = await load()
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["aaa-first", "bbb-second"])
    const holder = loader.systemPromptBase()
    expect(holder.entries.map((e) => e.pluginId)).toEqual(["aaa-first"])
    expect(collectSystemPromptParts(holder).get("instructions")).toBe("one")
    const c = conflicts(events)
    expect(c).toHaveLength(1)
    expect(c[0]?.message).toBe("")
    expect(c[0]?.structuredData).toMatchObject({
      slot: "instructions",
      owner: "aaa-first",
      refused: "bbb-second",
    })
  })

  it("an empty holder and no diagnostic when no plugin declares the key", async () => {
    pkg("aaa-plain", tool("AaaTool"))
    const { loader, events } = await load()
    expect(loader.systemPromptBase().entries).toHaveLength(0)
    expect(events.filter((e) => e.source.startsWith("prompt.system_base"))).toHaveLength(0)
  })

  it("a plugin with only systemPromptBase does not warn about no contributions", async () => {
    pkg("only-base", SPB, { "spb.ts": spb("x") })
    const { messages, loader } = await load()
    expect(messages.some((m) => m.includes("declares no contributions"))).toBe(false)
    expect(loader.systemPromptBase().entries).toHaveLength(1)
  })

  it("keeps the boot order codec, template, rest", async () => {
    pkg("aaa-plain", tool("AaaTool"))
    pkg(
      "bbb-template",
      { ...tool("BbbTool"), promptTemplate: { id: "t", entry: "./tpl.ts" } },
      { "tpl.ts": TPL },
    )
    pkg("ccc-base", { ...tool("CccTool"), ...SPB }, { "spb.ts": spb("c") })
    pkg("zzz-codec", { ...tool("ZzzTool"), sidebandCodec: { id: "c", entry: "./codec.ts" } })
    const { loader } = await load()
    expect(loader.loadedPackages().map((p) => p.id)).toEqual([
      "zzz-codec",
      "bbb-template",
      "aaa-plain",
      "ccc-base",
    ])
  })
})

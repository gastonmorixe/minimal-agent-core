import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-prompts-order-tests")
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
const PROVIDER = `export default () => ({ render: (r) => "R:" + r.pluginId + ":" + r.name, expand: (t) => "E:" + t })\n`

function pkg(id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  writePackage(EMBEDDED, id, { ...base(id), ...extra }, { "h.ts": HANDLER, ...files })
}

async function load() {
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  const loader = await PluginLoader.load({
    embeddedDir: EMBEDDED,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
  })
  return { loader, events }
}

const missing = (events: LogEvent[]) =>
  events.filter((e) => e.source === "prompt.no_template_provider")

describe("S10.1 boot order and prompts.template slot", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("orders codec first, template second, the rest keep order (C52)", async () => {
    pkg("aaa-plain", tool("AaaTool"))
    pkg(
      "bbb-template",
      { ...tool("BbbTool"), promptTemplate: { id: "t", entry: "./provider.ts" } },
      { "provider.ts": PROVIDER },
    )
    pkg("ccc-plain", tool("CccTool"))
    pkg("zzz-codec", {
      ...tool("ZzzTool"),
      sidebandCodec: { id: "c", entry: "./codec.ts" },
    })
    const { loader } = await load()
    expect(loader.loadedPackages().map((p) => p.id)).toEqual([
      "zzz-codec",
      "bbb-template",
      "aaa-plain",
      "ccc-plain",
    ])
  })

  it("a missing provider records exactly one prompt.no_template_provider and boots", async () => {
    pkg("aaa-plain", tool("AaaTool"))
    const { loader, events } = await load()
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["aaa-plain"])
    const m = missing(events)
    expect(m).toHaveLength(1)
    expect(m[0]?.message).toBe("")
  })

  it("a loaded provider gives no diagnostic and ctx.prompts works in a tool", async () => {
    pkg(
      "bbb-template",
      { ...tool("BbbTool"), promptTemplate: { id: "t", entry: "./provider.ts" } },
      { "provider.ts": PROVIDER },
    )
    pkg("aaa-user", tool("AaaTool"), {
      "h.ts": `export default async (ctx) => ({ kind: "tool_result", content: ctx.prompts.render("x.md") + "|" + ctx.prompts.expand("y") })\n`,
    })
    const { loader, events } = await load()
    expect(missing(events)).toHaveLength(0)
    const r = await loader.dispatch({ type: "tool", name: "AaaTool", input: {} } as never, ROOT)
    expect(JSON.stringify(r)).toContain("R:aaa-user:x.md|E:y")
  })
})

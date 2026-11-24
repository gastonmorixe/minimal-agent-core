/**
 * The display option of `loadSidebandOnly` and the display host of the loader
 * API. The plugin kind `fake` stands for any kind.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { createDiagnostics } from "../../diagnostics/hub.ts"
import { NO_SIDEBAND, sidebandForPlugin } from "../../sideband/api.ts"
import { CORE_TOOLS, toolManifest, writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"

import { loadSidebandOnly } from "./sideband-only.ts"

const ROOT = resolve(__dirname, "../../../tmp/sideband-only-display-tests")
const PLUGINS = join(ROOT, "plugins")
const SESSIONS = join(ROOT, "sessions")
const OLD = "0a1d0003-6666-4666-8666-666666666666"

const CODEC = `export default () => ({
  id: "fake-codec",
  render: (k, m) => "{" + k.kind + ":" + (m.attrs?.id ?? "") + "}",
  parse: (text) => [...text.matchAll(/\\{([a-z]+):([^}]*)\\}/g)].map((m) => ({
    kind: m[1], attrs: { id: m[2] }, selfClosing: true, form: "v2",
    span: { start: m.index, end: m.index + m[0].length },
  })),
  scanner: () => ({ write() {}, end() {}, onText() {}, onNode() {} }),
  neutralize: (t) => t,
  example: () => "",
})
`

const HANDLER = `globalThis.__displayImports = (globalThis.__displayImports ?? 0) + 1
export default (node, ctx) => {
  const files = ctx.host?.sessionFiles
  const text = ctx.sid && files ? files.read(ctx.sid, node.attrs.id + ".txt") : null
  return { label: "F " + node.attrs.id + (ctx.host ? " host" : ""),
    ...(text !== null && text !== undefined ? { text } : { missing: true }) }
}
`

function writePlugin(id: string, host: boolean): void {
  const dir = join(PLUGINS, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "codec.ts"), CODEC)
  writeFileSync(join(dir, "display.ts"), HANDLER)
  const manifest = {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    capabilities: ["sessions:files"],
    sidebandCodec: { id: "fake-codec", entry: "./codec.ts" },
    sideband: [
      {
        kind: "fake",
        direction: "to-model",
        placement: "inline",
        attrs: { id: { type: "string" } },
        body: "none",
        trust: "untrusted",
        summary: "s",
        display: { handler: { type: "module", path: "./display.ts" }, host },
      },
    ],
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest))
}

const g = globalThis as { __displayImports?: number }
const quiet = () => createDiagnostics({ emit: () => {} })

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  writePlugin("fake-owner", true)
  mkdirSync(join(SESSIONS, `${OLD}.files`, "fake-owner"), { recursive: true })
  writeFileSync(join(SESSIONS, `${OLD}.jsonl`), "")
  writeFileSync(join(SESSIONS, `${OLD}.files`, "fake-owner", "ab.txt"), "old body")
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe("loadSidebandOnly display option", () => {
  it("no display option imports no handler", async () => {
    g.__displayImports = 0
    const api = await loadSidebandOnly({
      roots: { embedded: [PLUGINS], project: [join(ROOT, "nope")] },
      diagnostics: quiet(),
    })
    expect(api.ready).toBe(true)
    expect(api.hasDisplay("fake")).toBe(false)
    expect(api.display("x {fake:ab}", { mode: "full", sid: OLD }).changed).toBe(false)
    expect(g.__displayImports).toBe(0)
  })

  it("display option loads handlers and builds the host", async () => {
    const api = await loadSidebandOnly({
      roots: { embedded: [PLUGINS], project: [join(ROOT, "nope")] },
      diagnostics: quiet(),
      display: { hostOptions: { sessionsDir: SESSIONS } },
    })
    expect(g.__displayImports).toBe(1)
    expect(api.hasDisplay("fake")).toBe(true)
    // The registry kind keeps no manifest data: `display` boots apart (C3).
    expect(api.kinds().map((k) => k.kind)).toContain("fake")
    for (const k of api.kinds()) expect(k).not.toHaveProperty("display")
    // The old sid is not owned: the display scope gives the read.
    const r = api.display("x {fake:ab} {fake:zz}", { mode: "full", sid: OLD })
    expect(r.changed).toBe(true)
    const nodes = r.segments.flatMap((s) => (s.type === "node" ? [s.display] : []))
    expect(nodes).toEqual([
      { label: "F ab host", text: "old body" },
      { label: "F zz host", missing: true },
    ])
  })
})

describe("loader API display host", () => {
  it("display handler gets the owner host only with host:true", async () => {
    rmSync(PLUGINS, { recursive: true, force: true })
    writePlugin("fake-nohost", false)
    const noHost = await PluginLoader.load({
      roots: { embedded: [PLUGINS], project: [join(ROOT, "nope")] },
      diagnostics: quiet(),
      hostOptions: { sessionsDir: SESSIONS },
    } as never)
    const n = noHost.sideband().find("{fake:ab}")[0]
    expect(n).toBeDefined()
    expect(noHost.sideband().displayNode(n as never, { mode: "full", sid: OLD })).toEqual({
      label: "F ab",
      missing: true,
    })

    rmSync(PLUGINS, { recursive: true, force: true })
    writePlugin("fake-owner", true)
    const withHost = await PluginLoader.load({
      roots: { embedded: [PLUGINS], project: [join(ROOT, "nope")] },
      diagnostics: quiet(),
      hostOptions: { sessionsDir: SESSIONS },
    } as never)
    expect(withHost.sideband().hasDisplay("fake")).toBe(true)
    const m = withHost.sideband().find("{fake:ab}")[0]
    expect(withHost.sideband().displayNode(m as never, { mode: "full", sid: OLD })).toEqual({
      label: "F ab host",
      text: "old body",
    })
  })
})

/** A tool plugin whose handler calls `ctx.sideband.display` for the old sid. */
function writeCaller(id: string, tool: string, capabilities: string[]): void {
  writePackage(
    ROOT,
    id,
    { ...toolManifest(id, tool, "./tool.ts"), capabilities },
    {
      "tool.ts": `export default async function handler(ctx) {
  const r = ctx.sideband.display("{fake:ab}", { mode: "full", sid: ${JSON.stringify(OLD)} })
  return JSON.stringify(r.segments.flatMap((s) => (s.type === "node" ? [s.display] : [])))
}`,
    },
  )
}

describe("F3: the display read scope of a plugin needs sessions:read", () => {
  let loader: PluginLoader

  beforeAll(async () => {
    rmSync(PLUGINS, { recursive: true, force: true })
    writePlugin("fake-owner", true)
    writeCaller("caller-none", "CallNone", [])
    writeCaller("caller-files", "CallFiles", ["sessions:files"])
    writeCaller("caller-read", "CallRead", ["sessions:read"])
    loader = await PluginLoader.load({
      roots: { embedded: [PLUGINS], project: [join(ROOT, "nope")] },
      coreToolNames: CORE_TOOLS,
      diagnostics: quiet(),
      logger: () => {},
      hostOptions: { sessionsDir: SESSIONS },
    } as never)
  })

  const call = async (name: string): Promise<unknown> => {
    const r = await loader.dispatch(
      { type: "tool", name, input: {}, tool_use_id: name },
      process.cwd(),
    )
    // A handler that gives a string gives the dispatch result as is.
    return JSON.parse(String(r))
  }

  it("a plugin with no sessions:read gets missing for an old sid", async () => {
    expect(await call("CallNone")).toEqual([{ label: "F ab host", missing: true }])
    expect(await call("CallFiles")).toEqual([{ label: "F ab host", missing: true }])
  })

  it("a plugin with sessions:read gets the text", async () => {
    expect(await call("CallRead")).toEqual([{ label: "F ab host", text: "old body" }])
  })

  it("the host loader API gets the text", () => {
    const n = loader.sideband().find("{fake:ab}")[0]
    expect(loader.sideband().displayNode(n as never, { mode: "full", sid: OLD })).toEqual({
      label: "F ab host",
      text: "old body",
    })
  })

  it("a turn attachment factory gets the plugin view: missing for an old sid", async () => {
    const {
      clearTurnAttachmentFactories,
      instantiateTurnAttachments,
      registerTurnAttachmentFactory,
    } = await import("../../agent/turn-attachments.ts")
    let got: unknown
    registerTurnAttachmentFactory("test/f3", (ctx) => {
      const sb = ctx.sideband!
      const n = sb.find("{fake:ab}")[0]
      got = sb.displayNode(n as never, { mode: "full", sid: OLD })
      return null
    })
    try {
      await instantiateTurnAttachments({ sessionId: null, sideband: loader.sideband() })
    } finally {
      clearTurnAttachmentFactories()
    }
    expect(got).toEqual({ label: "F ab host", missing: true })
  })

  it("compaction gives the provider adapter the plugin view", async () => {
    // `compactSideband` is module-private: the same call as its body.
    const view = sidebandForPlugin(loader.sideband(), undefined)
    const n = view.find("{fake:ab}")[0]
    expect(view.displayNode(n as never, { mode: "full", sid: OLD })).toEqual({
      label: "F ab host",
      missing: true,
    })
    const src = await Bun.file(resolve(__dirname, "../../agent/run-compact.ts")).text()
    expect(src).toContain("return sidebandForPlugin(input.sideband ?? NO_SIDEBAND, undefined)")
  })

  it("sidebandForPlugin keeps the API for sessions:read and the API with no display", () => {
    const api = loader.sideband()
    expect(sidebandForPlugin(api, ["sessions:read"])).toBe(api)
    const view = sidebandForPlugin(api, [])
    expect(view).not.toBe(api)
    expect(sidebandForPlugin(api, undefined)).toBe(view)
    expect(view.ready).toBe(api.ready)
    expect(view.hasDisplay("fake")).toBe(true)
    expect(sidebandForPlugin(NO_SIDEBAND, [])).toBe(NO_SIDEBAND)
  })
})

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"
import type { ManifestFile } from "../types.ts"

import { withDerivedProvides } from "./discovery.ts"
import { sameNames } from "./synthetic-text.ts"

const ROOT = resolve(__dirname, "../../../tmp/loader-tool-text-tests")
const EMBEDDED = join(ROOT, "embedded")
const USER = join(ROOT, "user")
const NO_PROJECT = join(ROOT, "nope-project")

const toolProv = (tools: string[]) =>
  `export default () => ({ tools: ${JSON.stringify(tools)}, tool: (n) => n === "Read" ? { description: "D", params: { path: "P" } } : undefined })`

const synthProv = (kinds: string[]) =>
  `export default () => ({ kinds: ${JSON.stringify(kinds)}, text: () => "T" })`

function pkg(id: string, extra: Record<string, unknown>, files: Record<string, string> = {}) {
  writePackage(EMBEDDED, id, { id, name: id, version: "0.1.0", description: "t", ...extra }, files)
}

async function load() {
  const events: LogEvent[] = []
  const loader = await PluginLoader.load({
    embeddedDir: EMBEDDED,
    userDir: USER,
    roots: { project: [NO_PROJECT] },
    diagnostics: createDiagnostics({ emit: (e: LogEvent) => events.push(e) }),
    logger: () => {},
  })
  return { loader, events }
}

const bySource = (events: LogEvent[], source: string) => events.filter((e) => e.source === source)

describe("manifest toolText wiring", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
    mkdirSync(USER, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("loads a provider whose tools equal the manifest list", async () => {
    pkg(
      "tt-a",
      { toolText: [{ id: "t", entry: "./p.js", tools: ["Read", "Bash"] }] },
      { "p.js": toolProv(["Bash", "Read"]) },
    )
    const { loader, events } = await load()
    const [p] = loader.toolTextProviders()
    expect(loader.toolTextProviders()).toHaveLength(1)
    expect(p?.tool("Read")).toEqual({ description: "D", params: { path: "P" } })
    expect(bySource(events, "tool_text.tools_mismatch")).toHaveLength(0)
    expect(bySource(events, "tool_text.load_failed")).toHaveLength(0)
  })

  it("keeps a provider whose tools differ, with a mismatch diagnostic", async () => {
    pkg(
      "tt-b",
      { toolText: [{ id: "t", entry: "./p.js", tools: ["Read"] }] },
      { "p.js": toolProv(["Read", "Bash"]) },
    )
    const { loader, events } = await load()
    expect(loader.toolTextProviders()).toHaveLength(1)
    expect(bySource(events, "tool_text.tools_mismatch")).toHaveLength(1)
  })

  it("reports a missing module and junk as load_failed", async () => {
    pkg("tt-c", { toolText: [{ id: "t", entry: "./nope.js", tools: ["Read"] }] })
    pkg(
      "tt-d",
      { toolText: [{ id: "t", entry: "./p.js", tools: ["Read"] }] },
      { "p.js": "export default () => ({ tools: 'Read' })" },
    )
    const { loader, events } = await load()
    expect(loader.toolTextProviders()).toHaveLength(0)
    expect(bySource(events, "tool_text.load_failed")).toHaveLength(2)
  })

  it("has no providers without toolText", async () => {
    const { loader } = await load()
    expect(loader.toolTextProviders()).toEqual([])
  })

  it("warns synthetic.kinds_mismatch when manifest kinds differ", async () => {
    pkg(
      "sk-a",
      { syntheticText: [{ id: "s", entry: "./p.js", kinds: ["continue.max_tokens"] }] },
      { "p.js": synthProv(["continue.max_tokens", "assistant.placeholder"]) },
    )
    const { loader, events } = await load()
    expect(bySource(events, "synthetic.kinds_mismatch")).toHaveLength(1)
    // Additive in P1: the provider still loads.
    expect(loader.syntheticTextProviders()).toHaveLength(1)
  })

  it("is quiet when manifest kinds match or are absent", async () => {
    pkg(
      "sk-b",
      { syntheticText: [{ id: "s", entry: "./p.js", kinds: ["assistant.placeholder"] }] },
      { "p.js": synthProv(["assistant.placeholder"]) },
    )
    pkg(
      "sk-c",
      { syntheticText: [{ id: "s", entry: "./p.js" }] },
      { "p.js": synthProv(["continue.max_tokens"]) },
    )
    const { loader, events } = await load()
    expect(bySource(events, "synthetic.kinds_mismatch")).toHaveLength(0)
    expect(loader.syntheticTextProviders()).toHaveLength(2)
  })

  it("derives provides in discovery: a duplicate synthetic kind is a contract duplicate", async () => {
    pkg(
      "dp-a",
      {
        required: true,
        syntheticText: [{ id: "s", entry: "./p.js", kinds: ["assistant.placeholder"] }],
      },
      { "p.js": synthProv(["assistant.placeholder"]) },
    )
    pkg(
      "dp-b",
      { syntheticText: [{ id: "s", entry: "./p.js", kinds: ["assistant.placeholder"] }] },
      { "p.js": synthProv(["assistant.placeholder"]) },
    )
    const { events } = await load()
    const dup = bySource(events, "boot.contract_duplicate")
    expect(dup).toHaveLength(1)
    expect(JSON.stringify(dup[0])).toContain("synthetic:assistant.placeholder")
  })
})

describe("withDerivedProvides", () => {
  const base = { id: "p", name: "p", version: "0", description: "d" } as unknown as ManifestFile

  it("returns the same object when nothing is derived", () => {
    expect(withDerivedProvides(base)).toBe(base)
    const st = { ...base, syntheticText: [{ id: "s", entry: "./s.ts" }] } as ManifestFile
    expect(withDerivedProvides(st)).toBe(st)
  })

  it("adds synthetic:<kind> and text.tools after the declared provides, no duplicates", () => {
    const m = {
      ...base,
      provides: ["x", "synthetic:continue.max_tokens"],
      syntheticText: [
        { id: "a", entry: "./a.ts", kinds: ["continue.max_tokens", "assistant.placeholder"] },
      ],
      toolText: [{ id: "t", entry: "./t.ts", tools: ["Read"] }],
    } as ManifestFile
    expect(withDerivedProvides(m).provides).toEqual([
      "x",
      "synthetic:continue.max_tokens",
      "synthetic:assistant.placeholder",
      "text.tools",
    ])
  })
})

describe("sameNames", () => {
  it("ignores order and checks the set", () => {
    expect(sameNames(["a", "b"], ["b", "a"])).toBe(true)
    expect(sameNames(["a"], ["a", "b"])).toBe(false)
    expect(sameNames(["a", "c"], ["a", "b"])).toBe(false)
    expect(sameNames([], [])).toBe(true)
  })
})

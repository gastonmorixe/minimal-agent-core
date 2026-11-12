import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import { loadPromptTemplateProvider, type PromptProviderHolder } from "./prompts-context.ts"

const ROOT = resolve(__dirname, "../../tmp/prompts-context-failure-tests")
const EMBEDDED = join(ROOT, "embedded")
const NO_PROJECT = join(ROOT, "nope-project")
const PKG = join(ROOT, "pkg")

const DECL = (entry: string) => ({ id: "t", entry })

async function run(entry: string) {
  const holder: PromptProviderHolder = { current: undefined }
  const logs: string[] = []
  await loadPromptTemplateProvider(DECL(entry), PKG, holder, (m) => logs.push(m))
  return { holder, logs }
}

describe("loadPromptTemplateProvider failure paths", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(PKG, { recursive: true })
    writeFileSync(join(PKG, "str.ts"), `export default "not a provider"\n`)
    writeFileSync(join(PKG, "partial.ts"), `export default { render: () => "x" }\n`)
    writeFileSync(
      join(PKG, "plain.ts"),
      `export default { render: () => "r", expand: (t) => "e" + t }\n`,
    )
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("a missing entry file does not throw and leaves no provider", async () => {
    const { holder, logs } = await run("./absent.ts")
    expect(holder.current).toBeUndefined()
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain("module not found")
  })

  it("a string default export gives no provider", async () => {
    const { holder, logs } = await run("./str.ts")
    expect(holder.current).toBeUndefined()
    expect(logs[0]).toContain("no provider export")
  })

  it("an object with no expand gives no provider", async () => {
    const { holder, logs } = await run("./partial.ts")
    expect(holder.current).toBeUndefined()
    expect(logs[0]).toContain("no provider export")
  })

  it("a plain object with render and expand is accepted", async () => {
    const { holder, logs } = await run("./plain.ts")
    expect(logs).toHaveLength(0)
    expect(holder.current?.expand("a")).toBe("ea")
  })
})

describe("boot with a template plugin whose entry fails to import", () => {
  it("emits prompt.no_template_provider exactly once and boots", async () => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
    writePackage(
      EMBEDDED,
      "bad-template",
      {
        id: "bad-template",
        name: "bad-template",
        version: "0.1.0",
        description: "test",
        promptTemplate: { id: "t", entry: "./provider.ts" },
      },
      { "provider.ts": `export default (\n` },
    )
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      roots: { project: [NO_PROJECT] },
      diagnostics,
      disabledPluginIds: new Set(),
    })
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["bad-template"])
    expect(events.filter((e) => e.source === "prompt.no_template_provider")).toHaveLength(1)
    rmSync(ROOT, { recursive: true, force: true })
  })
})

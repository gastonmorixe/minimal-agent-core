import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-prompts-diag-level-tests")
const EMBEDDED = join(ROOT, "embedded")
const NO_PROJECT = join(ROOT, "nope-project")

const HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" })\n`

async function loadWithoutProvider() {
  writePackage(
    EMBEDDED,
    "aaa-plain",
    {
      id: "aaa-plain",
      name: "aaa-plain",
      version: "0.1.0",
      description: "test",
      tuis: [
        {
          id: "only",
          trigger: {
            type: "tool",
            tool: {
              name: "AaaTool",
              description: "d",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "module", path: "./h.ts" },
          interactive: false,
        },
      ],
    },
    { "h.ts": HANDLER },
  )
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  await PluginLoader.load({
    embeddedDir: EMBEDDED,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
  })
  return events
}

// Syslog order: a LOWER number is MORE severe. Warning is 4, Info is 6.
describe("S10.1 prompt.no_template_provider level", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("emits it once, below Warning, so the CLI hides it (C52)", async () => {
    const events = await loadWithoutProvider()
    const hits = events.filter((e) => e.source === "prompt.no_template_provider")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.severity).toBeGreaterThan(Severity.Warning)
  })

  it("no Warning-or-worse event has an empty message and empty data", async () => {
    const events = await loadWithoutProvider()
    const blank = events.filter(
      (e) =>
        e.severity <= Severity.Warning &&
        e.message === "" &&
        Object.keys(e.structuredData ?? {}).length === 0,
    )
    expect(blank).toEqual([])
  })
})

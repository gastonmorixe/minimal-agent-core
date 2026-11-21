import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

/**
 * The attribute keys of the systemPromptBase diagnostics are a contract:
 * the CLI renderer reads these exact names. A rename or an added key must
 * change this test and the renderer test in the same change.
 */

const ROOT = resolve(__dirname, "../../tmp/loader-system-prompt-base-attrs-tests")
const EMBEDDED = join(ROOT, "embedded")
const NO_PROJECT = join(ROOT, "nope-project")

const base = (id: string) => ({ id, name: id, version: "0.1.0", description: "test" })
const HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" })\n`
const tuis = (name: string) => [
  {
    id: "only",
    trigger: {
      type: "tool",
      tool: { name, description: "d", input_schema: { type: "object", properties: {} } },
    },
    handler: { type: "module", path: "./h.ts" },
    interactive: false,
  },
]
const provider = (text: string) =>
  `export default () => ({ instructionParts: () => [{ slot: "instructions", text: "${text}" }] })\n`
const SPB = { systemPromptBase: { id: "spb", entry: "./spb.ts" } }

function pkg(id: string, tool: string, files: Record<string, string> = {}) {
  writePackage(
    EMBEDDED,
    id,
    { ...base(id), tuis: tuis(tool), ...SPB },
    { "h.ts": HANDLER, ...files },
  )
}

async function boot() {
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  await PluginLoader.load({
    embeddedDir: EMBEDDED,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
    logger: () => {},
  })
  return events
}

const bySource = (events: LogEvent[], source: string) => events.filter((e) => e.source === source)
const keys = (e: LogEvent | undefined) => Object.keys(e?.structuredData ?? {}).sort()

describe("systemPromptBase diagnostic attribute keys", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })
  afterEach(() => rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("prompt.system_base_slot_conflict has exactly slot, owner, refused and an empty message", async () => {
    pkg("aaa-first", "AaaTool", { "spb.ts": provider("one") })
    pkg("bbb-second", "BbbTool", { "spb.ts": provider("two") })
    const hits = bySource(await boot(), "prompt.system_base_slot_conflict")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toBe("")
    expect(keys(hits[0])).toEqual(["owner", "refused", "slot"])
    expect(hits[0]?.structuredData).toEqual({
      slot: "instructions",
      owner: "aaa-first",
      refused: "bbb-second",
    })
  })

  it("prompt.system_base_load_failed has exactly code, packageDir, abs, reason and an empty message (module_not_found)", async () => {
    pkg("aaa-missing", "AaaTool")
    const hits = bySource(await boot(), "prompt.system_base_load_failed")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toBe("")
    expect(keys(hits[0])).toEqual(["abs", "code", "packageDir", "reason"])
    expect(hits[0]?.structuredData?.code).toBe("module_not_found")
    expect(hits[0]?.structuredData?.reason).toBe("")
  })

  it("prompt.system_base_load_failed has the same four keys for no_provider_export", async () => {
    pkg("aaa-bad", "AaaTool", { "spb.ts": `export default "not a provider"\n` })
    const hits = bySource(await boot(), "prompt.system_base_load_failed")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toBe("")
    expect(keys(hits[0])).toEqual(["abs", "code", "packageDir", "reason"])
    expect(hits[0]?.structuredData?.code).toBe("no_provider_export")
  })

  it("prompt.system_base_load_failed has the same four keys for load_failed and holds the error name only", async () => {
    pkg("aaa-throws", "AaaTool", { "spb.ts": `throw new TypeError("secret detail text")\n` })
    const hits = bySource(await boot(), "prompt.system_base_load_failed")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toBe("")
    expect(keys(hits[0])).toEqual(["abs", "code", "packageDir", "reason"])
    expect(hits[0]?.structuredData?.code).toBe("load_failed")
    expect(hits[0]?.structuredData?.reason).toBe("TypeError")
    expect(JSON.stringify(hits[0]?.structuredData)).not.toContain("secret detail text")
  })

  it("prompt.system_base_data_invalid names the plugin, the bad field and the first bad slot", async () => {
    writePackage(
      EMBEDDED,
      "aaa-old-slot",
      {
        ...base("aaa-old-slot"),
        tuis: tuis("AaaTool"),
        systemPromptBase: {
          id: "spb",
          entry: "./spb.ts",
          slots: ["instructions", "toolOutputConventions"],
        },
      },
      { "h.ts": HANDLER, "spb.ts": provider("one") },
    )
    const hits = bySource(await boot(), "prompt.system_base_data_invalid")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.message).toBe("")
    expect(keys(hits[0])).toEqual(["field", "pluginId", "slot"])
    expect(hits[0]?.structuredData).toEqual({
      pluginId: "aaa-old-slot",
      field: "slots",
      slot: "toolOutputConventions",
    })
  })

  it("prompt.system_base_data_invalid names the field and no slot for a bad identity", async () => {
    writePackage(
      EMBEDDED,
      "aaa-bad-identity",
      {
        ...base("aaa-bad-identity"),
        tuis: tuis("AaaTool"),
        systemPromptBase: { id: "spb", entry: "./spb.ts", identity: "yes" },
      },
      { "h.ts": HANDLER, "spb.ts": provider("one") },
    )
    const hits = bySource(await boot(), "prompt.system_base_data_invalid")
    expect(hits).toHaveLength(1)
    expect(hits[0]?.structuredData).toEqual({ pluginId: "aaa-bad-identity", field: "identity" })
  })
})

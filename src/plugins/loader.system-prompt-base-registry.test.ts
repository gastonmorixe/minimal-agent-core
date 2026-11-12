import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { clearSystemPromptBase, getSystemPromptBase } from "../llm/system-prompt-base-registry.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import { collectSystemPromptParts } from "./system-prompt-base.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-system-prompt-base-registry-tests")
const EMBEDDED = join(ROOT, "embedded")
const NO_PROJECT = join(ROOT, "nope-project")

const base = (id: string) => ({ id, name: id, version: "0.1.0", description: "test" })
const HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" })\n`
const spb = (text: string) =>
  `export default () => ({ identity: () => "id-${text}", instructionParts: () => [{ slot: "instructions", text: "${text}" }] })\n`
const manifest = {
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
  systemPromptBase: { id: "spb", entry: "./spb.ts" },
}

async function load(text: string) {
  rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true })
  writePackage(
    EMBEDDED,
    `base-${text}`,
    { ...base(`base-${text}`), ...manifest },
    {
      "h.ts": HANDLER,
      "spb.ts": spb(text),
    },
  )
  const diagnostics = createDiagnostics({ emit: (_e: LogEvent) => {} })
  return PluginLoader.load({
    embeddedDir: EMBEDDED,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
    logger: () => {},
  })
}

const instructions = () => {
  const h = getSystemPromptBase()
  return h === undefined ? undefined : collectSystemPromptParts(h).get("instructions")
}

describe("loader registers the base holder", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })
  afterEach(() => clearSystemPromptBase())
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("two loads: the second holder replaces the first, a stale release does nothing", async () => {
    const one = await load("first")
    expect(getSystemPromptBase()).toBe(one.systemPromptBase())
    expect(instructions()).toBe("first")
    const two = await load("second")
    expect(getSystemPromptBase()).toBe(two.systemPromptBase())
    expect(getSystemPromptBase()).not.toBe(one.systemPromptBase())
    expect(instructions()).toBe("second")
    one.releaseSystemPromptBase()
    expect(getSystemPromptBase()).toBe(two.systemPromptBase())
    two.releaseSystemPromptBase()
    expect(getSystemPromptBase()).toBeUndefined()
  })
})

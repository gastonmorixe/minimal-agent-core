/**
 * One plugin per contribution key: each loads without the dead-weight
 * warning. An empty plugin still warns.
 *
 * @module plugins/loader/contribution-keys.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { CORE_TOOLS, writePackage } from "../loader.fixtures.ts"
import { PluginLoader } from "../loader.ts"

import { CONTRIBUTION_KEYS, type ContributionKey } from "./contribution-keys.ts"

const ROOT = resolve(import.meta.dir, "../../../tmp/contribution-keys-tests")
const HOME = join(ROOT, "home")
const HANDLER = { type: "module", path: "./h.ts", export: "default" }
const FILES = { "h.ts": "export default async function () {}" }

/** Minimal valid manifest fragment per key. Typed so a new key forces a row. */
const FRAGMENTS: Record<ContributionKey, Record<string, unknown>> = {
  tools: {
    tuis: [
      {
        id: "t",
        trigger: {
          type: "tool",
          tool: {
            name: "KeyTool",
            description: "d",
            input_schema: { type: "object", properties: {} },
          },
        },
        handler: HANDLER,
      },
    ],
  },
  modes: { modes: [{ id: "m1" }] },
  events: { events: [{ id: "e1", on: "test.event", handler: HANDLER }] },
  hooks: {
    hooks: [{ id: "k1", channel: "editor.key", handler: HANDLER }],
    permissions: ["hooks:editor.key"],
  },
  promptFragments: { promptFragments: [{ id: "f1", handler: HANDLER }] },
  commands: { commands: [{ name: "cmd", summary: "s", handler: HANDLER }] },
  hostModes: {
    hostModes: [{ id: "hm", description: "d", entry: { type: "module", path: "./h.ts" } }],
    permissions: ["hostMode:stdio"],
  },
  errorRenderers: { errorRenderers: [{ id: "er", entry: "./h.ts" }] },
  syntheticText: { syntheticText: [{ id: "st", entry: "./h.ts" }] },
  sideband: {
    sideband: [
      {
        kind: "kx",
        direction: "to-model",
        placement: "turn",
        body: "none",
        trust: "harness",
        attrs: {},
        summary: "s",
      },
    ],
  },
  sidebandCodec: { sidebandCodec: { id: "codec", entry: "./h.ts" } },
  promptTemplate: { promptTemplate: { id: "tpl", entry: "./h.ts" } },
  toolResultTransforms: { toolResultTransforms: { id: "trt", entry: "./h.ts" } },
  replayRenderers: { replayRenderers: [{ id: "rr", handler: HANDLER }] },
  turnAttachments: { turnAttachments: [{ id: "ta", handler: HANDLER }] },
  ui: { ui: {} },
}

function base(id: string): Record<string, unknown> {
  return { id, name: id, version: "0.1.0", description: "d" }
}

async function loadMessages(): Promise<string[]> {
  const messages: string[] = []
  await PluginLoader.load({
    userDir: HOME,
    roots: { project: [join(ROOT, "nope", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
    logger: (m) => messages.push(m),
  })
  return messages
}

const warned = (ms: string[]) => ms.some((m) => m.includes("declares no contributions"))

describe("contribution keys", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
  })
  afterEach(() => rmSync(join(HOME, "plugins"), { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  for (const key of CONTRIBUTION_KEYS) {
    it(`does not warn for a plugin that declares only ${key}`, async () => {
      writePackage(HOME, "only-one", { ...base("only-one"), ...FRAGMENTS[key] }, FILES)
      expect(warned(await loadMessages())).toBe(false)
    })
  }

  it("still warns for an empty plugin and lists every key", async () => {
    writePackage(HOME, "empty", base("empty"))
    const msg = (await loadMessages()).find((m) => m.includes("declares no contributions"))
    expect(msg).toBeDefined()
    for (const key of CONTRIBUTION_KEYS) expect(msg).toContain(key)
  })
})

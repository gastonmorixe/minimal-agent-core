import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { CORE_TOOLS, TOOL_HANDLER_BODY, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import type { ResolvedHandler } from "./types.ts"

const PROV_ROOT = resolve(__dirname, "../../tmp/loader-provenance-tests")
const PROV_HOME = join(PROV_ROOT, "home")
const PLUGINS = join(PROV_HOME, "plugins")

/**
 * The sessionContext text of the fixture plugin set, captured from the
 * loader BEFORE `buildBlock` moved to `loader/session-context.ts`. The move
 * must keep it byte-identical (a change costs every session a cache write).
 */
const SESSION_CONTEXT_FIXTURE = [
  '<ma::sys::behavior name="rules">',
  "First set.",
  "</ma::sys::behavior>",
  "",
  '<ma::sys::behavior name="rules-2">',
  "Second set.",
  "</ma::sys::behavior>",
  "",
  '<ma::sys::tool name="ProvToolSearch">',
  'Use Search for "a" & <b>.',
  "</ma::sys::tool>",
  "",
  '<ma::sys::context name="ambient-data">',
  "Static framing.",
  "",
  "SESSION_FRAGMENT",
  "</ma::sys::context>",
].join("\n")

/** Write the fixture plugin set: two same-slug behavior plugins, a prefixed tool, a context plugin. */
function writeFixturePlugins(): void {
  writePackage(
    PROV_HOME,
    "beh_one",
    { id: "beh_one", name: "beh_one", version: "0.1.0", description: "d" },
    { "PROMPT.md": "# Rules\n\nFirst set." },
  )
  writePackage(
    PROV_HOME,
    "beh_two",
    { id: "beh_two", name: "beh_two", version: "0.1.0", description: "d" },
    { "PROMPT.md": "# Rules\n\nSecond set.\n" },
  )
  writePackage(
    PROV_HOME,
    "prov-tool",
    {
      id: "prov-tool",
      name: "prov-tool",
      version: "0.1.0",
      description: "d",
      headless: {
        tools: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: "Search",
                description: "Search things",
                input_schema: { type: "object", properties: {} },
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
    },
    { "h.ts": TOOL_HANDLER_BODY, "PROMPT.md": 'Use Search for "a" & <b>.' },
  )
  writePackage(
    PROV_HOME,
    "ctx_frag",
    {
      id: "ctx_frag",
      name: "ctx_frag",
      version: "0.1.0",
      description: "d",
      promptFragments: [
        { id: "ambient", handler: { type: "module", path: "./s.ts", export: "default" } },
        {
          id: "first",
          order: 10,
          placement: "afterInstructions",
          handler: { type: "module", path: "./a.ts", export: "default" },
        },
        {
          id: "second",
          order: 20,
          placement: "afterInstructions",
          handler: { type: "module", path: "./b.ts", export: "default" },
        },
      ],
    },
    {
      "PROMPT.md": "# Ambient Data\n\nStatic framing.",
      "s.ts": "export default async () => 'SESSION_FRAGMENT\\n'",
      "a.ts": "export default async () => 'AI_ONE\\nline two\\n\\n'",
      "b.ts": "export default async () => 'AI_TWO'",
    },
  )
}

async function loadFixture(): Promise<PluginLoader> {
  return PluginLoader.load({
    userDir: PROV_HOME,
    roots: { project: [join(PROV_ROOT, "nope", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
  })
}

/** A dynamic tool handler, shaped like the ones a fragment producer registers. */
function dynamicHandler(name: string): ResolvedHandler {
  return {
    definition: {
      id: name,
      trigger: {
        type: "tool",
        tool: { name, description: "dynamic", input_schema: { type: "object", properties: {} } },
      },
      handler: { type: "module", path: "./dyn.ts", export: "default" },
      interactive: false,
    },
    entryAbsolute: PROV_HOME,
    invoke: async () => ({ kind: "tool_result", content: "dynamic ok" }),
  } as unknown as ResolvedHandler
}

describe("PluginLoader / prompt provenance and tool owners", () => {
  beforeAll(() => {
    rmSync(PROV_ROOT, { recursive: true, force: true })
    mkdirSync(PROV_HOME, { recursive: true })
    writeFixturePlugins()
  })
  afterAll(() => rmSync(PROV_ROOT, { recursive: true, force: true }))

  it("sessionContext text is byte-identical to the fixture captured before the move", async () => {
    const loader = await loadFixture()
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toBe(SESSION_CONTEXT_FIXTURE)
    expect(loader.getPromptBlock()).toBe(SESSION_CONTEXT_FIXTURE.replace(SESSION_FRAGMENT, ""))
  })

  it("toolOwners has a prefixed canonical name and a dynamic tool, no core tool", async () => {
    const loader = await loadFixture()
    loader.registerDynamicTools("ctx_frag", [dynamicHandler("dyn_tool"), dynamicHandler("Bash")])
    const owners = loader.toolOwners()
    expect([...owners.keys()].sort()).toEqual(["ProvToolSearch", "dyn_tool"])
    expect(owners.get("ProvToolSearch")).toEqual({
      pluginId: "prov-tool",
      packageDir: join(PLUGINS, "prov-tool"),
    })
    expect(owners.get("dyn_tool")).toEqual({
      pluginId: "ctx_frag",
      packageDir: join(PLUGINS, "ctx_frag"),
    })
    expect(owners.has("Bash")).toBe(false)
  })

  it("provenance is undefined before getPromptBlocksAsync and set after", async () => {
    const loader = await loadFixture()
    expect(loader.getPromptProvenance()).toBeUndefined()
    await loader.getPromptBlocksAsync()
    expect(loader.getPromptProvenance()).toBeDefined()
  })

  it("sections name the owner, in wire order, with the -N suffix", async () => {
    const loader = await loadFixture()
    await loader.getPromptBlocksAsync()
    const sections = loader.getPromptProvenance()?.sessionContext ?? []
    expect(sections).toEqual([
      {
        role: "behavior",
        name: "rules",
        pluginId: "beh_one",
        packageDir: join(PLUGINS, "beh_one"),
      },
      {
        role: "behavior",
        name: "rules-2",
        pluginId: "beh_two",
        packageDir: join(PLUGINS, "beh_two"),
      },
      {
        role: "tool",
        name: "ProvToolSearch",
        pluginId: "prov-tool",
        packageDir: join(PLUGINS, "prov-tool"),
      },
      {
        role: "context",
        name: "ambient-data",
        pluginId: "ctx_frag",
        packageDir: join(PLUGINS, "ctx_frag"),
      },
    ])
  })

  it("afterInstructions spans slice back to each fragment's trimmed text", async () => {
    const loader = await loadFixture()
    const blocks = await loader.getPromptBlocksAsync()
    const text = blocks.afterInstructions ?? ""
    expect(text).toBe("AI_ONE\nline two\n\nAI_TWO")
    const spans = loader.getPromptProvenance()?.afterInstructions ?? []
    expect(spans.map((s) => [s.pluginId, s.fragmentId, text.slice(s.start, s.end)])).toEqual([
      ["ctx_frag", "first", "AI_ONE\nline two"],
      ["ctx_frag", "second", "AI_TWO"],
    ])
  })
})

const SESSION_FRAGMENT = "\n\nSESSION_FRAGMENT"

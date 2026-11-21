/**
 * The loader wires the one prompt expander (step 14, design 50 §2) end to
 * end. A stub `prompts.template` plugin uppercases each `%%X%%` token:
 *
 * - S3: a `PROMPT.md` body is rendered (static text).
 * - S4: a fragment string passes unchanged; a fragment `PromptTemplateText`
 *   is rendered.
 * - S6: a plugin tool description and schema descriptions are rendered.
 * - The expander is on the base holder (`getPromptExpander`).
 * - A throwing engine: the raw text goes out, one `prompt.template_failed`.
 *
 * @module plugins/loader.prompt-expand.test
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { getPromptExpander } from "../llm/system-prompt-base-registry.ts"

import { CORE_TOOLS, TOOL_HANDLER_BODY, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-prompt-expand-tests")

const UPPER_ENGINE = `export default () => ({
  render: () => "",
  expand: (text, ctx) =>
    ctx === undefined
      ? text
      : text.replace(/%%([A-Za-z]+)%%/g, (_m, n) =>
          ctx.vars[n] === undefined ? n.toUpperCase() : String(ctx.vars[n])),
})
`

const THROWING_ENGINE = `export default () => ({
  render: () => "",
  expand: (text, ctx) => {
    if (ctx !== undefined) throw new Error("bad token")
    return text
  },
})
`

function writeTemplatePlugin(home: string, body: string): void {
  writePackage(
    home,
    "stub-template",
    {
      id: "stub-template",
      name: "stub-template",
      version: "0.1.0",
      description: "test %%notRendered%%",
      promptTemplate: { id: "stub", entry: "./engine.ts" },
    },
    { "engine.ts": body },
  )
}

function writeContentPlugins(home: string): void {
  writePackage(
    home,
    "tpl-tool",
    {
      id: "tpl-tool",
      name: "tpl-tool",
      version: "0.1.0",
      description: "d",
      headless: {
        tools: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: "TplTool",
                description: "Use %%tag%% here",
                input_schema: {
                  type: "object",
                  properties: { q: { type: "string", description: "q %%tag%%" } },
                },
                explicitName: true,
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
    },
    { "h.ts": TOOL_HANDLER_BODY, "PROMPT.md": "Tool prose %%tag%%." },
  )
  writePackage(
    home,
    "tpl-frag",
    {
      id: "tpl-frag",
      name: "tpl-frag",
      version: "0.1.0",
      description: "d",
      promptFragments: [
        { id: "data", handler: { type: "module", path: "./s.ts", export: "default" } },
        { id: "tpl", handler: { type: "module", path: "./t.ts", export: "default" } },
      ],
    },
    {
      "PROMPT.md": "# Frag Plugin\n\nStatic %%tag%%.",
      "s.ts": "export default async () => 'DATA %%tag%%'",
      "t.ts": "export default async () => ({ template: 'TPL %%tag%% n=%%n%%', vars: { n: 7 } })",
    },
  )
}

async function load(home: string, diagnostics?: ReturnType<typeof createDiagnostics>) {
  return PluginLoader.load({
    userDir: home,
    roots: { project: [join(ROOT, "nope", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
    ...(diagnostics ? { diagnostics } : {}),
  })
}

describe("PluginLoader renders prompt text through the one expander", () => {
  const home = join(ROOT, "ok")
  let loader: PluginLoader

  beforeAll(async () => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(home, { recursive: true })
    writeTemplatePlugin(home, UPPER_ENGINE)
    writeContentPlugins(home)
    loader = await load(home)
  })
  afterAll(() => {
    loader.releaseSystemPromptBase()
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("S3 and S4: PROMPT.md is rendered, a fragment string is data, a fragment template is rendered", async () => {
    const blocks = await loader.getPromptBlocksAsync()
    const text = blocks.sessionContext ?? ""
    expect(text).toContain("Tool prose TAG.")
    expect(text).toContain("Static TAG.")
    expect(text).toContain("DATA %%tag%%")
    expect(text).toContain("TPL TAG n=7")
    // The top-level manifest description is not model text.
    expect(text).not.toContain("NOTRENDERED")
  })

  it("S6: the plugin tool description and schema descriptions are rendered", () => {
    const tool = loader.getExtraTools().find((t) => t.name === "TplTool")
    expect(tool?.description).toBe("Use TAG here")
    const props = tool?.input_schema.properties as Record<string, { description?: string }>
    expect(props.q?.description).toBe("q TAG")
  })

  it("the expander is on the base holder and process-wide", () => {
    expect(loader.systemPromptBase().expand).toBe(loader.promptExpander())
    expect(getPromptExpander()).toBe(loader.promptExpander())
    expect(loader.promptExpander()("a %%b%%")).toBe("a B")
  })
})

describe("PluginLoader with a throwing engine fails open", () => {
  const home = join(ROOT, "throw")
  let loader: PluginLoader
  const events: LogEvent[] = []

  beforeAll(async () => {
    mkdirSync(home, { recursive: true })
    writeTemplatePlugin(home, THROWING_ENGINE)
    writeContentPlugins(home)
    loader = await load(home, createDiagnostics({ emit: (e: LogEvent) => events.push(e) }))
  })
  afterAll(() => {
    loader.releaseSystemPromptBase()
    rmSync(home, { recursive: true, force: true })
  })

  it("sends the raw text and one prompt.template_failed for each source", async () => {
    const text = (await loader.getPromptBlocksAsync()).sessionContext ?? ""
    expect(text).toContain("Tool prose %%tag%%.")
    expect(text).toContain("TPL %%tag%% n=%%n%%")
    loader.getExtraTools()
    loader.getExtraTools()
    const failed = events.filter((e) => e.source === "prompt.template_failed")
    const sources = failed.map((e) => (e.structuredData as { source?: string }).source)
    expect(new Set(sources).size).toBe(sources.length)
    expect(sources).toContain("plugin:tpl-tool:PROMPT.md")
    expect(sources).toContain("tool:TplTool")
  })
})

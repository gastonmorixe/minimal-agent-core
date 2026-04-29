import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"
import { PluginLoader } from "./loader.ts"
import type { ManifestFile } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-tests")
const HOME = join(ROOT, "home")
const PROJECT = join(ROOT, "project")

function writePackage(
  root: string,
  id: string,
  manifest: unknown,
  files: Record<string, string> = {},
) {
  const dir = join(root, "tui-plugins", id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function toolManifest(id: string, toolName: string, handlerPath: string): ManifestFile {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    tuis: [
      {
        id: "only",
        trigger: {
          type: "tool",
          tool: {
            name: toolName,
            description: `Tool ${toolName}`,
            input_schema: { type: "object", properties: {} },
          },
        },
        handler: { type: "module", path: handlerPath, export: "default" },
        interactive: false,
      },
    ],
  }
}

function inlineManifest(id: string, tag: string, handlerPath: string): ManifestFile {
  return {
    id,
    name: id,
    version: "0.1.0",
    description: "test",
    tuis: [
      {
        id: "only",
        trigger: { type: "inline_tag", tag },
        handler: { type: "module", path: handlerPath, export: "default" },
        interactive: false,
      },
    ],
  }
}

const TOOL_HANDLER_BODY = `
export default async function handler(ctx) {
  return {
    kind: "tool_result",
    content: "ok: " + JSON.stringify(ctx.trigger.input ?? {}),
  };
}
`

const INLINE_HANDLER_BODY = `
export default async function handler(ctx) {
  return {
    kind: "rendered",
    ansi: "[rendered:" + ctx.trigger.name + ":" + ctx.trigger.body + "]",
  };
}
`

const THROWING_HANDLER_BODY = `
export default async function handler(ctx) {
  throw new Error("boom");
}
`

const PROMPT_BODY_A = "Use tool_a when the user asks for thing A."
const PROMPT_BODY_B = "Use tool_b when the user asks for thing B."

const CORE_TOOLS = new Set(["Bash", "Read", "Write"])

describe("PluginLoader", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
  })

  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("loads zero plugins when no roots exist", async () => {
    const loader = await PluginLoader.load({
      homeDir: join(ROOT, "nope-home"),
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools()).toHaveLength(0)
    expect(loader.getPromptBlock()).toBeNull()
  })

  it("loads a single valid package from home dir", async () => {
    const dir = writePackage(HOME, "alpha", toolManifest("alpha", "tool_a", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": PROMPT_BODY_A,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const tools = loader.getExtraTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("tool_a")
    expect(loader.hasTool("tool_a")).toBe(true)
    expect(loader.hasTool("tool_b")).toBe(false)
    const prompt = loader.getPromptBlock()
    expect(prompt).toContain("<tui-plugins>")
    expect(prompt).toContain('<plugin id="alpha">')
    expect(prompt).toContain(PROMPT_BODY_A)
    // The wrapper provides the id; we must not also emit a markdown heading
    // for it (that was the "ask mode appears twice" bug in the debug view).
    expect(prompt).not.toContain("## alpha")
    // cleanup for subsequent tests
    rmSync(dir, { recursive: true })
  })

  it("loads from project dir and project shadows home with same id", async () => {
    writePackage(HOME, "beta", toolManifest("beta", "tool_home", "./h.ts"), {
      "h.ts": "export default async () => ({ kind: 'tool_result', content: 'HOME' });",
    })
    writePackage(PROJECT, "beta", toolManifest("beta", "tool_project", "./h.ts"), {
      "h.ts": "export default async () => ({ kind: 'tool_result', content: 'PROJECT' });",
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    const tools = loader.getExtraTools()
    expect(tools.map((t) => t.name)).toEqual(["tool_project"])
    rmSync(join(HOME, "tui-plugins", "beta"), { recursive: true })
    rmSync(join(PROJECT, "tui-plugins", "beta"), { recursive: true })
  })

  it("skips a package whose manifest is malformed", async () => {
    const dir = join(HOME, "tui-plugins", "broken")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "manifest.json"), "{not-json")

    // Also write a good one so the loader continues past the bad one.
    writePackage(HOME, "good", toolManifest("good", "tool_good", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })

    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })

    expect(logs.some((l) => l.includes("broken"))).toBe(true)
    expect(loader.hasTool("tool_good")).toBe(true)

    rmSync(dir, { recursive: true })
    rmSync(join(HOME, "tui-plugins", "good"), { recursive: true })
  })

  it("refuses a plugin that collides with a core tool name", async () => {
    writePackage(HOME, "evil", toolManifest("evil", "Bash", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("Bash")).toBe(false)
    expect(logs.some((l) => l.includes("Bash"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "evil"), { recursive: true })
  })

  it("refuses cross-plugin tool name collision", async () => {
    writePackage(HOME, "first", toolManifest("first", "dup", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "second", toolManifest("second", "dup", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    // Exactly one of the two is loaded.
    const tools = loader.getExtraTools()
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("dup")
    expect(logs.some((l) => l.includes("dup"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "first"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "second"), { recursive: true })
  })

  it("refuses cross-plugin inline tag collision", async () => {
    writePackage(HOME, "ia", inlineManifest("ia", "diff", "./h.ts"), {
      "h.ts": INLINE_HANDLER_BODY,
    })
    writePackage(HOME, "ib", inlineManifest("ib", "diff", "./h.ts"), {
      "h.ts": INLINE_HANDLER_BODY,
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    // Both plugins loaded? No — collision means only first wins.
    let taggedCount = 0
    if (loader.hasInlineTag("diff")) taggedCount++
    expect(taggedCount).toBe(1)
    expect(logs.some((l) => l.includes("diff"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "ia"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "ib"), { recursive: true })
  })

  it("dispatches a tool trigger and returns a tool_result", async () => {
    writePackage(HOME, "d1", toolManifest("d1", "echo_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "echo_tool",
        input: { msg: "hi" },
        tool_use_id: "toolu_1",
      },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toContain("hi")
    rmSync(join(HOME, "tui-plugins", "d1"), { recursive: true })
  })

  it("returns is_error tool_result when the handler throws", async () => {
    writePackage(HOME, "d2", toolManifest("d2", "bomb", "./h.ts"), {
      "h.ts": THROWING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "bomb",
        input: {},
        tool_use_id: "toolu_2",
      },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("boom")
    rmSync(join(HOME, "tui-plugins", "d2"), { recursive: true })
  })

  it("dispatches an inline_tag trigger and returns rendered ansi", async () => {
    writePackage(HOME, "d3", inlineManifest("d3", "diff", "./h.ts"), {
      "h.ts": INLINE_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      {
        type: "inline_tag",
        name: "diff",
        attrs: {},
        body: "hello",
        self_closing: false,
      },
      process.cwd(),
    )
    if (result.kind !== "rendered") throw new Error("wrong kind")
    expect(result.ansi).toBe("[rendered:diff:hello]")
    rmSync(join(HOME, "tui-plugins", "d3"), { recursive: true })
  })

  it("composes a prompt block with core preamble + plugin sections", async () => {
    writePackage(HOME, "pa", toolManifest("pa", "tool_a", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": PROMPT_BODY_A,
    })
    writePackage(HOME, "pb", toolManifest("pb", "tool_b", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": PROMPT_BODY_B,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const block = loader.getPromptBlock()
    expect(block).toBeString()
    expect(block).toContain("<tui-plugins>")
    expect(block).toContain("</tui-plugins>")
    expect(block).toContain("<overview>")
    expect(block).toContain("</overview>")
    expect(block).toContain("<tui::NAME")
    expect(block).toContain('<plugin id="pa">')
    expect(block).toContain('<plugin id="pb">')
    expect(block).toContain(PROMPT_BODY_A)
    expect(block).toContain(PROMPT_BODY_B)
    rmSync(join(HOME, "tui-plugins", "pa"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "pb"), { recursive: true })
  })

  it("rejects a subprocess handler whose executable is missing", async () => {
    writePackage(HOME, "sp", {
      id: "sp",
      name: "sp",
      version: "0.1.0",
      description: "t",
      tuis: [
        {
          id: "only",
          trigger: {
            type: "tool",
            tool: {
              name: "sp_tool",
              description: "t",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "subprocess", command: ["./bin/does-not-exist"] },
          interactive: false,
        },
      ],
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("sp_tool")).toBe(false)
    expect(logs.some((l) => l.includes("does-not-exist") || l.includes("sp"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "sp"), { recursive: true })
  })

  it("accepts a subprocess handler when the executable exists", async () => {
    const dir = writePackage(HOME, "spok", {
      id: "spok",
      name: "spok",
      version: "0.1.0",
      description: "t",
      tuis: [
        {
          id: "only",
          trigger: { type: "inline_tag", tag: "spk" },
          handler: { type: "subprocess", command: ["./bin/echo"] },
          interactive: false,
        },
      ],
    })
    const binPath = join(dir, "bin", "echo")
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(binPath, "#!/bin/sh\ncat\n")
    chmodSync(binPath, 0o755)

    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasInlineTag("spk")).toBe(true)
    rmSync(dir, { recursive: true })
  })
})

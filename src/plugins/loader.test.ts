import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { join, resolve } from "node:path"
import { PluginLoader } from "./loader.ts"
import type { ManifestFile } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-tests")
const HOME = join(ROOT, "home")
const PROJECT = join(ROOT, "project")
const EMBEDDED = join(ROOT, "embedded")

function writePackage(
  root: string,
  id: string,
  manifest: unknown,
  files: Record<string, string> = {},
  sub: string = "tui-plugins",
) {
  const dir = join(root, sub, id)
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
    mkdirSync(EMBEDDED, { recursive: true })
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
    writePackage(
      PROJECT,
      "beta",
      toolManifest("beta", "tool_project", "./h.ts"),
      {
        "h.ts": "export default async () => ({ kind: 'tool_result', content: 'PROJECT' });",
      },
      ".agents/tui-plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    const tools = loader.getExtraTools()
    expect(tools.map((t) => t.name)).toEqual(["tool_project"])
    rmSync(join(HOME, "tui-plugins", "beta"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "tui-plugins", "beta"), { recursive: true })
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

  it("loads embedded plugins from <embeddedDir>/tui-plugins/", async () => {
    writePackage(EMBEDDED, "emb1", toolManifest("emb1", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "embedded plugin prompt",
    })
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: join(ROOT, "nope-home"),
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasTool("tool_emb")).toBe(true)
    const block = loader.getPromptBlock()
    expect(block).toContain('<plugin id="emb1">')
    expect(block).toContain("embedded plugin prompt")
    rmSync(join(EMBEDDED, "tui-plugins", "emb1"), { recursive: true })
  })

  it("project plugins live at <projectDir>/.agents/tui-plugins/, not <projectDir>/tui-plugins/", async () => {
    // Old (incorrect) path: should NOT be picked up.
    writePackage(PROJECT, "old_path", toolManifest("old_path", "tool_old", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    // New (correct) path.
    writePackage(
      PROJECT,
      "new_path",
      toolManifest("new_path", "tool_new", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/tui-plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: join(ROOT, "nope-home"),
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasTool("tool_new")).toBe(true)
    expect(loader.hasTool("tool_old")).toBe(false)
    rmSync(join(PROJECT, "tui-plugins", "old_path"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "tui-plugins", "new_path"), { recursive: true })
  })

  it("loads non-colliding plugins from all three roots together", async () => {
    writePackage(EMBEDDED, "e_only", toolManifest("e_only", "tool_e", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "h_only", toolManifest("h_only", "tool_h", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(
      PROJECT,
      "p_only",
      toolManifest("p_only", "tool_p", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/tui-plugins",
    )
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    const names = loader
      .getExtraTools()
      .map((t) => t.name)
      .sort()
    expect(names).toEqual(["tool_e", "tool_h", "tool_p"])
    rmSync(join(EMBEDDED, "tui-plugins", "e_only"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "h_only"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "tui-plugins", "p_only"), { recursive: true })
  })

  it("on package-id collision, project shadows home shadows embedded", async () => {
    writePackage(EMBEDDED, "shared", toolManifest("shared", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "shared", toolManifest("shared", "tool_home", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(
      PROJECT,
      "shared",
      toolManifest("shared", "tool_project", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/tui-plugins",
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const names = loader.getExtraTools().map((t) => t.name)
    expect(names).toEqual(["tool_project"])
    // Both home and embedded variants were skipped with a precedence note.
    expect(logs.filter((l) => l.includes('"shared"')).length).toBeGreaterThanOrEqual(2)
    expect(logs.some((l) => l.includes("project > home > embedded"))).toBe(true)
    rmSync(join(EMBEDDED, "tui-plugins", "shared"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "shared"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "tui-plugins", "shared"), { recursive: true })
  })

  it("home shadows embedded when project has no entry for the id", async () => {
    writePackage(EMBEDDED, "two_way", toolManifest("two_way", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "two_way", toolManifest("two_way", "tool_home", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_home"])
    rmSync(join(EMBEDDED, "tui-plugins", "two_way"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "two_way"), { recursive: true })
  })

  it("disabledPluginIds skips matching packages with a diagnostic", async () => {
    writePackage(HOME, "kept", toolManifest("kept", "tool_kept", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "dropped", toolManifest("dropped", "tool_dropped", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
      disabledPluginIds: new Set(["dropped"]),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_kept"])
    expect(logs.some((l) => l.includes('"dropped" is disabled'))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "kept"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "dropped"), { recursive: true })
  })

  it("alias map: tool dispatch resolves alias on canonical-miss", async () => {
    // Plugin declares canonical "Aliased" with one alias "old_aliased".
    const manifest = toolManifest("aliased_pkg", "Aliased", "./h.ts")
    manifest.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Aliased",
        description: "Aliased tool",
        input_schema: { type: "object", properties: {} },
        aliases: ["old_aliased"],
      },
    }
    writePackage(HOME, "aliased_pkg", manifest, { "h.ts": TOOL_HANDLER_BODY })
    const loader = await PluginLoader.load({ homeDir: HOME, coreToolNames: CORE_TOOLS })

    // Canonical is advertised; alias is NOT advertised but IS dispatchable.
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["Aliased"])
    expect(loader.hasTool("Aliased")).toBe(true)
    expect(loader.hasTool("old_aliased")).toBe(true)
    expect(loader.hasTool("nope")).toBe(false)
    expect(loader.getToolAliases().get("old_aliased")).toBe("Aliased")

    // Both names dispatch to the same handler with byte-identical results.
    const a = await loader.dispatch(
      { type: "tool", name: "Aliased", input: { x: 1 }, tool_use_id: "u1" },
      "/cwd",
    )
    const b = await loader.dispatch(
      { type: "tool", name: "old_aliased", input: { x: 1 }, tool_use_id: "u2" },
      "/cwd",
    )
    expect(a.kind).toBe("tool_result")
    expect(b.kind).toBe("tool_result")
    if (a.kind === "tool_result" && b.kind === "tool_result") {
      // Same content (the test handler echoes input as JSON).
      expect(a.content).toBe(b.content)
      expect(a.is_error).toBe(b.is_error)
    }
    rmSync(join(HOME, "tui-plugins", "aliased_pkg"), { recursive: true })
  })

  it("alias collision: alias collides with another plugin's canonical → reject", async () => {
    // Plugin A claims canonical "Tool_A". Plugin B aliases "Tool_A" — collision.
    writePackage(HOME, "pkg_a", toolManifest("pkg_a", "Tool_A", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const m = toolManifest("pkg_b", "Tool_B", "./h.ts")
    m.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_B",
        description: "x",
        input_schema: { type: "object", properties: {} },
        aliases: ["Tool_A"],
      },
    }
    writePackage(HOME, "pkg_b", m, { "h.ts": TOOL_HANDLER_BODY })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (msg) => logs.push(msg),
    })
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Tool_A"])
    expect(logs.some((l) => l.includes('alias "Tool_A"') && l.includes("canonical"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "pkg_a"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "pkg_b"), { recursive: true })
  })

  it("alias collision: alias collides with another plugin's alias → reject", async () => {
    const m1 = toolManifest("pkg_x", "Tool_X", "./h.ts")
    m1.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_X",
        description: "x",
        input_schema: { type: "object", properties: {} },
        aliases: ["legacy"],
      },
    }
    const m2 = toolManifest("pkg_y", "Tool_Y", "./h.ts")
    m2.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_Y",
        description: "y",
        input_schema: { type: "object", properties: {} },
        aliases: ["legacy"],
      },
    }
    writePackage(HOME, "pkg_x", m1, { "h.ts": TOOL_HANDLER_BODY })
    writePackage(HOME, "pkg_y", m2, { "h.ts": TOOL_HANDLER_BODY })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (msg) => logs.push(msg),
    })
    // First-loaded plugin keeps its alias; second is rejected entirely.
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Tool_X"])
    expect(loader.getToolAliases().has("legacy")).toBe(true)
    expect(logs.some((l) => l.includes('alias "legacy"'))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "pkg_x"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "pkg_y"), { recursive: true })
  })

  it("alias collision: alias collides with a core tool name → reject plugin", async () => {
    const m = toolManifest("alias_core", "Tool_Z", "./h.ts")
    m.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_Z",
        description: "z",
        input_schema: { type: "object", properties: {} },
        aliases: ["Bash"], // collides with core
      },
    }
    writePackage(HOME, "alias_core", m, { "h.ts": TOOL_HANDLER_BODY })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (msg) => logs.push(msg),
    })
    expect(loader.getExtraTools()).toEqual([])
    expect(logs.some((l) => l.includes('alias "Bash"') && l.includes("core tool"))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "alias_core"), { recursive: true })
  })

  it("disabling a high-precedence copy does NOT promote the lower-precedence one", async () => {
    // Project disabled, home present, embedded present. Without the id
    // reservation in the loader, home would silently take over — a
    // surprising behavior that defeats the user's intent. Verify that
    // disabling the id at the highest precedence kills it everywhere.
    writePackage(EMBEDDED, "shared2", toolManifest("shared2", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(HOME, "shared2", toolManifest("shared2", "tool_home", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(
      PROJECT,
      "shared2",
      toolManifest("shared2", "tool_project", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/tui-plugins",
    )
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
      disabledPluginIds: new Set(["shared2"]),
    })
    expect(loader.getExtraTools()).toEqual([])
    rmSync(join(EMBEDDED, "tui-plugins", "shared2"), { recursive: true })
    rmSync(join(HOME, "tui-plugins", "shared2"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "tui-plugins", "shared2"), { recursive: true })
  })
})

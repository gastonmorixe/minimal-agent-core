import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import { getDiagnosticBus, type LogEvent, Severity } from "../diagnostic-bus.ts"

import {
  CORE_TOOLS,
  HOME,
  INLINE_HANDLER_BODY,
  inlineManifest,
  PROJECT,
  PROMPT_BODY_A,
  ROOT,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const EMBEDDED = join(ROOT, "embedded")

const THROWING_HANDLER_BODY = `export default async function handler(ctx) { throw new Error("boom"); }`

const PROMPT_BODY_B = "Use tool_b when the user asks for thing B."

function tp(id: string, toolName: string, extra?: Record<string, string>): string {
  return writePackage(HOME, id, toolManifest(id, toolName, "./h.ts"), {
    "h.ts": TOOL_HANDLER_BODY,
    ...extra,
  })
}

function ip(id: string, tag: string): string {
  return writePackage(HOME, id, inlineManifest(id, tag, "./h.ts"), { "h.ts": INLINE_HANDLER_BODY })
}

describe("PluginLoader", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(HOME, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
    mkdirSync(EMBEDDED, { recursive: true })
  })

  afterEach(() => {
    rmSync(join(HOME, "plugins"), { recursive: true, force: true })
    rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true })
    rmSync(join(PROJECT, ".agents", "plugins"), { recursive: true, force: true })
    rmSync(join(PROJECT, "plugins"), { recursive: true, force: true })
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
    tp("alpha", "tool_a", { "PROMPT.md": PROMPT_BODY_A })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools()).toHaveLength(1)
    expect(loader.getExtraTools()[0].name).toBe("tool_a")
    expect(loader.hasTool("tool_a")).toBe(true)
    expect(loader.hasTool("tool_b")).toBe(false)
    const prompt = loader.getPromptBlock()
    expect(prompt).toContain('<ma::sys::tool name="tool_a">')
    expect(prompt).toContain("</ma::sys::tool>")
    expect(prompt).toContain(PROMPT_BODY_A)
    expect(prompt).not.toContain("ma::plugin")
    expect(prompt).not.toContain("alpha")
  })

  it("loads from project dir and project shadows home with same id", async () => {
    writePackage(HOME, "beta", toolManifest("beta", "tool_home", "./h.ts"), {
      "h.ts": "export default async () => ({ kind: 'tool_result', content: 'HOME' });",
    })
    writePackage(
      PROJECT,
      "beta",
      toolManifest("beta", "tool_project", "./h.ts"),
      { "h.ts": "export default async () => ({ kind: 'tool_result', content: 'PROJECT' });" },
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_project"])
  })

  it("skips a package whose manifest is malformed", async () => {
    mkdirSync(join(HOME, "plugins", "broken"), { recursive: true })
    writeFileSync(join(HOME, "plugins", "broken", "manifest.json"), "{not-json")
    tp("good", "tool_good")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(logs.some((l) => l.includes("broken"))).toBe(true)
    expect(loader.hasTool("tool_good")).toBe(true)
  })

  it("refuses a plugin that collides with a core tool name", async () => {
    tp("evil", "Bash")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("Bash")).toBe(false)
    expect(logs.some((l) => l.includes("Bash"))).toBe(true)
  })

  it("refuses cross-plugin tool name collision", async () => {
    tp("first", "dup")
    tp("second", "dup")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools()).toHaveLength(1)
    expect(loader.getExtraTools()[0].name).toBe("dup")
    expect(logs.some((l) => l.includes("dup"))).toBe(true)
  })

  it("refuses cross-plugin inline tag collision", async () => {
    ip("ia", "diff")
    ip("ib", "diff")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    let taggedCount = 0
    if (loader.hasInlineTag("diff")) taggedCount++
    expect(taggedCount).toBe(1)
    expect(logs.some((l) => l.includes("diff"))).toBe(true)
  })

  it("dispatches a tool trigger and returns a tool_result", async () => {
    tp("d1", "echo_tool")
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      { type: "tool", name: "echo_tool", input: { msg: "hi" }, tool_use_id: "toolu_1" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toContain("hi")
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
      { type: "tool", name: "bomb", input: {}, tool_use_id: "toolu_2" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.is_error).toBe(true)
    expect(result.content).toContain("boom")
  })

  it("dispatches an inline_tag trigger and returns rendered ansi", async () => {
    ip("d3", "diff")
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const result = await loader.dispatch(
      { type: "inline_tag", name: "diff", attrs: {}, body: "hello", self_closing: false },
      process.cwd(),
    )
    if (result.kind !== "rendered") throw new Error("wrong kind")
    expect(result.ansi).toBe("[rendered:diff:hello]")
  })

  it("composes a prompt block with core preamble + plugin sections", async () => {
    tp("pa", "tool_a", { "PROMPT.md": PROMPT_BODY_A })
    tp("pb", "tool_b", { "PROMPT.md": PROMPT_BODY_B })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const block = loader.getPromptBlock()
    expect(block).toBeString()
    expect(block).not.toContain("ma::plugin")
    expect(block).toContain('<ma::sys::tool name="tool_a">')
    expect(block).toContain('<ma::sys::tool name="tool_b">')
    expect(block).toContain(PROMPT_BODY_A)
    expect(block).toContain(PROMPT_BODY_B)
    expect(block!.indexOf("tool_a")).toBeLessThan(block!.indexOf("tool_b"))
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
    mkdirSync(join(dir, "bin"), { recursive: true })
    writeFileSync(join(dir, "bin", "echo"), "#!/bin/sh\ncat\n")
    chmodSync(join(dir, "bin", "echo"), 0o755)

    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasInlineTag("spk")).toBe(true)
  })

  it("loads embedded plugins from <embeddedDir>/plugins/", async () => {
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
    expect(block).toContain('<ma::sys::tool name="tool_emb">')
    expect(block).toContain("embedded plugin prompt")
  })

  it("project plugins live at <projectDir>/.agents/plugins/, not <projectDir>/plugins/", async () => {
    writePackage(PROJECT, "old_path", toolManifest("old_path", "tool_old", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(
      PROJECT,
      "new_path",
      toolManifest("new_path", "tool_new", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: join(ROOT, "nope-home"),
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasTool("tool_new")).toBe(true)
    expect(loader.hasTool("tool_old")).toBe(false)
  })

  it("loads non-colliding plugins from all three roots together", async () => {
    writePackage(EMBEDDED, "e_only", toolManifest("e_only", "tool_e", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    tp("h_only", "tool_h")
    writePackage(
      PROJECT,
      "p_only",
      toolManifest("p_only", "tool_p", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_e", "tool_h", "tool_p"])
  })

  it("on package-id collision, project shadows home shadows embedded", async () => {
    writePackage(EMBEDDED, "shared", toolManifest("shared", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    tp("shared", "tool_home")
    writePackage(
      PROJECT,
      "shared",
      toolManifest("shared", "tool_project", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/plugins",
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_project"])
    expect(logs.filter((l) => l.includes('"shared"')).length).toBeGreaterThanOrEqual(2)
    expect(logs.some((l) => l.includes("project > home > user > embedded"))).toBe(true)
  })

  it("home shadows embedded when project has no entry for the id", async () => {
    writePackage(EMBEDDED, "two_way", toolManifest("two_way", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    tp("two_way", "tool_home")
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_home"])
  })

  it("deduplicates by realpath when project and home roots overlap (cwd=$HOME case)", async () => {
    const overlapRoot = join(ROOT, "overlap")
    rmSync(overlapRoot, { recursive: true, force: true })
    mkdirSync(overlapRoot, { recursive: true })
    writePackage(
      overlapRoot,
      "shared_overlap",
      toolManifest("shared_overlap", "tool_overlap", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/plugins",
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: join(overlapRoot, ".agents"),
      projectDir: overlapRoot,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_overlap"])
    expect(logs.some((l) => l.includes("already loaded"))).toBe(false)
    rmSync(overlapRoot, { recursive: true, force: true })
  })

  it("deduplicates by realpath across roots when symlinks point to the same target", async () => {
    const real = join(ROOT, "real-symlink-target")
    rmSync(real, { recursive: true, force: true })
    mkdirSync(real, { recursive: true })
    writeFileSync(
      join(real, "manifest.json"),
      JSON.stringify(toolManifest("sym_pkg", "tool_sym", "./h.ts"), null, 2),
    )
    writeFileSync(join(real, "h.ts"), TOOL_HANDLER_BODY)
    mkdirSync(join(HOME, "plugins"), { recursive: true })
    mkdirSync(join(EMBEDDED, "plugins"), { recursive: true })
    symlinkSync(real, join(HOME, "plugins", "sym_pkg"), "dir")
    symlinkSync(real, join(EMBEDDED, "plugins", "sym_pkg"), "dir")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_sym"])
    expect(logs.some((l) => l.includes("already loaded"))).toBe(false)
    rmSync(real, { recursive: true, force: true })
  })

  it("id-shadow skip emits Notice (not Warning) on the default bus path", async () => {
    const USER = join(ROOT, "user-shadow")
    rmSync(USER, { recursive: true, force: true })
    tp("dup_shadow", "tool_dup")
    writePackage(USER, "dup_shadow", toolManifest("dup_shadow", "tool_dup", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })

    const events: LogEvent[] = []
    const unsubscribe = getDiagnosticBus().on("*", (e) => events.push(e))
    try {
      const loader = await PluginLoader.load({
        homeDir: HOME,
        userDir: USER,
        projectDir: join(ROOT, "nope-project"),
        coreToolNames: CORE_TOOLS,
      })
      expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_dup"])
    } finally {
      unsubscribe()
    }

    const shadow = events.filter(
      (e) => e.source === "plugin-loader" && e.message.includes("already loaded"),
    )
    expect(shadow.length).toBeGreaterThanOrEqual(1)
    expect(shadow.every((e) => e.severity === Severity.Notice)).toBe(true)
    expect(shadow.some((e) => e.severity === Severity.Warning)).toBe(false)
    rmSync(USER, { recursive: true, force: true })
  })

  it("disabledPluginIds skips matching packages with a diagnostic", async () => {
    tp("kept", "tool_kept")
    tp("dropped", "tool_dropped")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
      disabledPluginIds: new Set(["dropped"]),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_kept"])
    expect(logs.some((l) => l.includes('"dropped" is disabled'))).toBe(true)
  })

  it("manifest.enabled=false skips the plugin (author opt-out)", async () => {
    const optOut = toolManifest("optout", "tool_optout", "./h.ts")
    optOut.enabled = false
    writePackage(HOME, "optout", optOut, { "h.ts": TOOL_HANDLER_BODY })
    tp("live", "tool_live")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_live"])
    expect(
      logs.some(
        (l) => l.includes('"optout" is disabled by its manifest') && l.includes("manifest.enabled"),
      ),
    ).toBe(true)
  })

  it("enabledPluginIds overrides manifest.enabled=false (user opt-in)", async () => {
    const optOut = toolManifest("optin", "tool_optin", "./h.ts")
    optOut.enabled = false
    writePackage(HOME, "optin", optOut, { "h.ts": TOOL_HANDLER_BODY })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      enabledPluginIds: new Set(["optin"]),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_optin"])
  })

  it("disabledPluginIds wins over enabledPluginIds (deny beats allow)", async () => {
    const optOut = toolManifest("standoff", "tool_standoff", "./h.ts")
    optOut.enabled = false
    writePackage(HOME, "standoff", optOut, { "h.ts": TOOL_HANDLER_BODY })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
      enabledPluginIds: new Set(["standoff"]),
      disabledPluginIds: new Set(["standoff"]),
    })
    expect(loader.getExtraTools()).toHaveLength(0)
    expect(logs.some((l) => l.includes('"standoff" is disabled in user config'))).toBe(true)
  })

  it("alias map: tool dispatch resolves alias on canonical-miss", async () => {
    const manifest = toolManifest("aliased_pkg", "Aliased", "./h.ts")
    manifest.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Aliased",
        description: "Aliased tool",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
        aliases: ["old_aliased"],
      },
    }
    writePackage(HOME, "aliased_pkg", manifest, { "h.ts": TOOL_HANDLER_BODY })
    const loader = await PluginLoader.load({ homeDir: HOME, coreToolNames: CORE_TOOLS })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["Aliased"])
    expect(loader.hasTool("Aliased")).toBe(true)
    expect(loader.hasTool("old_aliased")).toBe(true)
    expect(loader.hasTool("nope")).toBe(false)
    expect(loader.getToolAliases().get("old_aliased")).toBe("Aliased")
    const dispatchAliased = (name: string) =>
      loader.dispatch({ type: "tool", name, input: { x: 1 }, tool_use_id: "u1" }, "/cwd")
    const a = await dispatchAliased("Aliased")
    const b = await dispatchAliased("old_aliased")
    expect(a.kind).toBe("tool_result")
    expect(b.kind).toBe("tool_result")
    if (a.kind === "tool_result" && b.kind === "tool_result") {
      expect(a.content).toBe(b.content)
      expect(a.is_error).toBe(b.is_error)
    }
  })

  it("alias collision: alias collides with another plugin's canonical → drop alias", async () => {
    tp("pkg_a", "Tool_A")
    const m = toolManifest("pkg_b", "Tool_B", "./h.ts")
    m.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_B",
        description: "x",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
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
    ).toEqual(["Tool_A", "Tool_B"])
    expect(logs.some((l) => l.includes('alias "Tool_A"') && l.includes("canonical"))).toBe(true)
  })

  it("alias collision: alias collides with another plugin's alias → drop alias", async () => {
    const m1 = toolManifest("pkg_x", "Tool_X", "./h.ts")
    m1.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_X",
        description: "x",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
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
        explicitName: true,
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
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Tool_X", "Tool_Y"])
    expect(loader.getToolAliases().has("legacy")).toBe(true)
    expect(logs.some((l) => l.includes('alias "legacy"'))).toBe(true)
  })

  it("alias collision: alias collides with a core tool name → drop alias", async () => {
    const m = toolManifest("alias_core", "Tool_Z", "./h.ts")
    m.tuis![0].trigger = {
      type: "tool",
      tool: {
        name: "Tool_Z",
        description: "z",
        input_schema: { type: "object", properties: {} },
        explicitName: true,
        aliases: ["Bash"],
      },
    }
    writePackage(HOME, "alias_core", m, { "h.ts": TOOL_HANDLER_BODY })
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
    ).toEqual(["Tool_Z"])
    expect(loader.getToolAliases().has("Bash")).toBe(false)
    expect(logs.some((l) => l.includes('alias "Bash"'))).toBe(true)
  })

  it("disabling a high-precedence copy does NOT promote the lower-precedence one", async () => {
    writePackage(EMBEDDED, "shared2", toolManifest("shared2", "tool_emb", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    tp("shared2", "tool_home")
    writePackage(
      PROJECT,
      "shared2",
      toolManifest("shared2", "tool_project", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
      disabledPluginIds: new Set(["shared2"]),
    })
    expect(loader.getExtraTools()).toEqual([])
  })

  it("registerDynamicTools adds tools to getExtraTools and dispatch", async () => {
    tp("host", "host_tool")
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["host_tool"])
    expect(loader.hasTool("dyn_a")).toBe(false)

    loader.registerDynamicTools("host", [
      {
        definition: {
          id: "dyn_a",
          trigger: {
            type: "tool",
            tool: {
              name: "dyn_a",
              description: "A dynamic tool",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "module", path: "./dyn.ts", export: "default" },
          interactive: false,
        },
        entryAbsolute: HOME,
        invoke: (async (_ctx: any) => ({ kind: "tool_result", content: "dynamic ok" })) as any,
      } as any,
    ])

    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["dyn_a", "host_tool"])
    expect(loader.hasTool("dyn_a")).toBe(true)

    const result = await loader.dispatch(
      { type: "tool", name: "dyn_a", input: {} } as any,
      process.cwd(),
    )
    expect(result.kind).toBe("tool_result")
    if (result.kind === "tool_result") {
      expect(result.content).toBe("dynamic ok")
    }
  })

  it("registerDynamicTools drops colliding names (built-in core tool)", async () => {
    tp("host_dyn", "host_dyn_tool")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (msg) => logs.push(msg),
    })
    loader.registerDynamicTools("host_dyn", [
      {
        definition: {
          id: "collision",
          trigger: {
            type: "tool",
            tool: {
              name: "Bash",
              description: "override",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "module", path: "./bad.ts", export: "default" },
          interactive: false,
        },
        entryAbsolute: HOME,
        invoke: (async (_: any) => ({ kind: "tool_result", content: "never" })) as any,
      } as any,
    ])
    expect(loader.hasTool("Bash")).toBe(false)
    expect(logs.some((l) => l.includes("collides with a core tool") && l.includes("Bash"))).toBe(
      true,
    )
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["host_dyn_tool"])
  })

  it("registerDynamicTools drops colliding names (existing plugin tool)", async () => {
    tp("alpha_dyn", "tool_alpha")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (msg) => logs.push(msg),
    })
    loader.registerDynamicTools("alpha_dyn", [
      {
        definition: {
          id: "collision2",
          trigger: {
            type: "tool",
            tool: {
              name: "tool_alpha",
              description: "x",
              input_schema: { type: "object", properties: {} },
            },
          },
          handler: { type: "module", path: "./bad.ts", export: "default" },
          interactive: false,
        },
        entryAbsolute: HOME,
        invoke: (async (_: any) => ({ kind: "tool_result", content: "never" })) as any,
      } as any,
    ])
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["tool_alpha"])
    expect(
      logs.some((l) => l.includes("collides with existing tool") && l.includes("tool_alpha")),
    ).toBe(true)
  })
})

import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { PluginLoader } from "./loader.ts"
import type { ManifestFile } from "./types.ts"

/**
 * Noop `PluginLogger` stand-in for ad-hoc `LiveAreaHandlerContext`
 * fixtures in this file. Production wiring uses `createPluginLogger`
 * from `src/diagnostic-bus.ts` (which fans events out to file +
 * scrollback + TUI surface); tests don't want that — they just need
 * the type to satisfy.
 */
function noopLogger(): import("../diagnostic-bus.ts").PluginLogger {
  const noop = () => {}
  return {
    emergency: noop,
    alert: noop,
    critical: noop,
    error: noop,
    warn: noop,
    notice: noop,
    info: noop,
    debug: noop,
  }
}

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

  // Reproduces the user-reported bug where running minimal-agent from
  // `$HOME` made the loader scan `cwd/.agents/tui-plugins` (= project)
  // AND `$HOME/.agents/tui-plugins` (= home) — the same physical
  // directory through two different roots. The pre-fix loader emitted a
  // spurious "already loaded" warning for every plugin inside; the
  // post-fix loader silently keeps the highest-precedence copy and the
  // warning never fires.
  it("deduplicates by realpath when project and home roots overlap (cwd=$HOME case)", async () => {
    // PROJECT-as-cwd points at HOME, so projectDir/.agents/tui-plugins ===
    // homeDir/tui-plugins. We don't need symlinks for this scenario; just
    // pass homeDir=HOME and projectDir=parent(HOME-tui-plugins-prefix).
    // Concretely: project's `.agents/tui-plugins` and home's `tui-plugins`
    // are the SAME directory.
    const overlapRoot = join(ROOT, "overlap")
    rmSync(overlapRoot, { recursive: true, force: true })
    mkdirSync(overlapRoot, { recursive: true })
    // The shared plugin dir lives at: <overlapRoot>/.agents/tui-plugins/shared
    // Reachable two ways:
    //   homeDir = <overlapRoot>/.agents  → scans .agents/tui-plugins
    //   projectDir = <overlapRoot>       → scans .agents/tui-plugins
    writePackage(
      overlapRoot,
      "shared_overlap",
      toolManifest("shared_overlap", "tool_overlap", "./h.ts"),
      { "h.ts": TOOL_HANDLER_BODY },
      ".agents/tui-plugins",
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: join(overlapRoot, ".agents"),
      projectDir: overlapRoot,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    // Loaded exactly once.
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_overlap"])
    // No "already loaded" warning — the pre-fix loader emitted one here
    // and it bled into the user's startup banner box.
    expect(logs.some((l) => l.includes("already loaded"))).toBe(false)
    rmSync(overlapRoot, { recursive: true, force: true })
  })

  // Symlink variant: a plugin author can keep their dev checkout at an
  // arbitrary location (e.g. `~/Projects/foo-plugin`) and surface it
  // under both `~/.agents/tui-plugins/foo-plugin` AND the embedded
  // tree without the loader complaining about a duplicate.
  it("deduplicates by realpath across roots when symlinks point to the same target", async () => {
    const real = join(ROOT, "real-symlink-target")
    rmSync(real, { recursive: true, force: true })
    mkdirSync(real, { recursive: true })
    writeFileSync(
      join(real, "manifest.json"),
      JSON.stringify(toolManifest("sym_pkg", "tool_sym", "./h.ts"), null, 2),
    )
    writeFileSync(join(real, "h.ts"), TOOL_HANDLER_BODY)
    // Surface the same physical dir under both home/tui-plugins AND
    // embedded/tui-plugins via symlinks.
    const homeLink = join(HOME, "tui-plugins", "sym_pkg")
    const embLink = join(EMBEDDED, "tui-plugins", "sym_pkg")
    mkdirSync(join(HOME, "tui-plugins"), { recursive: true })
    mkdirSync(join(EMBEDDED, "tui-plugins"), { recursive: true })
    rmSync(homeLink, { force: true, recursive: true })
    rmSync(embLink, { force: true, recursive: true })
    symlinkSync(real, homeLink, "dir")
    symlinkSync(real, embLink, "dir")
    const logs: string[] = []
    const loader = await PluginLoader.load({
      embeddedDir: EMBEDDED,
      homeDir: HOME,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_sym"])
    expect(logs.some((l) => l.includes("already loaded"))).toBe(false)
    rmSync(homeLink, { force: true })
    rmSync(embLink, { force: true })
    rmSync(real, { recursive: true, force: true })
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

describe("PluginLoader / liveAreaSlots", () => {
  it("resolves a module-handler slot, applies defaults, and exposes via getLiveAreaSlots()", async () => {
    writePackage(
      HOME,
      "la-mod",
      {
        id: "la-mod",
        name: "la-mod",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "ambient",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            // No position / refreshMs / timeoutMs — exercise the defaults.
          },
        ],
      },
      {
        "prov.ts": `
          export default async function (ctx) {
            return "ambient@" + (ctx?.tick ?? -1)
          }
        `,
      },
    )

    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slots = loader.getLiveAreaSlots()
    expect(slots).toHaveLength(1)
    expect(slots[0]!.pluginId).toBe("la-mod")
    expect(slots[0]!.definition.id).toBe("ambient")
    expect(slots[0]!.definition.position).toBe("footer")
    expect(slots[0]!.definition.refreshMs).toBe(60_000)
    expect(slots[0]!.definition.timeoutMs).toBe(5_000)
    // packageDir points at the actual package dir on disk.
    expect(slots[0]!.packageDir).toBe(join(HOME, "tui-plugins", "la-mod"))
    // Invoke is callable and threads the tick through.
    const out = await slots[0]!.invoke({
      packageDir: slots[0]!.packageDir,
      cwd: process.cwd(),
      env: {},
      abort: new AbortController().signal,
      stderr: process.stderr,
      log: noopLogger(),
      tick: 0,
    })
    expect(out).toBe("ambient@0")

    rmSync(join(HOME, "tui-plugins", "la-mod"), { recursive: true })
  })

  it("logs and skips a slot whose module handler is missing", async () => {
    const logs: string[] = []
    writePackage(HOME, "la-missing", {
      id: "la-missing",
      name: "la-missing",
      version: "0.1.0",
      description: "test",
      liveAreaSlots: [
        {
          id: "x",
          handler: { type: "module", path: "./nope.ts", export: "default" },
        },
      ],
    })
    const loader = await PluginLoader.load({ homeDir: HOME, logger: (m) => logs.push(m) })
    expect(loader.getLiveAreaSlots()).toEqual([])
    expect(logs.some((m) => /live-area slot handler module not found/.test(m))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "la-missing"), { recursive: true })
  })

  it("logs and skips a slot whose module handler has no default export", async () => {
    const logs: string[] = []
    writePackage(
      HOME,
      "la-noexport",
      {
        id: "la-noexport",
        name: "la-noexport",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "prov.ts": "export const named = () => 'nope'",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: (m) => logs.push(m) })
    expect(loader.getLiveAreaSlots()).toEqual([])
    expect(logs.some((m) => /no default export function/.test(m))).toBe(true)
    rmSync(join(HOME, "tui-plugins", "la-noexport"), { recursive: true })
  })

  it("rejects a non-string return from a module handler", async () => {
    writePackage(
      HOME,
      "la-badreturn",
      {
        id: "la-badreturn",
        name: "la-badreturn",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "prov.ts": "export default async function () { return 42 }",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slots = loader.getLiveAreaSlots()
    expect(slots).toHaveLength(1)
    await expect(
      slots[0]!.invoke({
        packageDir: slots[0]!.packageDir,
        cwd: process.cwd(),
        env: {},
        abort: new AbortController().signal,
        stderr: process.stderr,
        log: noopLogger(),
        tick: 0,
      }),
    ).rejects.toThrow(/returned non-string/)
    rmSync(join(HOME, "tui-plugins", "la-badreturn"), { recursive: true })
  })

  it("a slot does NOT count as a tool (separate accessors)", async () => {
    writePackage(
      HOME,
      "la-tool-and-slot",
      {
        id: "la-tool-and-slot",
        name: "la-tool-and-slot",
        version: "0.1.0",
        description: "test",
        tuis: [
          {
            id: "only",
            trigger: {
              type: "tool",
              tool: {
                name: "tool_x",
                description: "x",
                input_schema: { type: "object", properties: {} },
              },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
        liveAreaSlots: [
          {
            id: "ambient",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      {
        "h.ts": TOOL_HANDLER_BODY,
        "prov.ts": "export default async () => 'hi'",
      },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_x"])
    expect(loader.getLiveAreaSlots().map((s) => s.definition.id)).toEqual(["ambient"])
    rmSync(join(HOME, "tui-plugins", "la-tool-and-slot"), { recursive: true })
  })

  it("disabledPluginIds removes the slot too", async () => {
    writePackage(
      HOME,
      "la-disabled",
      {
        id: "la-disabled",
        name: "la-disabled",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
          },
        ],
      },
      { "prov.ts": "export default async () => 'hi'" },
    )
    const loader = await PluginLoader.load({
      homeDir: HOME,
      logger: () => {},
      disabledPluginIds: new Set(["la-disabled"]),
    })
    expect(loader.getLiveAreaSlots()).toEqual([])
    rmSync(join(HOME, "tui-plugins", "la-disabled"), { recursive: true })
  })
})

describe("PluginLoader / liveAreaSlots: placeholder + refreshOn", () => {
  it("threads placeholder through resolution; refreshOn defaults to []", async () => {
    writePackage(
      HOME,
      "la-pl",
      {
        id: "la-pl",
        name: "la-pl",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            placeholder: "loading…",
          },
        ],
      },
      { "prov.ts": "export default async () => 'data'" },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slot = loader.getLiveAreaSlots()[0]!
    expect(slot.definition.placeholder).toBe("loading…")
    expect(slot.definition.refreshOn).toEqual([])
    rmSync(join(HOME, "tui-plugins", "la-pl"), { recursive: true })
  })

  it("normalizes refreshOn", async () => {
    writePackage(
      HOME,
      "la-ro",
      {
        id: "la-ro",
        name: "la-ro",
        version: "0.1.0",
        description: "test",
        liveAreaSlots: [
          {
            id: "x",
            handler: { type: "module", path: "./prov.ts", export: "default" },
            refreshOn: ["a.b", "c.d"],
          },
        ],
      },
      { "prov.ts": "export default async () => 'data'" },
    )
    const loader = await PluginLoader.load({ homeDir: HOME, logger: () => {} })
    const slot = loader.getLiveAreaSlots()[0]!
    expect(slot.definition.refreshOn).toEqual(["a.b", "c.d"])
    rmSync(join(HOME, "tui-plugins", "la-ro"), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// dispatch — external AbortSignal propagation
// ---------------------------------------------------------------------------
//
// REGRESSION GUARD (May 2026): the loader's `dispatch()` used to ignore the
// agent's per-turn AbortSignal entirely — its only abort source was an
// internal AbortController bounded by the handler's manifest `timeoutMs`.
// So when a user pressed Esc / Ctrl+C while a plugin tool (Fetch, WebSearch,
// …) was running, the abort fired on the agent's turn signal but never
// reached `ctx.abort`, leaving the plugin's headless-browser / subprocess
// hung until the manifest timeout (often minutes). User-visible symptom:
// "Running Fetch ⋯ stalled · last byte 15m ago" and Esc/Ctrl+C no-ops.
//
// Fix: `dispatch(trigger, agentCwd, externalSignal?)` accepts the caller's
// AbortSignal and OR-s it with the internal timeout controller, so either
// source aborts `ctx.abort`. Plugin handlers (ma-fetch's `lib/backend.ts`
// etc.) already listen on `ctx.abort` and do SIGTERM→SIGKILL on subprocs.
// ---------------------------------------------------------------------------

const HANGING_HANDLER_BODY = `
export default async function handler(ctx) {
  // Resolve only when ctx.abort fires; otherwise hang forever. This is
  // the canonical shape of plugin handlers that spawn long-running
  // subprocesses (ma-fetch obscura, ma-search browsers, etc.).
  await new Promise((resolve) => {
    if (ctx.abort.aborted) return resolve();
    ctx.abort.addEventListener("abort", () => resolve(), { once: true });
  });
  return {
    kind: "tool_result",
    content: "aborted-via-ctx",
    is_error: true,
  };
}
`

describe("PluginLoader / dispatch external AbortSignal", () => {
  beforeAll(() => {
    mkdirSync(HOME, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
  })
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("aborts an in-flight plugin handler when externalSignal fires", async () => {
    writePackage(HOME, "abrt1", toolManifest("abrt1", "hang_tool", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const ctrl = new AbortController()
    const t0 = Date.now()
    setTimeout(() => ctrl.abort(), 30)
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool",
        input: {},
        tool_use_id: "toolu_abrt1",
      },
      process.cwd(),
      ctrl.signal,
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    // Should resolve within a small window after the 30ms abort fires.
    // Generous upper bound (500ms) to avoid CI flake; the bug had this
    // hang for minutes.
    expect(elapsed).toBeLessThan(500)
    rmSync(join(HOME, "tui-plugins", "abrt1"), { recursive: true })
  })

  it("does not crash when externalSignal is omitted (back-compat)", async () => {
    writePackage(HOME, "abrt2", toolManifest("abrt2", "echo_tool2", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    // No third argument — pre-existing callers must keep working.
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "echo_tool2",
        input: { msg: "hi" },
        tool_use_id: "toolu_abrt2",
      },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toContain("hi")
    rmSync(join(HOME, "tui-plugins", "abrt2"), { recursive: true })
  })

  it("aborts immediately when externalSignal is already aborted on entry", async () => {
    writePackage(HOME, "abrt3", toolManifest("abrt3", "hang_tool3", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const ctrl = new AbortController()
    ctrl.abort() // pre-aborted
    const t0 = Date.now()
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool3",
        input: {},
        tool_use_id: "toolu_abrt3",
      },
      process.cwd(),
      ctrl.signal,
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    expect(elapsed).toBeLessThan(150)
    rmSync(join(HOME, "tui-plugins", "abrt3"), { recursive: true })
  })

  it("internal timeoutMs still works independent of externalSignal", async () => {
    writePackage(HOME, "abrt4", toolManifest("abrt4", "hang_tool4", "./h.ts"), {
      "h.ts": HANGING_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: join(ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      timeoutMs: 80,
    })
    // No externalSignal — should still abort via the internal timeout.
    const t0 = Date.now()
    const result = await loader.dispatch(
      {
        type: "tool",
        name: "hang_tool4",
        input: {},
        tool_use_id: "toolu_abrt4",
      },
      process.cwd(),
    )
    const elapsed = Date.now() - t0
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("aborted-via-ctx")
    expect(elapsed).toBeGreaterThanOrEqual(60)
    expect(elapsed).toBeLessThan(400)
    rmSync(join(HOME, "tui-plugins", "abrt4"), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// manifest.hooks → HookBus wiring (May 2026)
// ---------------------------------------------------------------------------
//
// Adds support for `manifest.hooks` (module-handler subscriptions on
// chain/broadcast-sync/stream channels). Permission-gated by the
// channel's `permission` against the manifest's `permissions[]`.
// ---------------------------------------------------------------------------

const SYNC_HOOK_HANDLER_BODY = `
export default function handler(payload, ctx) {
  // Mutate a holder field — that's the broadcast-sync pattern for
  // returning data without making the dispatcher async.
  if (payload && typeof payload === "object" && "result" in payload) {
    payload.result.handled = true;
    payload.result.from = ctx.channel + ":" + ctx.priority;
  }
}
`

describe("PluginLoader / manifest.hooks", () => {
  const HOOK_ROOT = resolve(__dirname, "../../tmp/loader-hook-tests")
  const HOOK_HOME = join(HOOK_ROOT, "home")
  const HOOK_PROJECT = join(HOOK_ROOT, "project")

  beforeAll(() => {
    mkdirSync(HOOK_HOME, { recursive: true })
    mkdirSync(HOOK_PROJECT, { recursive: true })
  })
  afterAll(() => {
    rmSync(HOOK_ROOT, { recursive: true, force: true })
  })

  it("subscribes a module hook on a broadcast-sync channel", async () => {
    writePackage(
      HOOK_HOME,
      "hk1",
      {
        id: "hk1",
        name: "hk1",
        version: "0.1.0",
        description: "test",
        events: [
          {
            id: "noop",
            on: "prompt.submitted",
            handler: { type: "module", path: "./noop.ts", export: "default" },
          },
        ],
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      {
        "noop.ts": "export default async function() {}",
        "key.ts": SYNC_HOOK_HANDLER_BODY,
      },
    )
    const loader = await PluginLoader.load({
      homeDir: HOOK_HOME,
      projectDir: join(HOOK_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })
    const subs = loader.getHookSubs()
    expect(subs.length).toBe(1)
    expect(subs[0].pluginId).toBe("hk1")
    expect(subs[0].sub.definition.channel).toBe("editor.key")

    // End-to-end: emitting on the channel runs the plugin handler.
    const holder = { handled: false, from: "" }
    loader.hooks().emitSync("editor.key", { key: "Up", result: holder })
    expect(holder.handled).toBe(true)
    expect(holder.from).toBe("editor.key:50") // default plugin priority
    rmSync(join(HOOK_HOME, "tui-plugins", "hk1"), { recursive: true })
  })

  it("skips a hook subscription missing required permission", async () => {
    const logs: string[] = []
    writePackage(
      HOOK_HOME,
      "hk2",
      {
        id: "hk2",
        name: "hk2",
        version: "0.1.0",
        description: "test",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        // missing permissions
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )
    const loader = await PluginLoader.load({
      homeDir: HOOK_HOME,
      projectDir: join(HOOK_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getHookSubs().length).toBe(0)
    expect(logs.some((l) => l.includes("permissions doesn't grant"))).toBe(true)
    rmSync(join(HOOK_HOME, "tui-plugins", "hk2"), { recursive: true })
  })

  it("skips hooks for plugins with requiresUnsafeHooks when UNSAFE_HOOKS is unset", async () => {
    const prior = process.env.UNSAFE_HOOKS
    delete process.env.UNSAFE_HOOKS
    const logs: string[] = []
    writePackage(
      HOOK_HOME,
      "hk3",
      {
        id: "hk3",
        name: "hk3",
        version: "0.1.0",
        description: "test",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
        requiresUnsafeHooks: true,
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )
    const loader = await PluginLoader.load({
      homeDir: HOOK_HOME,
      projectDir: join(HOOK_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getHookSubs().length).toBe(0)
    expect(logs.some((l) => l.includes("UNSAFE_HOOKS=1 is not set"))).toBe(true)
    rmSync(join(HOOK_HOME, "tui-plugins", "hk3"), { recursive: true })
    if (prior !== undefined) process.env.UNSAFE_HOOKS = prior
  })

  it("logs and skips subprocess hook handlers (not yet supported)", async () => {
    const logs: string[] = []
    writePackage(
      HOOK_HOME,
      "hk4",
      {
        id: "hk4",
        name: "hk4",
        version: "0.1.0",
        description: "test",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "subprocess", command: ["./exe.sh"] },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "exe.sh": "#!/bin/sh\nexit 0\n" },
    )
    // Make exe executable so the manifest parser doesn't reject it
    // for unrelated reasons.
    chmodSync(join(HOOK_HOME, "tui-plugins", "hk4", "exe.sh"), 0o755)
    const loader = await PluginLoader.load({
      homeDir: HOOK_HOME,
      projectDir: join(HOOK_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getHookSubs().length).toBe(0)
    expect(logs.some((l) => l.includes("subprocess handlers are not yet supported"))).toBe(true)
    rmSync(join(HOOK_HOME, "tui-plugins", "hk4"), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// Silent plugins: PROMPT.md is OPTIONAL.
//
// A plugin that contributes only editor hooks, live-area slots, events, or
// other UX-layer behavior has nothing to teach the model. It should ship
// NO `PROMPT.md` at all (no HTML-comment placeholder, no empty file). The
// loader recognizes this and omits the `<plugin id="...">` wrapper for
// that plugin in the assembled system-prompt block.
//
// Critically, the loader must NOT fall back to `manifest.description` for
// silent plugins. The description is developer metadata, and surfacing it
// in the cached system prompt would defeat the whole point of skipping.
// ---------------------------------------------------------------------------

describe("PluginLoader / silent plugins (no PROMPT.md)", () => {
  const SILENT_ROOT = resolve(__dirname, "../../tmp/loader-silent-tests")
  const SILENT_HOME = join(SILENT_ROOT, "home")

  beforeAll(() => {
    rmSync(SILENT_ROOT, { recursive: true, force: true })
    mkdirSync(SILENT_HOME, { recursive: true })
  })
  afterAll(() => {
    rmSync(SILENT_ROOT, { recursive: true, force: true })
  })

  it("omits the <plugin> wrapper when a plugin has no PROMPT.md and no fragments", async () => {
    // Hooks-only manifest, history-style. No PROMPT.md.
    writePackage(
      SILENT_HOME,
      "silent_a",
      {
        id: "silent_a",
        name: "silent_a",
        version: "0.1.0",
        description: "this dev-doc description must NOT leak into the system prompt",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )
    // A second, model-facing plugin so the outer <tui-plugins> wrapper is
    // still emitted and we can assert the silent one is absent inside.
    writePackage(SILENT_HOME, "loud_a", toolManifest("loud_a", "tool_loud_a", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": PROMPT_BODY_A,
    })

    const loader = await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })

    const block = loader.getPromptBlock()
    expect(block).toBeString()
    expect(block).toContain('<plugin id="loud_a">')
    expect(block).toContain(PROMPT_BODY_A)
    expect(block).not.toContain('<plugin id="silent_a">')
    expect(block).not.toContain("this dev-doc description must NOT leak")
    rmSync(join(SILENT_HOME, "tui-plugins", "silent_a"), { recursive: true })
    rmSync(join(SILENT_HOME, "tui-plugins", "loud_a"), { recursive: true })
  })

  it("returns null when every loaded plugin is silent", async () => {
    writePackage(
      SILENT_HOME,
      "silent_b",
      {
        id: "silent_b",
        name: "silent_b",
        version: "0.1.0",
        description: "must not leak",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )

    const loader = await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
    })

    expect(loader.getPromptBlock()).toBeNull()
    expect(await loader.getPromptBlockAsync()).toBeNull()
    rmSync(join(SILENT_HOME, "tui-plugins", "silent_b"), { recursive: true })
  })

  it("warns when manifest.prompt is explicitly set but the file is missing", async () => {
    // Author explicitly opted into a PROMPT.md they forgot to create.
    writePackage(
      SILENT_HOME,
      "ghost",
      {
        id: "ghost",
        name: "ghost",
        version: "0.1.0",
        description: "must not leak",
        prompt: "./PROMPT.md",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )

    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })

    expect(logs.some((l) => l.includes("PROMPT.md") && l.includes("missing"))).toBe(true)
    expect(loader.getPromptBlock()).toBeNull()
    rmSync(join(SILENT_HOME, "tui-plugins", "ghost"), { recursive: true })
  })

  it("warns when a manifest declares no contributions AND ships no PROMPT.md", async () => {
    // Dead-weight plugin: passes manifest validation (the validator
    // dropped the 'at least one contribution' gate) but contributes
    // literally nothing. Should still load, but the loader needs to
    // surface a diagnostic so an unfinished/typo'd plugin doesn't sit
    // there silently doing nothing.
    writePackage(
      SILENT_HOME,
      "deadweight",
      {
        id: "deadweight",
        name: "deadweight",
        version: "0.1.0",
        description: "loads but does nothing",
      },
      {}, // no files: no PROMPT.md, no handlers
    )

    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })

    expect(
      logs.some(
        (l) =>
          l.includes("deadweight") &&
          l.includes("declares no contributions") &&
          l.includes("no PROMPT.md"),
      ),
    ).toBe(true)
    // It still loads (we don't reject), just contributes nothing.
    expect(loader.getPromptBlock()).toBeNull()
    rmSync(join(SILENT_HOME, "tui-plugins", "deadweight"), { recursive: true })
  })

  it("does NOT warn (dead-weight) when a plugin has hooks but no PROMPT.md", async () => {
    // Hooks-only is a legitimate shape (history, ma-slash-menu). Should
    // load silently in the system prompt, no dead-weight diagnostic.
    writePackage(
      SILENT_HOME,
      "hooks_only",
      {
        id: "hooks_only",
        name: "hooks_only",
        version: "0.1.0",
        description: "tests",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )

    const logs: string[] = []
    await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })

    expect(logs.some((l) => l.includes("declares no contributions"))).toBe(false)
    rmSync(join(SILENT_HOME, "tui-plugins", "hooks_only"), { recursive: true })
  })

  it("does NOT warn when PROMPT.md is absent and manifest.prompt is unset", async () => {
    // No `prompt` field in the manifest → absence of PROMPT.md is the
    // intentional silent-plugin path. We must not bother the operator.
    writePackage(
      SILENT_HOME,
      "quiet",
      {
        id: "quiet",
        name: "quiet",
        version: "0.1.0",
        description: "must not leak",
        hooks: [
          {
            id: "key",
            channel: "editor.key",
            handler: { type: "module", path: "./key.ts", export: "default" },
          },
        ],
        permissions: ["hooks:editor.key"],
      },
      { "key.ts": SYNC_HOOK_HANDLER_BODY },
    )

    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: SILENT_HOME,
      projectDir: join(SILENT_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })

    expect(logs.some((l) => l.includes("PROMPT.md") && l.includes("missing"))).toBe(false)
    expect(loader.getPromptBlock()).toBeNull()
    rmSync(join(SILENT_HOME, "tui-plugins", "quiet"), { recursive: true })
  })
})

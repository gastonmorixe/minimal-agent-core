import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

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

const THROWING_HANDLER_BODY = `
export default async function handler(ctx) {
  throw new Error("boom");
}
`

const PROMPT_BODY_B = "Use tool_b when the user asks for thing B."

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
    // A tool plugin composes into a role-named <ma::sys::tool> section keyed
    // by the TOOL name, not the plugin id. The word "plugin" never appears.
    expect(prompt).toContain('<ma::sys::tool name="tool_a">')
    expect(prompt).toContain("</ma::sys::tool>")
    expect(prompt).toContain(PROMPT_BODY_A)
    expect(prompt).not.toContain("ma::plugin")
    expect(prompt).not.toContain("alpha")
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
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: HOME,
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    const tools = loader.getExtraTools()
    expect(tools.map((t) => t.name)).toEqual(["tool_project"])
    rmSync(join(HOME, "plugins", "beta"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "plugins", "beta"), { recursive: true })
  })

  it("skips a package whose manifest is malformed", async () => {
    const dir = join(HOME, "plugins", "broken")
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
    rmSync(join(HOME, "plugins", "good"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "evil"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "first"), { recursive: true })
    rmSync(join(HOME, "plugins", "second"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "ia"), { recursive: true })
    rmSync(join(HOME, "plugins", "ib"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "d1"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "d2"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "d3"), { recursive: true })
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
    // No outer wrapper, no overview, no "plugin" framing: each contribution
    // is a self-delimiting role-named section keyed by the tool name.
    expect(block).not.toContain("ma::plugin")
    expect(block).toContain('<ma::sys::tool name="tool_a">')
    expect(block).toContain('<ma::sys::tool name="tool_b">')
    expect(block).toContain(PROMPT_BODY_A)
    expect(block).toContain(PROMPT_BODY_B)
    // Deterministic ordering: tool_a sorts before tool_b within the role.
    expect(block!.indexOf("tool_a")).toBeLessThan(block!.indexOf("tool_b"))
    rmSync(join(HOME, "plugins", "pa"), { recursive: true })
    rmSync(join(HOME, "plugins", "pb"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "sp"), { recursive: true })
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
    rmSync(join(EMBEDDED, "plugins", "emb1"), { recursive: true })
  })

  it("project plugins live at <projectDir>/.agents/plugins/, not <projectDir>/plugins/", async () => {
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
      ".agents/plugins",
    )
    const loader = await PluginLoader.load({
      homeDir: join(ROOT, "nope-home"),
      projectDir: PROJECT,
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.hasTool("tool_new")).toBe(true)
    expect(loader.hasTool("tool_old")).toBe(false)
    rmSync(join(PROJECT, "plugins", "old_path"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "plugins", "new_path"), { recursive: true })
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
      ".agents/plugins",
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
    rmSync(join(EMBEDDED, "plugins", "e_only"), { recursive: true })
    rmSync(join(HOME, "plugins", "h_only"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "plugins", "p_only"), { recursive: true })
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
    const names = loader.getExtraTools().map((t) => t.name)
    expect(names).toEqual(["tool_project"])
    // Both home and embedded variants were skipped with a precedence note.
    expect(logs.filter((l) => l.includes('"shared"')).length).toBeGreaterThanOrEqual(2)
    expect(logs.some((l) => l.includes("project > home > user > embedded"))).toBe(true)
    rmSync(join(EMBEDDED, "plugins", "shared"), { recursive: true })
    rmSync(join(HOME, "plugins", "shared"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "plugins", "shared"), { recursive: true })
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
    rmSync(join(EMBEDDED, "plugins", "two_way"), { recursive: true })
    rmSync(join(HOME, "plugins", "two_way"), { recursive: true })
  })

  // Reproduces the user-reported bug where running minimal-agent from
  // `$HOME` made the loader scan `cwd/.agents/plugins` (= project)
  // AND `$HOME/.agents/plugins` (= home) — the same physical
  // directory through two different roots. The pre-fix loader emitted a
  // spurious "already loaded" warning for every plugin inside; the
  // post-fix loader silently keeps the highest-precedence copy and the
  // warning never fires.
  it("deduplicates by realpath when project and home roots overlap (cwd=$HOME case)", async () => {
    // PROJECT-as-cwd points at HOME, so projectDir/.agents/plugins ===
    // homeDir/plugins. We don't need symlinks for this scenario; just
    // pass homeDir=HOME and projectDir=parent(HOME-plugins-prefix).
    // Concretely: project's `.agents/plugins` and home's `plugins`
    // are the SAME directory.
    const overlapRoot = join(ROOT, "overlap")
    rmSync(overlapRoot, { recursive: true, force: true })
    mkdirSync(overlapRoot, { recursive: true })
    // The shared plugin dir lives at: <overlapRoot>/.agents/plugins/shared
    // Reachable two ways:
    //   homeDir = <overlapRoot>/.agents  → scans .agents/plugins
    //   projectDir = <overlapRoot>       → scans .agents/plugins
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
    // Loaded exactly once.
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_overlap"])
    // No "already loaded" warning — the pre-fix loader emitted one here
    // and it bled into the user's startup banner box.
    expect(logs.some((l) => l.includes("already loaded"))).toBe(false)
    rmSync(overlapRoot, { recursive: true, force: true })
  })

  // Symlink variant: a plugin author can keep their dev checkout at an
  // arbitrary location (e.g. `~/Projects/foo-plugin`) and surface it
  // under both `~/.agents/plugins/foo-plugin` AND the embedded
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
    // Surface the same physical dir under both home/plugins AND
    // embedded/plugins via symlinks.
    const homeLink = join(HOME, "plugins", "sym_pkg")
    const embLink = join(EMBEDDED, "plugins", "sym_pkg")
    mkdirSync(join(HOME, "plugins"), { recursive: true })
    mkdirSync(join(EMBEDDED, "plugins"), { recursive: true })
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

  // Reproduces the EXACT user-reported startup-banner noise: the same
  // plugins repo present under TWO roots with DISTINCT realpaths (home
  // root symlinked into one checkout, user root a second independent
  // checkout of the same repo). The realpath dedup can't collapse them
  // (different files on disk), so the lower-precedence copy correctly
  // falls through to the id-shadow skip. The bug was that skip shouted
  // through `diag.warn` — Severity.Warning — which renders the gold ⚠
  // chrome straight into the startup banner box on every launch.
  //
  // This test exercises the PRODUCTION path (no injected `logger`, so the
  // loader's default falls back to the singleton diagnostic bus) and
  // asserts the shadow is announced at Notice severity (file log only),
  // never at Warning. The two precedence tests above still cover the
  // injected-logger contract; this one guards the bus severity that the
  // banner sink actually filters on.
  it("id-shadow skip emits Notice (not Warning) on the default bus path", async () => {
    // Two physically distinct dirs, same manifest id, surfaced through
    // home (precedence 3) and user (precedence 2). Home wins; the user
    // copy hits the seenIds shadow gate. Their realpaths differ, so the
    // realpath dedup above leaves both in play and the shadow branch runs.
    const USER = join(ROOT, "user-shadow")
    rmSync(USER, { recursive: true, force: true })
    writePackage(HOME, "dup_shadow", toolManifest("dup_shadow", "tool_dup", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
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
        // No `logger` — exercise the real production default (diag bus).
      })
      // Loaded exactly once (home wins on precedence).
      expect(loader.getExtraTools().map((t) => t.name)).toEqual(["tool_dup"])
    } finally {
      unsubscribe()
    }

    const shadow = events.filter(
      (e) => e.source === "plugin-loader" && e.message.includes("already loaded"),
    )
    // The shadow WAS announced...
    expect(shadow.length).toBeGreaterThanOrEqual(1)
    // ...as a Notice, and NEVER as a Warning (the banner-box noise).
    expect(shadow.every((e) => e.severity === Severity.Notice)).toBe(true)
    expect(shadow.some((e) => e.severity === Severity.Warning)).toBe(false)

    rmSync(join(HOME, "plugins", "dup_shadow"), { recursive: true, force: true })
    rmSync(USER, { recursive: true, force: true })
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
    rmSync(join(HOME, "plugins", "kept"), { recursive: true })
    rmSync(join(HOME, "plugins", "dropped"), { recursive: true })
  })

  it("manifest.enabled=false skips the plugin (author opt-out)", async () => {
    const optOut = toolManifest("optout", "tool_optout", "./h.ts")
    optOut.enabled = false
    writePackage(HOME, "optout", optOut, { "h.ts": TOOL_HANDLER_BODY })
    writePackage(HOME, "live", toolManifest("live", "tool_live", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })

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
    rmSync(join(HOME, "plugins", "optout"), { recursive: true })
    rmSync(join(HOME, "plugins", "live"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "optin"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "standoff"), { recursive: true })
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
    rmSync(join(HOME, "plugins", "aliased_pkg"), { recursive: true })
  })

  it("alias collision: alias collides with another plugin's canonical → drop alias", async () => {
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
    ).toEqual(["Tool_A", "Tool_B"])
    expect(logs.some((l) => l.includes('alias "Tool_A"') && l.includes("canonical"))).toBe(true)
    rmSync(join(HOME, "plugins", "pkg_a"), { recursive: true })
    rmSync(join(HOME, "plugins", "pkg_b"), { recursive: true })
  })

  it("alias collision: alias collides with another plugin's alias → drop alias", async () => {
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
    // First-loaded plugin keeps its alias; second plugin drops the alias but is still loaded.
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Tool_X", "Tool_Y"])
    expect(loader.getToolAliases().has("legacy")).toBe(true)
    expect(logs.some((l) => l.includes('alias "legacy"'))).toBe(true)
    rmSync(join(HOME, "plugins", "pkg_x"), { recursive: true })
    rmSync(join(HOME, "plugins", "pkg_y"), { recursive: true })
  })

  it("alias collision: alias collides with a core tool name → drop alias", async () => {
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
    expect(
      loader
        .getExtraTools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(["Tool_Z"])
    expect(loader.getToolAliases().has("Bash")).toBe(false)
    expect(logs.some((l) => l.includes('alias "Bash"'))).toBe(true)
    rmSync(join(HOME, "plugins", "alias_core"), { recursive: true })
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
    rmSync(join(EMBEDDED, "plugins", "shared2"), { recursive: true })
    rmSync(join(HOME, "plugins", "shared2"), { recursive: true })
    rmSync(join(PROJECT, ".agents", "plugins", "shared2"), { recursive: true })
  })
})

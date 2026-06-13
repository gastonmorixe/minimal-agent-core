import { chmodSync, mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  CORE_TOOLS,
  INLINE_HANDLER_BODY,
  inlineManifest,
  PROMPT_BODY_A,
  TOOL_HANDLER_BODY,
  toolManifest,
  writePackage,
} from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

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
    rmSync(join(HOOK_HOME, "plugins", "hk1"), { recursive: true })
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
    rmSync(join(HOOK_HOME, "plugins", "hk2"), { recursive: true })
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
    rmSync(join(HOOK_HOME, "plugins", "hk3"), { recursive: true })
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
    chmodSync(join(HOOK_HOME, "plugins", "hk4", "exe.sh"), 0o755)
    const loader = await PluginLoader.load({
      homeDir: HOOK_HOME,
      projectDir: join(HOOK_ROOT, "nope-project"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.getHookSubs().length).toBe(0)
    expect(logs.some((l) => l.includes("subprocess handlers are not yet supported"))).toBe(true)
    rmSync(join(HOOK_HOME, "plugins", "hk4"), { recursive: true })
  })
})

// ---------------------------------------------------------------------------
// Silent plugins: PROMPT.md is OPTIONAL.
//
// A plugin that contributes only editor hooks, live-area slots, events, or
// other UX-layer behavior has nothing to teach the model. It should ship
// NO `PROMPT.md` at all (no HTML-comment placeholder, no empty file). The
// loader recognizes this and omits the `<ma::plugin id="...">` wrapper for
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
    // A second, model-facing plugin so the block is non-null and we can
    // assert the silent one contributes no section.
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
    expect(block).toContain('<ma::sys::tool name="tool_loud_a">')
    expect(block).toContain(PROMPT_BODY_A)
    // The silent plugin contributes nothing: neither its id nor its
    // dev-doc description leaks into the composed prompt.
    expect(block).not.toContain("silent_a")
    expect(block).not.toContain("this dev-doc description must NOT leak")
    rmSync(join(SILENT_HOME, "plugins", "silent_a"), { recursive: true })
    rmSync(join(SILENT_HOME, "plugins", "loud_a"), { recursive: true })
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
    rmSync(join(SILENT_HOME, "plugins", "silent_b"), { recursive: true })
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
    rmSync(join(SILENT_HOME, "plugins", "ghost"), { recursive: true })
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
    rmSync(join(SILENT_HOME, "plugins", "deadweight"), { recursive: true })
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
    rmSync(join(SILENT_HOME, "plugins", "hooks_only"), { recursive: true })
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
    rmSync(join(SILENT_HOME, "plugins", "quiet"), { recursive: true })
  })
})

describe("PluginLoader / prompt role composition (<ma::sys::ROLE>)", () => {
  const ROLE_ROOT = resolve(__dirname, "../../tmp/loader-role-tests")
  const ROLE_HOME = join(ROLE_ROOT, "home")

  beforeAll(() => {
    rmSync(ROLE_ROOT, { recursive: true, force: true })
    mkdirSync(ROLE_HOME, { recursive: true })
  })
  afterAll(() => rmSync(ROLE_ROOT, { recursive: true, force: true }))

  it("composes one section per role, ordered behavior < tool < emit < mode < context", async () => {
    // behavior: PROMPT.md only, no contributions. name = slug(H1).
    writePackage(
      ROLE_HOME,
      "beh",
      { id: "beh", name: "Beh", version: "0.1.0", description: "d" },
      {
        "PROMPT.md": "# My Rules\n\nAlways do the thing.",
      },
    )
    // tool: name = tool name.
    writePackage(ROLE_HOME, "too", toolManifest("too", "ZTool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "Use ZTool wisely.",
    })
    // emit: inline-tag only. name = tag.
    writePackage(ROLE_HOME, "emt", inlineManifest("emt", "mytag", "./h.ts"), {
      "h.ts": INLINE_HANDLER_BODY,
      "PROMPT.md": "Emit mytag to do X.",
    })
    // mode: name = mode id.
    writePackage(
      ROLE_HOME,
      "mod",
      {
        id: "mod",
        name: "Mod",
        version: "0.1.0",
        description: "d",
        modes: [{ id: "zen", label: "ZEN" }],
      },
      { "PROMPT.md": "In zen mode, breathe." },
    )
    // context: PROMPT.md + a prompt fragment → context. name = slug(H1).
    writePackage(
      ROLE_HOME,
      "ctx",
      {
        id: "ctx",
        name: "Ctx",
        version: "0.1.0",
        description: "d",
        promptFragments: [
          { id: "f", handler: { type: "module", path: "./f.ts", export: "default" } },
        ],
      },
      { "PROMPT.md": "# Ambient\n\nReference data.", "f.ts": "export default async () => ''" },
    )

    const loader = await PluginLoader.load({
      homeDir: ROLE_HOME,
      projectDir: join(ROLE_ROOT, "nope"),
      coreToolNames: CORE_TOOLS,
    })
    const block = loader.getPromptBlock()!
    expect(block).toBeString()

    // Each role rendered with the right wrapper + name.
    expect(block).toContain('<ma::sys::behavior name="my-rules">')
    expect(block).toContain('<ma::sys::tool name="ZTool">')
    expect(block).toContain('<ma::sys::emit name="mytag">')
    expect(block).toContain('<ma::sys::mode name="zen">')
    expect(block).toContain('<ma::sys::context name="ambient">')

    // Ordering: behavior < tool < emit < mode < context.
    const order = ["my-rules", "ZTool", "mytag", "zen", "ambient"].map((n) => block.indexOf(n))
    expect(order).toEqual([...order].sort((a, b) => a - b))

    // No plugin framing leaks.
    expect(block).not.toContain("ma::plugin")
    expect(block).not.toContain("<ma::plugins>")

    rmSync(ROLE_HOME, { recursive: true })
    mkdirSync(ROLE_HOME, { recursive: true })
  })

  it("disambiguates a same-(role,name) collision with a numeric suffix", async () => {
    // Two behavior plugins whose H1 slugs collide.
    writePackage(
      ROLE_HOME,
      "r1",
      { id: "r1", name: "R1", version: "0.1.0", description: "d" },
      {
        "PROMPT.md": "# Rules\n\nFirst set.",
      },
    )
    writePackage(
      ROLE_HOME,
      "r2",
      { id: "r2", name: "R2", version: "0.1.0", description: "d" },
      {
        "PROMPT.md": "# Rules\n\nSecond set.",
      },
    )
    const loader = await PluginLoader.load({
      homeDir: ROLE_HOME,
      projectDir: join(ROLE_ROOT, "nope"),
      coreToolNames: CORE_TOOLS,
    })
    const block = loader.getPromptBlock()!
    expect(block).toContain('<ma::sys::behavior name="rules">')
    expect(block).toContain('<ma::sys::behavior name="rules-2">')
    // Both bodies present, each in its own section.
    expect(block).toContain("First set.")
    expect(block).toContain("Second set.")
    rmSync(ROLE_HOME, { recursive: true })
    mkdirSync(ROLE_HOME, { recursive: true })
  })
})

describe("PluginLoader — tool availability (context-gated advertisement)", () => {
  const AROOT = resolve(__dirname, "../../tmp/loader-avail-tests")
  const AHOME = join(AROOT, "home")

  beforeAll(() => {
    rmSync(AROOT, { recursive: true, force: true })
    mkdirSync(AHOME, { recursive: true })
  })
  afterAll(() => rmSync(AROOT, { recursive: true, force: true }))

  // A handler module that exports an `available` predicate gated on an env flag.
  const GATED_HANDLER = `
export default async function handler() {
  return { kind: "tool_result", content: "ran" };
}
export const available = (ctx) => ctx.env.SHOW_GATED === "1";
`

  async function loadGated() {
    rmSync(join(AHOME, "plugins"), { recursive: true, force: true })
    writePackage(AHOME, "gated", toolManifest("gated", "gated_tool", "./h.ts"), {
      "h.ts": GATED_HANDLER,
      "PROMPT.md": "Use gated_tool when available.",
    })
    return PluginLoader.load({
      homeDir: AHOME,
      projectDir: join(AROOT, "nope"),
      coreToolNames: CORE_TOOLS,
    })
  }

  it("hides the tool from getExtraTools when available() returns false", async () => {
    const prev = process.env.SHOW_GATED
    delete process.env.SHOW_GATED
    try {
      const loader = await loadGated()
      expect(loader.getExtraTools().map((t) => t.name)).not.toContain("gated_tool")
      // dispatchable regardless of advertisement
      expect(loader.hasTool("gated_tool")).toBe(true)
      // and the single-tool plugin's prompt section is dropped too
      expect(loader.getPromptBlock() ?? "").not.toContain("Use gated_tool")
    } finally {
      if (prev !== undefined) process.env.SHOW_GATED = prev
    }
  })

  it("advertises the tool (and its prompt) when available() returns true", async () => {
    const prev = process.env.SHOW_GATED
    process.env.SHOW_GATED = "1"
    try {
      const loader = await loadGated()
      expect(loader.getExtraTools().map((t) => t.name)).toContain("gated_tool")
      expect(loader.getPromptBlock() ?? "").toContain("Use gated_tool")
    } finally {
      if (prev === undefined) delete process.env.SHOW_GATED
      else process.env.SHOW_GATED = prev
    }
  })

  it("still DISPATCHES a hidden tool (availability gates advertisement, not execution)", async () => {
    const prev = process.env.SHOW_GATED
    delete process.env.SHOW_GATED
    try {
      const loader = await loadGated()
      const res = await loader.dispatch(
        { type: "tool", name: "gated_tool", input: {}, tool_use_id: "t1" },
        process.cwd(),
      )
      expect(res.kind).toBe("tool_result")
      if (res.kind === "tool_result") expect(res.content).toContain("ran")
    } finally {
      if (prev !== undefined) process.env.SHOW_GATED = prev
    }
  })

  it("a tool with NO available export is always advertised (back-compat)", async () => {
    rmSync(join(AHOME, "plugins"), { recursive: true, force: true })
    writePackage(AHOME, "plain", toolManifest("plain", "plain_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const loader = await PluginLoader.load({
      homeDir: AHOME,
      projectDir: join(AROOT, "nope"),
      coreToolNames: CORE_TOOLS,
    })
    expect(loader.getExtraTools().map((t) => t.name)).toContain("plain_tool")
  })
})

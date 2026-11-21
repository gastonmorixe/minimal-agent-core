/**
 * Prompt-TEXT suppression tests for `PluginLoader`.
 *
 * Suppression (`PluginLoaderOptions.pluginPrompts`) drops TEXT only. A
 * suppressed plugin still loads, still advertises its tools, and still RUNS
 * its prompt fragments (the skills plugin registers dynamic tools from its
 * fragment), so the tool must still be there while the text is gone.
 * Suppression is per plugin id, never a blanket null.
 *
 * Kept in its own file because `loader.prompt.test.ts` sits at the
 * `max-lines` lint budget.
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { withSidebandCodec } from "../test-utils/sideband-fixture.ts"

import { CORE_TOOLS, TOOL_HANDLER_BODY, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import type { PluginPromptSuppression } from "./plugin-prompt-resolution.ts"

const SUPP_ROOT = resolve(__dirname, "../../tmp/loader-suppress-tests")
const SUPP_HOME = join(SUPP_ROOT, "home")

/** A prompt-fragment producer that registers a dynamic tool, like the skills plugin. */
const DYNAMIC_TOOL_FRAGMENT = `
export default async function handler(ctx) {
  ctx.registerDynamicTools([{
    definition: {
      id: "dyn_skill",
      interactive: false,
      trigger: {
        type: "tool",
        tool: {
          name: "dyn_skill_tool",
          description: "Registered by a prompt fragment",
          input_schema: { type: "object", properties: {} },
          explicitName: true,
        },
      },
      handler: { type: "module", path: "./f.ts", export: "default" },
    },
    entryAbsolute: __filename,
    invoke: async () => ({ kind: "tool_result", content: "dynamic ok" }),
  }]);
  return "DYNAMIC_FRAGMENT_TEXT";
}
`

/** Build a suppression value from a list of suppressed ids. */
function suppression(suppressIds: string[], all = false): PluginPromptSuppression {
  return { all, suppress: new Set(suppressIds), keep: new Set<string>() }
}

/** Load the fixture user root with the optional suppression option. */
function load(pluginPrompts?: PluginPromptSuppression) {
  return PluginLoader.load(
    withSidebandCodec({
      userDir: SUPP_HOME,
      roots: { project: [join(SUPP_ROOT, "nope", ".agents", "plugins")] },
      coreToolNames: CORE_TOOLS,
      ...(pluginPrompts ? { pluginPrompts } : {}),
    }),
  )
}

/** Reset the fixture plugin dir between tests. */
function cleanPlugins() {
  rmSync(join(SUPP_HOME, "plugins"), { recursive: true, force: true })
  mkdirSync(SUPP_HOME, { recursive: true })
}

describe("PluginLoader / prompt-text suppression", () => {
  beforeAll(() => {
    rmSync(SUPP_ROOT, { recursive: true, force: true })
    mkdirSync(SUPP_HOME, { recursive: true })
  })
  afterAll(() => rmSync(SUPP_ROOT, { recursive: true, force: true }))

  it("drops the PROMPT.md section but keeps the tool advertised", async () => {
    cleanPlugins()
    writePackage(SUPP_HOME, "prompted", toolManifest("prompted", "prompted_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "SUPPRESSED_PROMPT_BODY should not reach the model.",
    })
    const loader = await load(suppression(["prompted"]))
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toBeNull()
    expect(blocks.afterInstructions).toBeNull()
    expect(loader.getExtraTools().map((t) => t.name)).toContain("prompted_tool")
    expect(loader.hasTool("prompted_tool")).toBe(true)
  })

  it("drops a sessionContext fragment text for a suppressed id", async () => {
    cleanPlugins()
    writePackage(
      SUPP_HOME,
      "ctx_frag",
      {
        id: "ctx_frag",
        name: "ctx_frag",
        version: "0.1.0",
        description: "d",
        promptFragments: [
          { id: "ambient", handler: { type: "module", path: "./f.ts", export: "default" } },
        ],
      },
      {
        "PROMPT.md": "# Ctx\n\nSUPPRESSED_STATIC_FRAMING.",
        "f.ts": "export default async () => 'SUPPRESSED_SESSION_FRAGMENT'",
      },
    )
    const loader = await load(suppression(["ctx_frag"]))
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toBeNull()
  })

  it("drops an afterInstructions fragment text for a suppressed id", async () => {
    cleanPlugins()
    writePackage(
      SUPP_HOME,
      "ai_frag",
      {
        id: "ai_frag",
        name: "ai_frag",
        version: "0.1.0",
        description: "d",
        promptFragments: [
          {
            id: "guidance",
            handler: { type: "module", path: "./f.ts", export: "default" },
            placement: "afterInstructions",
          },
        ],
      },
      { "f.ts": "export default async () => 'SUPPRESSED_AFTER_INSTRUCTIONS'" },
    )
    const loader = await load(suppression(["ai_frag"]))
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.afterInstructions).toBeNull()
  })

  it("still registers a dynamic tool from a suppressed fragment", async () => {
    cleanPlugins()
    writePackage(
      SUPP_HOME,
      "dyn",
      {
        id: "dyn",
        name: "dyn",
        version: "0.1.0",
        description: "d",
        promptFragments: [
          {
            id: "skills",
            handler: { type: "module", path: "./f.ts", export: "default" },
            placement: "afterInstructions",
          },
        ],
      },
      { "f.ts": DYNAMIC_TOOL_FRAGMENT },
    )
    const loader = await load(suppression(["dyn"]))
    const blocks = await loader.getPromptBlocksAsync()
    // Text is gone.
    expect(blocks.afterInstructions).toBeNull()
    // But the fragment RAN and registered its tool.
    expect(loader.getExtraTools().map((t) => t.name)).toContain("dyn_skill_tool")
    expect(loader.hasTool("dyn_skill_tool")).toBe(true)
  })

  it("suppressing one id does not silence a different plugin", async () => {
    cleanPlugins()
    writePackage(SUPP_HOME, "quiet_one", toolManifest("quiet_one", "quiet_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "QUIET_ONE_TEXT must not reach the model.",
    })
    writePackage(SUPP_HOME, "loud_one", toolManifest("loud_one", "loud_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "LOUD_ONE_TEXT must reach the model.",
    })
    const loader = await load(suppression(["quiet_one"]))
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toBeString()
    expect(blocks.sessionContext).toContain("LOUD_ONE_TEXT")
    expect(blocks.sessionContext).not.toContain("QUIET_ONE_TEXT")
    expect(loader.getExtraTools().map((t) => t.name)).toEqual(
      expect.arrayContaining(["quiet_tool", "loud_tool"]),
    )
  })

  it("all=true suppresses every plugin's text, keep still wins for one", async () => {
    cleanPlugins()
    writePackage(SUPP_HOME, "keep_me", toolManifest("keep_me", "keep_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "KEEP_ME_TEXT stays.",
    })
    writePackage(SUPP_HOME, "drop_me", toolManifest("drop_me", "drop_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "DROP_ME_TEXT goes.",
    })
    const loader = await load({
      all: true,
      suppress: new Set<string>(),
      keep: new Set(["keep_me"]),
    })
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toContain("KEEP_ME_TEXT")
    expect(blocks.sessionContext).not.toContain("DROP_ME_TEXT")
  })

  it("no pluginPrompts option keeps the text (default)", async () => {
    cleanPlugins()
    writePackage(SUPP_HOME, "defaulted", toolManifest("defaulted", "keep_dflt", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "DEFAULT_KEEPS_TEXT.",
    })
    const loader = await load()
    const blocks = await loader.getPromptBlocksAsync()
    expect(blocks.sessionContext).toContain("DEFAULT_KEEPS_TEXT")
  })

  it("the suppressed result stays memoized (byte-stable)", async () => {
    cleanPlugins()
    writePackage(SUPP_HOME, "memo", toolManifest("memo", "memo_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
      "PROMPT.md": "MEMO_TEXT should be gone.",
    })
    const loader = await load(suppression(["memo"]))
    const first = await loader.getPromptBlocksAsync()
    const second = await loader.getPromptBlocksAsync()
    expect(second).toBe(first)
    expect(first.sessionContext).toBeNull()
  })

  it("suppressed sessionContext fragment text is absent from getPromptBlock", async () => {
    cleanPlugins()
    writePackage(
      SUPP_HOME,
      "sync_ctx",
      {
        id: "sync_ctx",
        name: "sync_ctx",
        version: "0.1.0",
        description: "d",
      },
      { "PROMPT.md": "# Sync\n\nSYNC_SUPPRESSED_TEXT." },
    )
    const loader = await load(suppression(["sync_ctx"]))
    expect(loader.getPromptBlock()).toBeNull()
  })
})

/**
 * Loader seam: manifest-declared `replayRenderers` are resolved through
 * the loader's blessed dynamic-import path and registered into the core
 * replay-renderer registry (`src/session-replay-derivers.ts`), so the
 * `--resume` replay path can delegate per-tool re-rendering to plugins
 * WITHOUT core importing the plugins tree (the I2 invariant).
 */

import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterEach, beforeAll, describe, expect, it } from "bun:test"

import { clearReplayRenderers, deriveDisplayFallback } from "../host/session-replay-derivers.ts"

import { CORE_TOOLS, ROOT, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const RR_HOME = join(ROOT, "replay-home")
const RR_PROJECT = join(ROOT, "replay-project")

/** Handler module body: echoes the row content with a marker prefix. */
const REPLAY_HANDLER_BODY = `
export default function render(ctx) {
  return { displayHeader: "hdr", display: "PLUGIN:" + ctx.content };
}
`

/** Handler whose default export is not a function. */
const BAD_REPLAY_HANDLER_BODY = `
export default 42;
`

/** Minimal manifest with one tool + one replayRenderers entry. */
function replayManifest(
  id: string,
  toolName: string,
  replayTool: string,
  handlerPath: string,
): Record<string, unknown> {
  return {
    ...toolManifest(id, toolName, "./h.ts"),
    replayRenderers: [
      {
        id: "replay",
        tool: replayTool,
        handler: { type: "module", path: handlerPath, export: "default" },
      },
    ],
  }
}

const TOOL_HANDLER = `export default async () => ({ kind: "tool_result", content: "ok" });`

describe("PluginLoader — replayRenderers seam", () => {
  beforeAll(() => {
    rmSync(RR_HOME, { recursive: true, force: true })
    rmSync(RR_PROJECT, { recursive: true, force: true })
    mkdirSync(RR_HOME, { recursive: true })
    mkdirSync(RR_PROJECT, { recursive: true })
  })

  afterEach(() => {
    clearReplayRenderers()
    rmSync(join(RR_HOME, "plugins"), { recursive: true, force: true })
    rmSync(join(RR_PROJECT, ".agents"), { recursive: true, force: true })
  })

  it("registers a manifest-declared replay renderer (round-trip through the registry)", async () => {
    writePackage(
      RR_HOME,
      "rr-alpha",
      replayManifest("rr-alpha", "rr_tool_a", "RrToolA", "./replay.ts"),
      {
        "h.ts": TOOL_HANDLER,
        "replay.ts": REPLAY_HANDLER_BODY,
      },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: RR_HOME,
      projectDir: join(ROOT, "rr-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const d = deriveDisplayFallback({
      toolName: "RrToolA",
      input: { action: "x" },
      content: "row content",
      isError: false,
    })
    expect(d).toEqual({ displayHeader: "hdr", display: "PLUGIN:row content" })
  })

  it("a missing handler module is logged and skipped (plugin keeps its tools)", async () => {
    writePackage(
      RR_HOME,
      "rr-beta",
      replayManifest("rr-beta", "rr_tool_b", "RrToolB", "./nope.ts"),
      {
        "h.ts": TOOL_HANDLER,
      },
    )
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: RR_HOME,
      projectDir: join(ROOT, "rr-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    // The tool still loads; only the replay renderer is skipped.
    expect(loader.hasTool("rr_tool_b")).toBe(true)
    expect(
      deriveDisplayFallback({ toolName: "RrToolB", input: {}, content: "c", isError: false }),
    ).toBeUndefined()
    expect(logs.some((l) => l.includes("replay renderer"))).toBe(true)
  })

  it("a non-function export is logged and skipped", async () => {
    writePackage(
      RR_HOME,
      "rr-gamma",
      replayManifest("rr-gamma", "rr_tool_c", "RrToolC", "./replay.ts"),
      {
        "h.ts": TOOL_HANDLER,
        "replay.ts": BAD_REPLAY_HANDLER_BODY,
      },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: RR_HOME,
      projectDir: join(ROOT, "rr-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(
      deriveDisplayFallback({ toolName: "RrToolC", input: {}, content: "c", isError: false }),
    ).toBeUndefined()
    expect(logs.some((l) => l.includes("replay renderer"))).toBe(true)
  })

  it("first registration wins on tool-name collision across plugins (precedence order)", async () => {
    // project root has higher precedence than home; both declare a
    // renderer for the same tool name.
    writePackage(
      RR_PROJECT,
      "rr-proj",
      replayManifest("rr-proj", "rr_tool_p", "RrShared", "./replay.ts"),
      {
        "h.ts": TOOL_HANDLER,
        "replay.ts": `export default () => ({ display: "FROM PROJECT" });`,
      },
      ".agents/plugins",
    )
    writePackage(
      RR_HOME,
      "rr-home",
      replayManifest("rr-home", "rr_tool_h", "RrShared", "./replay.ts"),
      {
        "h.ts": TOOL_HANDLER,
        "replay.ts": `export default () => ({ display: "FROM HOME" });`,
      },
    )
    const logs: string[] = []
    await PluginLoader.load({
      homeDir: RR_HOME,
      projectDir: RR_PROJECT,
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    const d = deriveDisplayFallback({
      toolName: "RrShared",
      input: {},
      content: "c",
      isError: false,
    })
    expect(d).toEqual({ display: "FROM PROJECT" })
    expect(logs.some((l) => l.includes("replay renderer"))).toBe(true)
  })

  it("malformed replayRenderers entries are skipped without poisoning the package", async () => {
    const manifest = {
      ...toolManifest("rr-delta", "rr_tool_d", "./h.ts"),
      replayRenderers: [
        "not-an-object",
        { id: "no-tool", handler: { type: "module", path: "./replay.ts" } },
        { id: "bad-type", tool: "RrToolD", handler: { type: "subprocess", command: ["x"] } },
      ],
    }
    writePackage(RR_HOME, "rr-delta", manifest, {
      "h.ts": TOOL_HANDLER,
      "replay.ts": REPLAY_HANDLER_BODY,
    })
    const logs: string[] = []
    const loader = await PluginLoader.load({
      homeDir: RR_HOME,
      projectDir: join(ROOT, "rr-nope"),
      coreToolNames: CORE_TOOLS,
      logger: (m) => logs.push(m),
    })
    expect(loader.hasTool("rr_tool_d")).toBe(true)
    expect(
      deriveDisplayFallback({ toolName: "RrToolD", input: {}, content: "c", isError: false }),
    ).toBeUndefined()
  })
})

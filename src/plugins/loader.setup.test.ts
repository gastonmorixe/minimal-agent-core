import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { PluginLoader } from "./loader.ts"
import type { SetupBinaryInventory } from "./types.ts"

/** An always-missing inventory stub. */
function emptyInventory(dir = "/x/bin"): SetupBinaryInventory {
  return {
    dir,
    has: () => false,
    get: () => undefined,
    status: () => "missing",
  }
}

describe("PluginLoader.runSetups", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ma-loader-setup-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function writePlugin(id: string, manifest: object, files: Record<string, string>): void {
    const dir = join(root, ".agents", "plugins", id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2))
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(dir, rel), content)
    }
  }

  it("invokes a plugin's setup() and returns its SetupResult", async () => {
    writePlugin(
      "needs-bin",
      {
        id: "needs-bin",
        name: "needs-bin",
        version: "0.1.0",
        description: "test",
        setup: { type: "module", path: "./setup.ts" },
        tuis: [
          {
            id: "t",
            trigger: {
              type: "tool",
              tool: { name: "DummyTool", description: "d", input_schema: { type: "object" } },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
      {
        "setup.ts": `export default async (ctx) => ({
          requireBinaries: [{ name: "obscura", version: "0.1.6", url: "https://x/o.tar.gz", sha256: "${"a".repeat(64)}" }],
          haltIfMissing: ["obscura"],
          haltMessage: "need obscura",
        })`,
        "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" })`,
      },
    )

    const loader = await PluginLoader.load({ projectDir: root })
    const results = await loader.runSetups(emptyInventory())
    expect(results.length).toBe(1)
    expect(results[0]?.pluginId).toBe("needs-bin")
    expect(results[0]?.result.requireBinaries?.[0]?.name).toBe("obscura")
    expect(results[0]?.result.haltIfMissing).toEqual(["obscura"])
  })

  it("passes the inventory to setup so it can branch on installed state", async () => {
    writePlugin(
      "inv-aware",
      {
        id: "inv-aware",
        name: "inv-aware",
        version: "0.1.0",
        description: "test",
        setup: { type: "module", path: "./setup.ts" },
        tuis: [
          {
            id: "t",
            trigger: {
              type: "tool",
              tool: { name: "InvTool", description: "d", input_schema: { type: "object" } },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
      {
        // Returns an empty require list when the binary is already present.
        "setup.ts": `export default (ctx) => ctx.binaries.has("obscura") ? {} : { requireBinaries: [{ name: "obscura", version: "1", url: "https://x/o", sha256: "${"a".repeat(64)}" }] }`,
        "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" })`,
      },
    )

    const loader = await PluginLoader.load({ projectDir: root })
    const present: SetupBinaryInventory = { ...emptyInventory(), has: () => true }
    const results = await loader.runSetups(present)
    expect(results[0]?.result.requireBinaries).toBeUndefined()
  })

  it("skips a plugin whose setup() throws, without failing the others", async () => {
    writePlugin(
      "boom",
      {
        id: "boom",
        name: "boom",
        version: "0.1.0",
        description: "test",
        setup: { type: "module", path: "./setup.ts" },
        tuis: [
          {
            id: "t",
            trigger: {
              type: "tool",
              tool: { name: "BoomTool", description: "d", input_schema: { type: "object" } },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
      {
        "setup.ts": `export default () => { throw new Error("kaboom") }`,
        "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" })`,
      },
    )

    const loader = await PluginLoader.load({ projectDir: root })
    const results = await loader.runSetups(emptyInventory())
    expect(results.length).toBe(0)
  })

  it("returns nothing when no plugin declares setup", async () => {
    writePlugin(
      "no-setup",
      {
        id: "no-setup",
        name: "no-setup",
        version: "0.1.0",
        description: "test",
        tuis: [
          {
            id: "t",
            trigger: {
              type: "tool",
              tool: { name: "PlainTool", description: "d", input_schema: { type: "object" } },
            },
            handler: { type: "module", path: "./h.ts", export: "default" },
            interactive: false,
          },
        ],
      },
      { "h.ts": `export default async () => ({ kind: "tool_result", content: "ok" })` },
    )

    const loader = await PluginLoader.load({ projectDir: root })
    const results = await loader.runSetups(emptyInventory())
    expect(results.length).toBe(0)
  })
})

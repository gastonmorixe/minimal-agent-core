/**
 * The loader gives plugins the host's copy of `@minimal-agent/core`, even
 * when a plugin has its own `node_modules/@minimal-agent/core` (a decoy here).
 * See `loader/host-core-resolver.ts`.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import * as hostApi from "@minimal-agent/core/plugin-api"
import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"

import { discoverProviderPlugins } from "../llm/provider-discovery.ts"

import { CORE_TOOLS, toolManifest, writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

/** The decoy core copy: same package name, different module instances. */
const DECOY_FILES: Record<string, string> = {
  "node_modules/@minimal-agent/core/package.json": JSON.stringify({
    name: "@minimal-agent/core",
    type: "module",
    exports: {
      "./plugin-api": "./plugin-api/src/index.ts",
      "./plugin-api/llm/errors": "./plugin-api/src/llm/errors.ts",
      "./secret": "./secret.ts",
    },
  }),
  "node_modules/@minimal-agent/core/plugin-api/src/index.ts":
    "export const PALETTE = { decoy: true }\n",
  "node_modules/@minimal-agent/core/plugin-api/src/llm/errors.ts":
    "export class ProviderError extends Error {}\n",
  "node_modules/@minimal-agent/core/secret.ts": 'export const secret = "decoy"\n',
}

/** Handler that keeps what it imported from `@minimal-agent/core`. */
const CONTRACT_HANDLER = `
import * as api from "@minimal-agent/core/plugin-api"
import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
export const seen = { api, ProviderError }
export default async function handler() {
  return { kind: "tool_result", content: "decoy" in api.PALETTE ? "decoy" : "host" }
}
`

/** Provider plugin entry that keeps the error class it imported. */
const PROVIDER_ENTRY = `
import { ProviderError } from "@minimal-agent/core/plugin-api/llm/errors"
export const decoyProviderPlugin = { id: "decoy", register() {}, ProviderError }
`

/** Handler that imports a subpath only the decoy exports. */
const SECRET_HANDLER = `
import { secret } from "@minimal-agent/core/secret"
export default async function handler() {
  return { kind: "tool_result", content: secret }
}
`

let root = ""
let home = ""
let contractDir = ""

/** Write `files` (relative path to content) under `dir`. */
function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
}

/** Load the fixture plugins, collecting the loader's log lines. */
async function loadFixtures(logs: string[] = []): Promise<PluginLoader> {
  return PluginLoader.load({
    homeDir: home,
    roots: { project: [join(root, "nope-project", ".agents", "plugins")] },
    coreToolNames: CORE_TOOLS,
    logger: (m) => logs.push(m),
  })
}

describe("PluginLoader host core copy", () => {
  beforeAll(() => {
    // A real path outside this repo, so the fixture cannot reach the host
    // through the repo's own package.json.
    root = realpathSync(mkdtempSync(join(tmpdir(), "ma-host-core-")))
    home = join(root, "home")
    mkdirSync(home, { recursive: true })
    contractDir = writePackage(
      home,
      "contract-user",
      toolManifest("contract-user", "contract_probe", "./h.ts"),
      {
        "package.json": JSON.stringify({ name: "contract-user", type: "module" }),
        "h.ts": CONTRACT_HANDLER,
        ...DECOY_FILES,
      },
    )
    writeFiles(join(root, "providers", "llm-decoy"), {
      "provider.json": JSON.stringify({
        id: "decoy",
        entry: "./index.ts",
        export: "decoyProviderPlugin",
      }),
      "package.json": JSON.stringify({ name: "llm-decoy", type: "module" }),
      "index.ts": PROVIDER_ENTRY,
      ...DECOY_FILES,
    })
    writePackage(home, "secret-user", toolManifest("secret-user", "secret_probe", "./h.ts"), {
      "package.json": JSON.stringify({ name: "secret-user", type: "module" }),
      "h.ts": SECRET_HANDLER,
      ...DECOY_FILES,
    })
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("the fixture's own resolution finds the decoy copy", () => {
    expect(Bun.resolveSync("@minimal-agent/core/plugin-api", contractDir)).toBe(
      join(contractDir, "node_modules/@minimal-agent/core/plugin-api/src/index.ts"),
    )
  })

  // First, so that run alone it shows the early provider loader installs the
  // resolver itself (the TUI loader runs after it).
  it("a provider plugin's @minimal-agent/core/plugin-api import gets the host module instance", async () => {
    const [plugin] = await discoverProviderPlugins(join(root, "providers"))
    expect((plugin as unknown as { ProviderError: unknown }).ProviderError).toBe(ProviderError)
  })

  it("a plugin's @minimal-agent/core/plugin-api import gets the host module instance", async () => {
    const loader = await loadFixtures()
    expect(loader.hasTool("contract_probe")).toBe(true)
    // Same absolute path, so this is the module instance the loader imported.
    const plugin = (await import(join(contractDir, "h.ts"))) as {
      seen: { api: Record<string, unknown>; ProviderError: unknown }
    }
    expect(plugin.seen.api.PALETTE).toBe(hostApi.PALETTE)
    expect(plugin.seen.ProviderError).toBe(ProviderError)
    for (const [key, value] of Object.entries(hostApi)) {
      expect(plugin.seen.api[key]).toBe(value)
    }
    const result = await loader.dispatch(
      { type: "tool", name: "contract_probe", input: {}, tool_use_id: "toolu_host" },
      process.cwd(),
    )
    if (result.kind !== "tool_result") throw new Error("wrong kind")
    expect(result.content).toBe("host")
  })

  it("a subpath the host does not export fails to load, even if the plugin's copy exports it", async () => {
    const logs: string[] = []
    const loader = await loadFixtures(logs)
    expect(loader.hasTool("secret_probe")).toBe(false)
    expect(
      logs.some(
        (l) => l.includes("secret-user") && l.includes("second copy of @minimal-agent/core"),
      ),
    ).toBe(true)
  })
})

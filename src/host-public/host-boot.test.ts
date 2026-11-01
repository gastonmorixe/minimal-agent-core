/**
 * Tests for the aggregate host boot (`./host-kit/host-boot`, WEB-PLUGINS-001).
 *
 * Each test builds its own temp tree: an agent home, an empty embedded dir,
 * an empty shared-plugins stand-in, and a project dir. The tests pass every
 * plugin root as data (S40) and no `pluginSync`, so the boot reads only the
 * temp tree and never clones.
 *
 * @module host-public/host-boot.test
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { bootHost, listBootedModels } from "@minimal-agent/core/host-kit/host-boot"

import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { TOOL_HANDLER_BODY, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"
import { TOOL_DEFINITIONS } from "../tools/tool-definitions.ts"

const ENV_KEYS = [
  "MINIMAL_AGENT_HOME",
  "MINIMAL_AGENT_CONFIG",
  "MINIMAL_AGENT_DISABLE_PLUGINS",
  "MINIMAL_AGENT_ENABLE_PLUGINS",
  "MINIMAL_AGENT_PLUGIN_SIBLINGS",
  "MINIMAL_AGENT_TEST_AUTH",
  "MINIMAL_AGENT_NO_PLUGIN_SYNC",
  "MINIMAL_AGENT_PLATFORM",
] as const

const savedEnv = new Map<string, string | undefined>()
const roots: string[] = []
let root = ""

/** Make the temp layout for one test. */
function layout() {
  const home = join(root, "home")
  const embeddedDir = join(root, "embedded")
  const homeDir = join(root, "agents")
  const projectDir = join(root, "project")
  for (const d of [home, embeddedDir, homeDir, projectDir]) mkdirSync(d, { recursive: true })
  return { home, embeddedDir, homeDir, projectDir }
}

/** Boot options that read only the temp layout. */
function bootOptions(l: ReturnType<typeof layout>) {
  return {
    home: l.home,
    pluginRoots: {
      embedded: [join(l.embeddedDir, "plugins")],
      user: [join(l.home, "plugins")],
      home: [join(l.homeDir, "plugins")],
      project: [join(l.projectDir, ".agents", "plugins")],
    },
  }
}

/** Write a fake provider plugin (provider.json + entry) under `<pluginsRoot>/llm-<id>`. */
function writeFakeProvider(
  pluginsRoot: string,
  id: string,
  modelId: string,
  extra: { packageJson?: unknown; entryPrefix?: string } = {},
): string {
  const dir = join(pluginsRoot, `llm-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
  if (extra.packageJson !== undefined) {
    writeFileSync(join(dir, "package.json"), JSON.stringify(extra.packageJson))
  }
  writeFileSync(
    join(dir, "index.ts"),
    `${extra.entryPrefix ?? ""}
export const providerPlugin = {
  id: ${JSON.stringify(id)},
  displayName: ${JSON.stringify(`${id} provider`)},
  shortCode: ${JSON.stringify(id.slice(0, 2))},
  register(ctx) {
    ctx.providers.register({
      id: ${JSON.stringify(id)},
      displayName: ${JSON.stringify(id)},
      surfaces: ["test-surface"],
      validate: () => ({ ok: true, errors: [] }),
      async *run() {},
    })
    ctx.models.register({
      id: ${JSON.stringify(modelId)},
      providerId: ${JSON.stringify(id)},
      surfaceId: "test-surface",
      displayName: ${JSON.stringify(`${modelId} display`)},
      capabilities: { contextWindow: 123456, maxOutputTokens: 1000 },
      pricing: { inputUSD: 1, outputUSD: 2, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
    })
  },
}
`,
  )
  return dir
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k])
    delete process.env[k]
  }
  root = mkdtempSync(join(tmpdir(), "host-boot-"))
  roots.push(root)
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

describe("bootHost", () => {
  it("boots with an empty plugins dir: no providers, no models, core tools only", async () => {
    const l = layout()
    mkdirSync(join(l.home, "plugins"), { recursive: true })
    const host = await bootHost(bootOptions(l))
    expect(host.home).toBe(l.home)
    expect(process.env.MINIMAL_AGENT_HOME).toBe(l.home)
    expect(host.providers).toEqual([])
    expect(host.models).toEqual([])
    expect(host.plugins).toEqual([])
    expect(host.diagnostics).toEqual([])
    expect(host.toolRegistry.list().map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name))
    expect(listBootedModels()).toEqual([])
  })

  it("scans only the roots the host passes (S40)", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbnoroot", "hbnoroot-model-1")
    writePackage(l.home, "hb-noroot", toolManifest("hb-noroot", "hb_noroot_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const host = await bootHost({ home: l.home })
    expect(host.providers).not.toContain("hbnoroot")
    expect(host.plugins.map((p) => p.id)).not.toContain("hb-noroot")
  })

  it("registers one fake provider plugin from <home>/plugins", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbfake", "hbfake-model-1")
    const host = await bootHost(bootOptions(l))
    expect(host.providers).toEqual(["hbfake"])
    expect(host.diagnostics).toEqual([])
  })

  it("lists model rows after boot, with context window, rates, and capabilities", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbrows", "hbrows-model-1")
    const host = await bootHost(bootOptions(l))
    const row = {
      id: "hbrows-model-1",
      providerId: "hbrows",
      displayName: "hbrows-model-1 display",
      contextWindow: 123456,
      rates: {
        inputUSD: 1,
        outputUSD: 2,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    }
    expect(host.models).toHaveLength(1)
    expect(host.models[0]).toMatchObject(row)
    expect(host.models[0]?.capabilities.maxOutputTokens).toBe(1000)
    expect(listBootedModels()).toEqual([...host.models])
  })

  it("merges plugin tools after the core tools, and the executor runs a plugin tool", async () => {
    const l = layout()
    writePackage(l.home, "hb-tools", toolManifest("hb-tools", "hb_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const host = await bootHost(bootOptions(l))
    const names = host.toolRegistry.list().map((t) => t.name)
    expect(names).toEqual([...TOOL_DEFINITIONS.map((t) => t.name), "hb_tool"])
    expect(host.plugins).toEqual([{ id: "hb-tools" }])
    const result = await host.toolExecutor.execute({
      type: "tool_use",
      id: "toolu_hb1",
      name: "hb_tool",
      input: { a: 1 },
    })
    expect(JSON.stringify(result)).toContain("ok: ")
  })

  it("does not load a plugin that config disables", async () => {
    const l = layout()
    writePackage(l.home, "hb-off", toolManifest("hb-off", "hb_off_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writePackage(l.home, "hb-on", toolManifest("hb-on", "hb_on_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    writeFileSync(
      join(l.home, "config.jsonc"),
      `{\n  // turn one plugin off\n  "plugins": { "hb-off": { "enabled": false } }\n}\n`,
    )
    const host = await bootHost(bootOptions(l))
    const names = host.toolRegistry.list().map((t) => t.name)
    expect(names).toContain("hb_on_tool")
    expect(names).not.toContain("hb_off_tool")
    expect(host.plugins).toEqual([{ id: "hb-on" }])
    expect(host.disabledPluginIds).toEqual(["hb-off"])
  })

  it("rejects resolveAuth with a clear error when no auth file exists, and the boot does not throw", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbauth", "hbauth-model-1")
    const host = await bootHost(bootOptions(l))
    await expect(host.resolveAuth("hbauth-model-1")).rejects.toThrow(
      /no credentials for provider "hbauth"/,
    )
    await expect(host.resolveAuth("hb-no-such-model")).rejects.toThrow(/unknown model/)
  })

  it("reports a diagnostic when a provider plugin declares dependencies but has no node_modules", async () => {
    const l = layout()
    const dir = writeFakeProvider(join(l.home, "plugins"), "hbdeps", "hbdeps-model-1", {
      packageJson: {
        name: "llm-hbdeps",
        dependencies: { "@minimal-agent/core": "git+ssh://x", "hb-extra-dep": "1.0.0" },
      },
    })
    const host = await bootHost(bootOptions(l))
    expect(host.diagnostics).toEqual([
      {
        kind: "plugin-deps-missing",
        pluginId: "hbdeps",
        dir,
        message: expect.stringContaining("bun install"),
      },
    ])
    // Detection only: the boot does not install, and the provider still loads.
    expect(host.providers).toEqual(["hbdeps"])
  })

  it("does not report a provider plugin whose only dependency is core", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbcore", "hbcore-model-1", {
      packageJson: { name: "llm-hbcore", dependencies: { "@minimal-agent/core": "git+ssh://x" } },
    })
    const host = await bootHost(bootOptions(l))
    expect(host.diagnostics).toEqual([])
  })

  it("reports a provider plugin that fails to import, and does not throw", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbbroken", "hbbroken-model-1", {
      packageJson: { name: "llm-hbbroken", dependencies: { "hb-missing-pkg": "1.0.0" } },
      entryPrefix: `import "hb-missing-pkg"\n`,
    })
    const host = await bootHost(bootOptions(l))
    const kinds = host.diagnostics.map((d) => d.kind)
    expect(kinds).toContain("plugin-deps-missing")
    expect(kinds).toContain("provider-discovery-failed")
    expect(host.providers).toEqual([])
  })
})

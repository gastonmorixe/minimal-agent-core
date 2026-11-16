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

import type { StatusFields, StatusPort } from "../bus/status-port.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, clearProviderRegistry, registerModel } from "../llm/model-registry.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { TOOL_HANDLER_BODY, toolManifest, writePackage } from "../plugins/loader.fixtures.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { BUILTIN_TOOL_NAMES } from "../tools/tool-definitions.ts"

/** Boot diagnostics without the S10.1 slot warning (no template plugin in these fixtures). */
const withoutSlotWarn = <T extends { kind: string }>(ds: readonly T[]): T[] =>
  ds.filter((d) => (d as { code?: string }).code !== "prompt.no_template_provider")

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
  const projectDir = join(root, "project")
  for (const d of [home, embeddedDir, projectDir]) mkdirSync(d, { recursive: true })
  return { home, embeddedDir, projectDir }
}

/** Boot options that read only the temp layout. */
function bootOptions(l: ReturnType<typeof layout>) {
  return {
    home: l.home,
    pluginRoots: {
      embedded: [join(l.embeddedDir, "plugins")],
      user: [join(l.home, "plugins")],
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

/** A status port that records the fields of each `open` call. */
function recordingStatusPort(): { port: StatusPort; opened: StatusFields[] } {
  const opened: StatusFields[] = []
  const port: StatusPort = {
    open(fields) {
      opened.push(fields)
      return { update: () => {}, updateActivity: () => {}, clear: () => {} }
    },
  }
  return { port, opened }
}

/** Register a model that does (or does not) accept image input. */
function registerMediaModel(id: string, image: boolean): void {
  registerModel({
    id,
    providerId: "hbmedia",
    surfaceId: "test-surface",
    displayName: id,
    capabilities: {
      ...defaultCapabilities(),
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      modalities: { image, audio: false, pdf: false, video: false },
    },
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
}

/** Write a 12x12 PNG header (enough for the image sniffer) and return its path. */
function writePng(dir: string, name: string): string {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 12
  b[23] = 12
  const path = join(dir, name)
  writeFileSync(path, b)
  return path
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
    expect(withoutSlotWarn(host.diagnostics)).toEqual([])
    expect(host.toolRegistry.list().map((t) => t.name)).toEqual([...BUILTIN_TOOL_NAMES])
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
    expect(withoutSlotWarn(host.diagnostics)).toEqual([])
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
    expect(names).toEqual([...BUILTIN_TOOL_NAMES, "hb_tool"])
    expect(host.plugins).toEqual([{ id: "hb-tools" }])
    const result = await host.toolExecutor.execute({
      type: "tool_use",
      id: "toolu_hb1",
      name: "hb_tool",
      input: { a: 1 },
    })
    expect(JSON.stringify(result)).toContain("ok: ")
  })

  it("resolveAuth with a providerId uses that provider when two providers register the same model id", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbdupa", "hbdup-model-1")
    writeFakeProvider(join(l.home, "plugins"), "hbdupb", "hbdup-model-1")
    const host = await bootHost(bootOptions(l))
    expect([...host.providers].sort()).toEqual(["hbdupa", "hbdupb"])
    await expect(host.resolveAuth("hbdup-model-1", "hbdupa")).rejects.toMatchObject({
      kind: "NoProviderCredentialsError",
      providerId: "hbdupa",
    })
    await expect(host.resolveAuth("hbdup-model-1", "hbdupb")).rejects.toMatchObject({
      kind: "NoProviderCredentialsError",
      providerId: "hbdupb",
    })
    await expect(host.resolveAuth("hbdup-model-1", "hb-no-such-provider")).rejects.toThrow(
      /unknown model "hbdup-model-1" for provider "hb-no-such-provider"/,
    )
  })

  it("sends the running_tool status of each tool call to the statusPort option", async () => {
    const l = layout()
    writePackage(l.home, "hb-status", toolManifest("hb-status", "hb_status_tool", "./h.ts"), {
      "h.ts": TOOL_HANDLER_BODY,
    })
    const boot = recordingStatusPort()
    const host = await bootHost({ ...bootOptions(l), statusPort: boot.port })
    await host.toolExecutor.execute({
      type: "tool_use",
      id: "toolu_hbs1",
      name: "hb_status_tool",
      input: {},
    })
    expect(boot.opened).toContainEqual({ phase: "running_tool", toolName: "hb_status_tool" })

    // A per-session port replaces the boot port for that executor only.
    const session = recordingStatusPort()
    const before = boot.opened.length
    await host.toolExecutorFor(host.defaultModelId, { statusPort: session.port }).execute({
      type: "tool_use",
      id: "toolu_hbs2",
      name: "hb_status_tool",
      input: {},
    })
    expect(session.opened).toContainEqual({ phase: "running_tool", toolName: "hb_status_tool" })
    expect(boot.opened).toHaveLength(before)
  })

  it.skipIf(!textFixturesPresent())(
    "gives each model its own executor with its own model context",
    async () => {
      const l = layout()
      const host = await bootHost(bootOptions(l))
      registerMediaModel("hb-vision-model", true)
      registerMediaModel("hb-text-model", false)
      const png = writePng(l.home, "a.png")
      // The Read media text comes from the real core-tools provider, not a core fallback.
      const CTX = { text: fixtureSyntheticTextResolver() }
      const read = {
        type: "tool_use" as const,
        id: "toolu_hbm1",
        name: "Read",
        input: { file_path: png },
      }
      const vision = await host.toolExecutorFor("hb-vision-model").execute(read, undefined, CTX)
      const text = await host.toolExecutorFor("hb-text-model").execute(read, undefined, CTX)
      // The vision model gets an image block. The text model gets a plain string.
      expect(Array.isArray(vision.content)).toBe(true)
      expect(JSON.stringify(vision.content)).toContain('"type":"image"')
      expect(typeof text.content).toBe("string")
      expect(String(text.content)).toContain("does not accept image")
    },
  )

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
    await expect(host.resolveAuth("hbauth-model-1")).rejects.toMatchObject({
      kind: "NoProviderCredentialsError",
      providerId: "hbauth",
    })
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
    expect(withoutSlotWarn(host.diagnostics)).toEqual([
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
    expect(withoutSlotWarn(host.diagnostics)).toEqual([])
  })

  it("reports a provider plugin that fails to import, and does not throw", async () => {
    const l = layout()
    writeFakeProvider(join(l.home, "plugins"), "hbbroken", "hbbroken-model-1", {
      packageJson: { name: "llm-hbbroken", dependencies: { "hb-missing-pkg": "1.0.0" } },
      entryPrefix: `import "hb-missing-pkg"\n`,
    })
    const host = await bootHost(bootOptions(l))
    const kinds = withoutSlotWarn(host.diagnostics).map((d) => d.kind)
    expect(kinds).toContain("plugin-deps-missing")
    expect(kinds).toContain("provider-discovery-failed")
    expect(host.providers).toEqual([])
  })
})

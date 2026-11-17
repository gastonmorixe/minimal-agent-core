/**
 * Spec v6.1 D1 items 1 to 3: the loader collects `toolResultTransforms`,
 * builds one frozen sideband registry, and validates the chain at load. Also
 * the stage time limit rule (`timeoutMs`, D1 item 8).
 */

import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { SidebandRegistryFrozenError } from "../sideband/errors.ts"
import type { SidebandRegistry } from "../sideband/types.ts"

import type { TimedToolResultTransformDecl } from "./loader/tool-result-chain-boot.ts"
import {
  CHAIN_PROBE_KIND,
  CHAIN_PROBE_PACKAGE_DIR,
  CHAIN_PROBE_PHASES,
  CHAIN_PROBE_PLUGINS_DIR,
  chainProbeKind,
  writeChainProbe,
} from "./loader.chain-probe.fixtures.ts"
import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-tool-result-chain-tests")
const PLUGINS = join(ROOT, "plugins")
const NO_PROJECT = join(ROOT, "nope-project")

async function load(dirs: string[] = [PLUGINS]) {
  const events: LogEvent[] = []
  const messages: string[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  const loader = await PluginLoader.load({
    roots: { embedded: dirs, project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(),
    logger: (m) => messages.push(m),
  })
  return { loader, events, messages }
}

const bySource = (events: LogEvent[], source: string) => events.filter((e) => e.source === source)
const timeoutOf = (loader: PluginLoader) =>
  loader.toolResultChain().map((e) => (e.decl as TimedToolResultTransformDecl).timeoutMs)

describe("loader: tool-result chain and sideband registry (spec v6.1 D1)", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(PLUGINS, { recursive: true })
  })
  afterEach(() => rmSync(PLUGINS, { recursive: true, force: true }))
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("collects one entry per stage of the static fixture, all owned by chain-probe", async () => {
    const { loader, events } = await load([CHAIN_PROBE_PLUGINS_DIR])
    const chain = loader.toolResultChain()
    expect(chain.map((e) => e.decl.phase)).toEqual([...CHAIN_PROBE_PHASES])
    expect(chain.every((e) => e.pluginId === "chain-probe")).toBe(true)
    expect(Object.isFrozen(chain)).toBe(true)
    expect(loader.hasTool("ProbeTool")).toBe(true)
    expect(CHAIN_PROBE_PACKAGE_DIR.startsWith(CHAIN_PROBE_PLUGINS_DIR)).toBe(true)
    expect(events.filter((e) => e.source.startsWith("tool-result-chain."))).toEqual([])
  })

  it("registers the manifest sideband kind with the plugin as owner", async () => {
    writeChainProbe(PLUGINS)
    const { loader } = await load()
    const registry = loader.sidebandRegistry()
    expect(registry.kind(CHAIN_PROBE_KIND)?.owner).toBe("chain-probe")
    expect(registry.kinds().map((k) => k.kind)).toEqual([CHAIN_PROBE_KIND])
  })

  it("freezes the registry and exposes no register method", async () => {
    writeChainProbe(PLUGINS)
    const { loader } = await load()
    const registry = loader.sidebandRegistry()
    expect("register" in registry).toBe(false)
    expect("setCodec" in registry).toBe(false)
    expect(Object.isFrozen(registry)).toBe(true)
  })

  it("a raw registry from the same factory throws SidebandRegistryFrozenError after freeze", async () => {
    const { createSidebandRegistry } = await import("../sideband/registry.ts")
    const r: SidebandRegistry = createSidebandRegistry()
    r.freeze()
    expect(() => r.register({ ...chainProbeKind(), owner: "x" } as never, "x")).toThrow(
      SidebandRegistryFrozenError,
    )
  })

  it("sets the codec from sidebandCodec; codec() returns the factory value", async () => {
    writeChainProbe(PLUGINS, {
      codecSource: `export default (r) => ({ marker: "probe-codec", kinds: r.kinds().length })\n`,
    })
    const { loader, events } = await load()
    const codec = loader.sidebandRegistry().codec() as unknown as { marker: string; kinds: number }
    expect(codec.marker).toBe("probe-codec")
    expect(codec.kinds).toBe(1)
    expect(bySource(events, "sideband.codec-load-failed")).toEqual([])
  })

  it("two clamp stages: one diagnostic, the first clamp kept, both plugins load", async () => {
    writeChainProbe(PLUGINS, { id: "aaa-probe", toolName: "AaaTool", sidebandKinds: [] })
    writeChainProbe(PLUGINS, { id: "bbb-probe", toolName: "BbbTool", sidebandKinds: [] })
    const { loader, events } = await load()
    const invalid = bySource(events, "tool-result-chain.invalid")
    expect(invalid).toHaveLength(1)
    expect(invalid[0]?.structuredData).toEqual({
      violations: "stamp-multiple,clamp-multiple",
      disabled: 2,
      plugins: "bbb-probe,bbb-probe",
    })
    const chain = loader.toolResultChain()
    expect(chain.filter((e) => e.decl.phase === "clamp").map((e) => e.pluginId)).toEqual([
      "aaa-probe",
    ])
    expect(chain.filter((e) => e.decl.phase === "stamp").map((e) => e.pluginId)).toEqual([
      "aaa-probe",
    ])
    expect(chain.filter((e) => e.decl.phase === "final")).toHaveLength(2)
    expect(loader.hasTool("AaaTool")).toBe(true)
    expect(loader.hasTool("BbbTool")).toBe(true)
  })

  it("a missing entry module: one load-failed diagnostic, boot continues", async () => {
    writeChainProbe(PLUGINS, { entry: "./nope.ts", writeEntry: false })
    const { loader, events } = await load()
    expect(bySource(events, "tool-result-chain.load-failed").map((e) => e.structuredData)).toEqual([
      { plugin: "chain-probe", reason: "module-missing" },
    ])
    expect(loader.toolResultChain()).toEqual([])
    expect(loader.hasTool("ProbeTool")).toBe(true)
    expect(loader.sidebandRegistry().kind(CHAIN_PROBE_KIND)).toBeDefined()
  })

  it("a non-array export: one load-failed diagnostic", async () => {
    writeChainProbe(PLUGINS, {
      entry: "./not-array.ts",
      transformsSource: "export default { phase: 'clamp' }\n",
    })
    const { loader, events } = await load()
    expect(bySource(events, "tool-result-chain.load-failed").map((e) => e.structuredData)).toEqual([
      { plugin: "chain-probe", reason: "not-array" },
    ])
    expect(loader.hasTool("ProbeTool")).toBe(true)
  })

  it("a module that throws on import: one load-failed diagnostic", async () => {
    writeChainProbe(PLUGINS, {
      entry: "./throws.ts",
      transformsSource: "throw new Error('boom')\nexport default []\n",
    })
    const { events } = await load()
    expect(bySource(events, "tool-result-chain.load-failed").map((e) => e.structuredData)).toEqual([
      { plugin: "chain-probe", reason: "import-threw" },
    ])
  })

  it("a bad element is skipped with one decl-invalid diagnostic", async () => {
    writeChainProbe(PLUGINS, {
      entry: "./bad-element.ts",
      transformsSource:
        "export default () => [{ phase: 'final', order: 0, transform: (s) => s }, { phase: 'nope', order: 0, transform: (s) => s }]\n",
    })
    const { loader, events } = await load()
    expect(bySource(events, "tool-result-chain.decl-invalid").map((e) => e.structuredData)).toEqual(
      [{ plugin: "chain-probe", index: 1 }],
    )
    expect(loader.toolResultChain().map((e) => e.decl.phase)).toEqual(["final"])
  })

  it("a kind with a bad name: sideband.kind-rejected, boot continues", async () => {
    writeChainProbe(PLUGINS, { sidebandKinds: [chainProbeKind("XmlBad")] })
    const { loader, events } = await load()
    const rejected = bySource(events, "sideband.kind-rejected")
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.structuredData).toMatchObject({ plugin: "chain-probe", kind: "XmlBad" })
    expect(loader.sidebandRegistry().kinds()).toEqual([])
    expect(loader.toolResultChain()).toHaveLength(5)
  })

  it("no plugin with these keys: empty chain and an empty registry", async () => {
    writePackage(ROOT, "plain", {
      id: "plain",
      name: "plain",
      version: "0.1.0",
      description: "test",
    })
    const { loader, events } = await load()
    expect(loader.toolResultChain()).toEqual([])
    expect(loader.sidebandRegistry().kinds()).toEqual([])
    expect(events.filter((e) => e.source.startsWith("tool-result-chain."))).toEqual([])
    rmSync(join(ROOT, "plugins", "plain"), { recursive: true, force: true })
  })

  describe("stage time limit (timeoutMs)", () => {
    const cases: {
      name: string
      requested?: unknown
      applied: number
      diag: boolean
    }[] = [
      { name: "absent -> 2000, no diagnostic", applied: 2000, diag: false },
      { name: "in range -> same, no diagnostic", requested: 500, applied: 500, diag: false },
      { name: "2000 -> 2000, no diagnostic", requested: 2000, applied: 2000, diag: false },
      { name: "1 -> 1, no diagnostic", requested: 1, applied: 1, diag: false },
      { name: "non-integer floored, no diagnostic", requested: 750.9, applied: 750, diag: false },
      { name: "1.5 floors to 1, no diagnostic", requested: 1.5, applied: 1, diag: false },
      { name: "0.5 floors to 0 -> 1, diagnostic", requested: 0.5, applied: 1, diag: true },
      { name: "0 -> 1, diagnostic", requested: 0, applied: 1, diag: true },
      { name: "negative -> 1, diagnostic", requested: -5, applied: 1, diag: true },
      { name: "above max -> 2000, diagnostic", requested: 5000, applied: 2000, diag: true },
      {
        name: "2000.5 floors to 2000, no diagnostic",
        requested: 2000.5,
        applied: 2000,
        diag: false,
      },
      { name: "string -> 2000, diagnostic", requested: "100", applied: 2000, diag: true },
    ]
    for (const c of cases) {
      it(c.name, async () => {
        writeChainProbe(PLUGINS, "requested" in c ? { timeoutMs: c.requested } : {})
        const { loader, events } = await load()
        expect(timeoutOf(loader)).toEqual([c.applied, c.applied, c.applied, c.applied, c.applied])
        const clamped = bySource(events, "tool-result-chain.timeout-clamped")
        if (!c.diag) {
          expect(clamped).toEqual([])
          return
        }
        // One diagnostic per clamped stage.
        expect(clamped.map((e) => e.structuredData)).toEqual(
          CHAIN_PROBE_PHASES.map((phase) => ({
            pluginId: "chain-probe",
            phase,
            requested: c.requested as number | string,
            applied: c.applied,
          })),
        )
      })
    }
  })

  it("NaN and Infinity -> 2000 with a diagnostic (JSON cannot hold them, so the parser is called)", async () => {
    const { resolveStageTimeout } = await import("./loader/tool-result-chain-boot.ts")
    expect(resolveStageTimeout(Number.NaN)).toEqual({ applied: 2000, clamped: true })
    expect(resolveStageTimeout(Number.POSITIVE_INFINITY)).toEqual({ applied: 2000, clamped: true })
    expect(resolveStageTimeout(Number.NEGATIVE_INFINITY)).toEqual({ applied: 2000, clamped: true })
    expect(resolveStageTimeout(undefined)).toEqual({ applied: 2000, clamped: false })
  })

  it("NaN through loadPluginTransforms: one diagnostic per stage with requested 'NaN'", async () => {
    const dir = writeChainProbe(PLUGINS)
    const { loadPluginTransforms } = await import("./loader/tool-result-chain-boot.ts")
    const { createDiagnosticsRelay } = await import("./loader/diagnostics-relay.ts")
    const events: LogEvent[] = []
    const relay = createDiagnosticsRelay(createDiagnostics({ emit: (e) => events.push(e) }))
    const entries = await loadPluginTransforms(
      { id: "probe", entry: "./transforms.ts", timeoutMs: Number.NaN },
      dir,
      "chain-probe",
      relay,
    )
    expect(entries.map((e) => (e.decl as TimedToolResultTransformDecl).timeoutMs)).toEqual([
      2000, 2000, 2000, 2000, 2000,
    ])
    const clamped = bySource(events, "tool-result-chain.timeout-clamped")
    expect(clamped).toHaveLength(5)
    expect(clamped[0]?.structuredData).toEqual({
      pluginId: "chain-probe",
      phase: "clamp",
      requested: "NaN",
      applied: 2000,
    })
  })
})

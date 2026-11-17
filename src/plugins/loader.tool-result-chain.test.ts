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
import { SidebandCodecMissingError, SidebandRegistryFrozenError } from "../sideband/errors.ts"

import {
  rawSidebandRegistryOf,
  type TimedToolResultTransformDecl,
} from "./loader/tool-result-chain-boot.ts"
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

  it("the registry behind the loader view is frozen: a late register throws (M3)", async () => {
    writeChainProbe(PLUGINS)
    const { loader } = await load()
    const raw = rawSidebandRegistryOf(loader.sidebandRegistry())
    expect(raw).toBeDefined()
    expect(raw?.kind(CHAIN_PROBE_KIND)?.owner).toBe("chain-probe")
    expect(() => raw?.register(chainProbeKind("late-kind") as never, "late")).toThrow(
      SidebandRegistryFrozenError,
    )
    expect(rawSidebandRegistryOf({ ...loader.sidebandRegistry() })).toBeUndefined()
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
      { pluginId: "chain-probe", reason: "module-missing" },
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
      { pluginId: "chain-probe", reason: "not-array" },
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
      { pluginId: "chain-probe", reason: "import-threw" },
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

  describe("sideband error paths (M1, M2, CODEC)", () => {
    const codecFailed = (events: LogEvent[]) =>
      bySource(events, "sideband.codec-failed").map((e) => e.structuredData)
    const codecLoadFailed = (events: LogEvent[]) =>
      bySource(events, "sideband.codec-load-failed").map((e) => e.structuredData)

    it("the codec stays lazy: load does not call the factory, the first codec() call does", async () => {
      writeChainProbe(PLUGINS, {
        id: "lazy-codec",
        codecSource:
          "export default () => { (globalThis as any).__lazyCodecCalls = ((globalThis as any).__lazyCodecCalls ?? 0) + 1; return { marker: 'lazy' } }\n",
      })
      const g = globalThis as unknown as { __lazyCodecCalls?: number }
      g.__lazyCodecCalls = 0
      const { loader, events } = await load()
      expect(g.__lazyCodecCalls).toBe(0)
      const codec = loader.sidebandRegistry().codec() as unknown as { marker: string }
      expect(codec.marker).toBe("lazy")
      expect(loader.sidebandRegistry().codec()).toBe(codec as never)
      expect(g.__lazyCodecCalls).toBe(1)
      expect(codecFailed(events)).toEqual([])
    })

    it("M1: a codec import that never settles: boot ends, one codec-load-failed timeout, no codec", async () => {
      const dir = writeChainProbe(PLUGINS, {
        id: "hang-codec-import",
        codecSource: "await new Promise(() => {})\nexport default () => ({})\n",
      })
      const { bootSidebandRegistry } = await import("./loader/tool-result-chain-boot.ts")
      const { createDiagnosticsRelay } = await import("./loader/diagnostics-relay.ts")
      const events: LogEvent[] = []
      const relay = createDiagnosticsRelay(createDiagnostics({ emit: (e) => events.push(e) }))
      const plugin = {
        packageDir: dir,
        manifest: {
          id: "hang-codec-import",
          sideband: [chainProbeKind()],
          sidebandCodec: { id: "probe-codec", entry: "./codec.ts" },
        },
      }
      const started = Date.now()
      const registry = await bootSidebandRegistry([plugin as never], relay, { timeoutMs: 50 })
      expect(Date.now() - started).toBeLessThan(1500)
      expect(codecLoadFailed(events)).toEqual([{ plugin: "hang-codec-import", reason: "timeout" }])
      expect(codecFailed(events)).toEqual([])
      expect(() => registry.codec()).toThrow(SidebandCodecMissingError)
      expect(registry.kind(CHAIN_PROBE_KIND)?.owner).toBe("hang-codec-import")
    })

    it("M2: a codec factory that throws: one codec-failed error, cached, then no codec", async () => {
      writeChainProbe(PLUGINS, {
        id: "throw-codec",
        codecSource:
          "export default () => { (globalThis as any).__throwCodecCalls = ((globalThis as any).__throwCodecCalls ?? 0) + 1; throw new Error('boom') }\n",
      })
      const g = globalThis as unknown as { __throwCodecCalls?: number }
      g.__throwCodecCalls = 0
      const { loader, events } = await load()
      expect(codecFailed(events)).toEqual([])
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      expect(codecFailed(events)).toEqual([{ pluginId: "throw-codec", reason: "error" }])
      expect(g.__throwCodecCalls).toBe(1)
      expect(codecLoadFailed(events)).toEqual([])
      expect(loader.sidebandRegistry().kind(CHAIN_PROBE_KIND)?.owner).toBe("throw-codec")
      expect(loader.hasTool("ProbeTool")).toBe(true)
    })

    it("M2: a codec factory that returns a thenable: one codec-failed async, not awaited, cached", async () => {
      writeChainProbe(PLUGINS, {
        id: "then-codec",
        codecSource:
          "export default () => { (globalThis as any).__thenCodecCalls = ((globalThis as any).__thenCodecCalls ?? 0) + 1; return { then() { (globalThis as any).__thenCodecAwaited = true } } }\n",
      })
      const g = globalThis as unknown as { __thenCodecCalls?: number; __thenCodecAwaited?: boolean }
      g.__thenCodecCalls = 0
      g.__thenCodecAwaited = false
      const { loader, events } = await load()
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      await Promise.resolve()
      expect(codecFailed(events)).toEqual([{ pluginId: "then-codec", reason: "async" }])
      expect(g.__thenCodecCalls).toBe(1)
      expect(g.__thenCodecAwaited).toBe(false)
    })

    it("M2: an async function codec factory: reason async, one diagnostic after 2 calls", async () => {
      writeChainProbe(PLUGINS, {
        id: "async-codec",
        codecSource: "export default async () => ({ marker: 'async-codec' })\n",
      })
      const { loader, events } = await load()
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
      expect(codecFailed(events)).toEqual([{ pluginId: "async-codec", reason: "async" }])
    })

    it("M2: two plugins with sidebandCodec: the second gets reason duplicate, the first codec stays", async () => {
      writeChainProbe(PLUGINS, {
        id: "dca-probe",
        toolName: "DcaTool",
        phases: [],
        codecSource: "export default () => ({ marker: 'dca' })\n",
      })
      writeChainProbe(PLUGINS, {
        id: "dcb-probe",
        toolName: "DcbTool",
        phases: [],
        sidebandKinds: [],
        codecSource: "export default () => ({ marker: 'dcb' })\n",
      })
      const { loader, events } = await load()
      expect(codecLoadFailed(events)).toEqual([{ plugin: "dcb-probe", reason: "duplicate" }])
      const codec = loader.sidebandRegistry().codec() as unknown as { marker: string }
      expect(codec.marker).toBe("dca")
      expect(codecFailed(events)).toEqual([])
      expect(loader.hasTool("DcaTool")).toBe(true)
      expect(loader.hasTool("DcbTool")).toBe(true)
    })

    it("M2: a codec module with no function default export: reason not-function", async () => {
      writeChainProbe(PLUGINS, { id: "nofn-codec", codecSource: "export default 42\n" })
      const { loader, events } = await load()
      expect(codecLoadFailed(events)).toEqual([{ plugin: "nofn-codec", reason: "not-function" }])
      expect(() => loader.sidebandRegistry().codec()).toThrow(SidebandCodecMissingError)
    })

    it("M2: a codec module that throws on import: reason import-threw", async () => {
      writeChainProbe(PLUGINS, {
        id: "imp-codec",
        codecSource: "throw new Error('boom')\nexport default () => ({})\n",
      })
      const { loader, events } = await load()
      expect(codecLoadFailed(events)).toEqual([{ plugin: "imp-codec", reason: "import-threw" }])
      expect(loader.hasTool("ProbeTool")).toBe(true)
    })

    it("M2: the same sideband kind in two plugins: the second is rejected, the first owner stays", async () => {
      writeChainProbe(PLUGINS, { id: "dka-probe", toolName: "DkaTool", phases: ["final"] })
      writeChainProbe(PLUGINS, { id: "dkb-probe", toolName: "DkbTool", phases: ["final"] })
      const { loader, events } = await load()
      expect(bySource(events, "sideband.kind-rejected").map((e) => e.structuredData)).toEqual([
        { plugin: "dkb-probe", kind: CHAIN_PROBE_KIND, error: "SidebandKindDuplicateError" },
      ])
      expect(loader.sidebandRegistry().kind(CHAIN_PROBE_KIND)?.owner).toBe("dka-probe")
      expect(loader.hasTool("DkaTool")).toBe(true)
      expect(loader.hasTool("DkbTool")).toBe(true)
      expect(loader.toolResultChain().map((e) => e.pluginId)).toEqual(["dka-probe", "dkb-probe"])
    })
  })

  describe("a plugin decl that throws when read (F3)", () => {
    const GOOD = { toolName: "GoodTool", phases: ["final"], sidebandKinds: [] }
    const cases: { name: string; id: string; source: string }[] = [
      {
        name: "a throwing phase getter",
        id: "f3-phase",
        source:
          "export default [{ get phase() { throw new Error('x') }, order: 0, transform: (s) => s }]\n",
      },
      {
        name: "a Proxy list whose iteration throws",
        id: "f3-proxy",
        source:
          "export default new Proxy([{ phase: 'final', order: 0, transform: (s) => s }], { get(t, k) { if (k === Symbol.iterator) throw new Error('x'); return Reflect.get(t, k) } })\n",
      },
      {
        name: "a throwing transform getter",
        id: "f3-transform",
        source:
          "export default () => [{ phase: 'clamp', order: 0, get transform() { throw new Error('x') } }]\n",
      },
    ]
    for (const c of cases) {
      it(`${c.name}: one decl-threw diagnostic, load ends, the other plugin loads`, async () => {
        writeChainProbe(PLUGINS, {
          id: c.id,
          toolName: "BadTool",
          entry: `./${c.id}.ts`,
          transformsSource: c.source,
        })
        writeChainProbe(PLUGINS, { id: `${c.id}-good`, ...GOOD })
        const { loader, events } = await load()
        expect(
          bySource(events, "tool-result-chain.load-failed").map((e) => e.structuredData),
        ).toEqual([{ pluginId: c.id, reason: "decl-threw" }])
        expect(loader.toolResultChain().map((e) => `${e.pluginId}:${e.decl.phase}`)).toEqual([
          `${c.id}-good:final`,
        ])
        expect(loader.hasTool("BadTool")).toBe(true)
        expect(loader.hasTool("GoodTool")).toBe(true)
        expect(loader.sidebandRegistry().kind(CHAIN_PROBE_KIND)?.owner).toBe(c.id)
      })
    }

    it("a kept decl is a snapshot: a later change of the plugin object has no effect", async () => {
      writeChainProbe(PLUGINS, {
        entry: "./snapshot.ts",
        transformsSource:
          "const d = { phase: 'final', order: 3, transform(s) { return s } }\n;(globalThis as any).__f3Decl = d\nexport default [d]\n",
      })
      const { loader } = await load()
      const g = globalThis as unknown as { __f3Decl: { phase: string; order: number } }
      g.__f3Decl.phase = "clamp"
      g.__f3Decl.order = 9
      const [entry] = loader.toolResultChain()
      expect(entry?.decl.phase).toBe("final")
      expect(entry?.decl.order).toBe(3)
      expect(Object.isFrozen(entry?.decl)).toBe(true)
    })

    it("F7: a transform that is a Proxy function with a throwing getOwnPropertyDescriptor trap", async () => {
      writeChainProbe(PLUGINS, {
        id: "f7-proxy-fn",
        toolName: "BadTool",
        entry: "./f7.ts",
        transformsSource:
          "const fn = new Proxy(function (this: any, s: any) { return { ...s, content: s.content + ':' + this.tag } }, { getOwnPropertyDescriptor() { throw new Error('x') } })\nexport default [{ phase: 'final', order: 0, tag: 'self', transform: fn }]\n",
      })
      writeChainProbe(PLUGINS, { id: "f7-good", ...GOOD })
      const { loader, events } = await load()
      const chainDiags = events.filter(
        (e) =>
          e.source.startsWith("tool-result-chain.") &&
          (e.structuredData as { pluginId?: string; plugin?: string } | undefined)?.pluginId ===
            "f7-proxy-fn",
      )
      expect(chainDiags.length).toBeLessThanOrEqual(1)
      expect(
        loader
          .toolResultChain()
          .map((e) => e.pluginId)
          .sort(),
      ).toEqual(["f7-good", "f7-proxy-fn"])
      expect(loader.hasTool("GoodTool")).toBe(true)
      const stage = loader.toolResultChain().find((e) => e.pluginId === "f7-proxy-fn")?.decl
      const out = await stage?.transform({ content: "a" } as never)
      expect((out as { content: string }).content).toBe("a:self")
    })
  })

  describe("M1: a hanging transforms import", () => {
    const run = async (entry: string, source: string) => {
      const dir = writeChainProbe(PLUGINS, { entry, transformsSource: source })
      const { loadPluginTransforms } = await import("./loader/tool-result-chain-boot.ts")
      const { createDiagnosticsRelay } = await import("./loader/diagnostics-relay.ts")
      const events: LogEvent[] = []
      const relay = createDiagnosticsRelay(createDiagnostics({ emit: (e) => events.push(e) }))
      const started = Date.now()
      const entries = await loadPluginTransforms(
        { id: "probe", entry },
        dir,
        "chain-probe",
        relay,
        50,
      )
      expect(Date.now() - started).toBeLessThan(1500)
      expect(entries).toEqual([])
      expect(
        bySource(events, "tool-result-chain.load-failed").map((e) => e.structuredData),
      ).toEqual([{ pluginId: "chain-probe", reason: "timeout" }])
    }

    it("a module import that never settles: load ends, one timeout diagnostic", async () => {
      await run("./hang-import.ts", "await new Promise(() => {})\nexport default []\n")
    })

    it("an async default-export factory that never settles: load ends, one timeout diagnostic", async () => {
      await run("./hang-factory.ts", "export default () => new Promise(() => {})\n")
    })
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

  describe("stage time limit (timeoutMs), manifest value", () => {
    const cases: {
      name: string
      requested?: unknown
      applied: number
      reason?: "invalid" | "clamped"
    }[] = [
      { name: "absent -> 2000, no diagnostic", applied: 2000 },
      { name: "in range -> same, no diagnostic", requested: 500, applied: 500 },
      { name: "2000 -> 2000, no diagnostic", requested: 2000, applied: 2000 },
      { name: "1 -> 1, no diagnostic", requested: 1, applied: 1 },
      { name: "non-integer floored, no diagnostic", requested: 750.9, applied: 750 },
      { name: "1.5 floors to 1, no diagnostic", requested: 1.5, applied: 1 },
      { name: "0.5 floors to 0 -> 1, clamped", requested: 0.5, applied: 1, reason: "clamped" },
      { name: "0 -> 1, clamped", requested: 0, applied: 1, reason: "clamped" },
      { name: "negative -> 1, clamped", requested: -5, applied: 1, reason: "clamped" },
      { name: "above max -> 2000, clamped", requested: 5000, applied: 2000, reason: "clamped" },
      { name: "2000.5 floors to 2000, no diagnostic", requested: 2000.5, applied: 2000 },
      { name: "string -> 2000, invalid", requested: "100", applied: 2000, reason: "invalid" },
      { name: "null -> 2000, invalid", requested: null, applied: 2000, reason: "invalid" },
    ]
    for (const c of cases) {
      it(c.name, async () => {
        writeChainProbe(PLUGINS, "requested" in c ? { timeoutMs: c.requested } : {})
        const { loader, events } = await load()
        expect(timeoutOf(loader)).toEqual([c.applied, c.applied, c.applied, c.applied, c.applied])
        const clamped = bySource(events, "tool-result-chain.timeout-clamped")
        if (c.reason === undefined) {
          expect(clamped).toEqual([])
          return
        }
        // One diagnostic per changed stage.
        expect(clamped.map((e) => e.structuredData)).toEqual(
          CHAIN_PROBE_PHASES.map((phase) => ({
            pluginId: "chain-probe",
            phase,
            requested: typeof c.requested === "number" ? c.requested : String(c.requested),
            applied: c.applied,
            reason: c.reason ?? "",
          })),
        )
      })
    }
  })

  describe("stage time limit (timeoutMs), decl value (F5)", () => {
    const cases: {
      name: string
      decl?: string
      manifest?: unknown
      applied: number
      diag?: { requested: number | string; reason: "invalid" | "clamped" }
    }[] = [
      { name: "decl 50 + no manifest = 50", decl: "50", applied: 50 },
      { name: "decl 50 + manifest 1000 = 50", decl: "50", manifest: 1000, applied: 50 },
      { name: "no decl + manifest 1000 = 1000", manifest: 1000, applied: 1000 },
      { name: "no decl + no manifest = 2000", applied: 2000 },
      {
        name: "decl 5000 = 2000, one clamped diagnostic",
        decl: "5000",
        applied: 2000,
        diag: { requested: 5000, reason: "clamped" },
      },
      {
        name: "decl 'abc' + manifest 1000 = 1000, one invalid diagnostic",
        decl: "'abc'",
        manifest: 1000,
        applied: 1000,
        diag: { requested: "abc", reason: "invalid" },
      },
      {
        name: "decl null + no manifest = 2000, one invalid diagnostic",
        decl: "null",
        applied: 2000,
        diag: { requested: "null", reason: "invalid" },
      },
      {
        name: "decl NaN + manifest 300 = 300, one invalid diagnostic",
        decl: "NaN",
        manifest: 300,
        applied: 300,
        diag: { requested: "NaN", reason: "invalid" },
      },
      {
        name: "decl Infinity + manifest 'x' = 2000, one invalid diagnostic",
        decl: "Infinity",
        manifest: "x",
        applied: 2000,
        diag: { requested: "Infinity", reason: "invalid" },
      },
      {
        name: "decl '100' (a string) = 2000, one invalid diagnostic",
        decl: "'100'",
        applied: 2000,
        diag: { requested: "100", reason: "invalid" },
      },
      { name: "decl 75.8 floors to 75, no diagnostic", decl: "75.8", applied: 75 },
    ]
    cases.forEach((c, i) => {
      it(c.name, async () => {
        const field = c.decl === undefined ? "" : `, timeoutMs: ${c.decl}`
        writeChainProbe(PLUGINS, {
          entry: `./f5-${i}.ts`,
          transformsSource: `export default [{ phase: 'final', order: 0, transform: (s) => s${field} }]\n`,
          ...(c.manifest !== undefined ? { timeoutMs: c.manifest } : {}),
        })
        const { loader, events } = await load()
        expect(timeoutOf(loader)).toEqual([c.applied])
        const clamped = bySource(events, "tool-result-chain.timeout-clamped").map(
          (e) => e.structuredData,
        )
        expect(clamped).toEqual(
          c.diag === undefined
            ? []
            : [{ pluginId: "chain-probe", phase: "final", applied: c.applied, ...c.diag }],
        )
      })
    })
  })

  it("resolveStageTimeout: NaN and Infinity are invalid (JSON cannot hold them)", async () => {
    const { resolveStageTimeout } = await import("./loader/tool-result-chain-boot.ts")
    const invalid = (requested: unknown) => ({ requested, reason: "invalid" as const })
    expect(resolveStageTimeout(Number.NaN)).toEqual({ applied: 2000, change: invalid(Number.NaN) })
    expect(resolveStageTimeout(Number.POSITIVE_INFINITY)).toEqual({
      applied: 2000,
      change: invalid(Number.POSITIVE_INFINITY),
    })
    expect(resolveStageTimeout(undefined, Number.NEGATIVE_INFINITY)).toEqual({
      applied: 2000,
      change: invalid(Number.NEGATIVE_INFINITY),
    })
    expect(resolveStageTimeout(undefined)).toEqual({ applied: 2000 })
    expect(resolveStageTimeout(50, 1000)).toEqual({ applied: 50 })
    expect(resolveStageTimeout("abc", 5000)).toEqual({ applied: 2000, change: invalid("abc") })
  })

  it("NaN manifest value through loadPluginTransforms: one invalid diagnostic per stage", async () => {
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
      reason: "invalid",
    })
  })
})

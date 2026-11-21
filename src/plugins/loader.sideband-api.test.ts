/**
 * Loader side of the sideband API (design step 2): core kind names with the
 * first-declaration rule (D1 revised), the derived `sideband:<kind>` contracts, `loader.sideband()`, the
 * sideband-only boot and the `./host/sideband` export.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  loadSidebandOnly,
  NO_SIDEBAND,
  SidebandKindUnknownError,
  sidebandOf,
} from "@minimal-agent/core/host/sideband"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { createDiagnosticsRelay } from "./loader/diagnostics-relay.ts"
import { withDerivedProvides } from "./loader/discovery.ts"
import { bootSidebandRegistry } from "./loader/tool-result-chain-boot.ts"
import {
  CHAIN_PROBE_KIND,
  type ChainProbeOptions,
  chainProbeKind,
  chainProbeManifest,
  writeChainProbe,
} from "./loader.chain-probe.fixtures.ts"
import { PluginLoader } from "./loader.ts"
import type { ManifestFile } from "./types.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-sideband-api-tests")
const PLUGINS = join(ROOT, "plugins")
const NO_PROJECT = join(ROOT, "nope-project")

const plugin = (id: string, over: Record<string, unknown> = {}) =>
  ({ packageDir: join(ROOT, id), manifest: { id, ...over } }) as never

const quietRelay = (events: LogEvent[] = []) =>
  createDiagnosticsRelay(createDiagnostics({ emit: (e) => events.push(e) }))

describe("core kind names: the first declaration wins (design D1 revised)", () => {
  const coreKind = chainProbeKind("policy")

  it("a non-required plugin can declare policy when no other plugin does", async () => {
    const events: LogEvent[] = []
    const registry = await bootSidebandRegistry(
      [plugin("p", { sideband: [coreKind] })],
      quietRelay(events),
    )
    expect(registry.kind("policy")?.owner).toBe("p")
    expect(events.filter((e) => e.source === "sideband.kind-rejected")).toEqual([])
  })

  it("two plugins with policy: the first in boot order wins, the second is rejected", async () => {
    const events: LogEvent[] = []
    const registry = await bootSidebandRegistry(
      [
        plugin("first", { sideband: [coreKind] }),
        plugin("second", { required: true, sideband: [coreKind] }),
      ],
      quietRelay(events),
    )
    expect(registry.kind("policy")?.owner).toBe("first")
    const rejected = events.filter((e) => e.source === "sideband.kind-rejected")
    expect(rejected.map((e) => e.structuredData)).toEqual([
      {
        pluginId: "second",
        kind: "policy",
        error: "SidebandKindDuplicateError",
      },
    ])
  })
})

describe("withDerivedProvides: sideband:<kind>", () => {
  it("adds one contract for each manifest kind", () => {
    const m = {
      id: "p",
      provides: ["x"],
      sideband: [chainProbeKind("a-kind"), chainProbeKind("b-kind")],
    } as unknown as ManifestFile
    expect(withDerivedProvides(m).provides).toEqual(["x", "sideband:a-kind", "sideband:b-kind"])
  })
})

describe("loader.sideband() and the host export", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(PLUGINS, { recursive: true })
    writeChainProbe(PLUGINS)
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("gives one API for each load; no codec: not ready, empty render, one diagnostic", async () => {
    const events: LogEvent[] = []
    const loader = await PluginLoader.load({
      roots: { embedded: [PLUGINS], project: [NO_PROJECT] },
      diagnostics: createDiagnostics({ emit: (e) => events.push(e) }),
      disabledPluginIds: new Set(),
      logger: () => {},
    })
    const api = loader.sideband()
    expect(sidebandOf(loader)).toBe(api)
    expect(api.ready).toBe(false)
    expect(api.kinds().map((k) => k.kind)).toEqual([CHAIN_PROBE_KIND])
    expect(api.render(CHAIN_PROBE_KIND, { body: "x" })).toBe("")
    expect(api.render(CHAIN_PROBE_KIND)).toBe("")
    const dropped = events.filter((e) => e.source === "sideband.render-dropped")
    expect(dropped.map((e) => e.structuredData)).toEqual([{ kind: CHAIN_PROBE_KIND }])
    expect(api.has("anything")).toBe(false)
  })

  it("loadSidebandOnly boots the kinds with no handler import", async () => {
    const api = await loadSidebandOnly({
      roots: { embedded: [PLUGINS], project: [NO_PROJECT] },
      diagnostics: createDiagnostics({ emit: () => {} }),
    })
    expect(api.kinds().map((k) => k.kind)).toEqual([CHAIN_PROBE_KIND])
    expect(api.ready).toBe(false)
  })

  it("exports NO_SIDEBAND and the unknown kind error", () => {
    expect(NO_SIDEBAND.ready).toBe(false)
    expect(new SidebandKindUnknownError("x").sidebandKind).toBe("x")
  })
})

describe("a duplicate kind of a required plugin (finding 3)", () => {
  const EMB = join(ROOT, "dup-embedded")
  const PROJECT = join(ROOT, "dup-project")
  beforeAll(() => {
    mkdirSync(EMB, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
    const req: ChainProbeOptions = {
      id: "req-kinds",
      sidebandKinds: [chainProbeKind("dup-kind")],
    }
    const dir = writeChainProbe(EMB, req)
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...chainProbeManifest(req), required: true }, null, 2),
    )
    writeChainProbe(PROJECT, {
      id: "proj-kinds",
      toolName: "ProjProbeTool",
      sidebandKinds: [chainProbeKind("dup-kind")],
    })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("gives sideband.kind-rejected, not boot.contract_duplicate, and does not throw in fail mode", async () => {
    const events: LogEvent[] = []
    const loader = await PluginLoader.load({
      roots: { embedded: [EMB], project: [PROJECT] },
      diagnostics: createDiagnostics({ emit: (e) => events.push(e) }),
      disabledPluginIds: new Set(),
      contractCheckMode: "fail",
      logger: () => {},
    })
    const ids = loader.loadedPackages().map((p) => p.id)
    expect(ids).toContain("req-kinds")
    expect(ids).toContain("proj-kinds")
    expect(events.filter((e) => e.source === "boot.contract_duplicate")).toEqual([])
    const rejected = events.filter((e) => e.source === "sideband.kind-rejected")
    expect(rejected.map((e) => (e.structuredData as { kind: string }).kind)).toEqual(["dup-kind"])
    expect(
      loader
        .sideband()
        .kinds()
        .map((k) => k.kind),
    ).toEqual(["dup-kind"])
  })
})

describe("two plugins declare the core kind policy (design D1 revised)", () => {
  const EMB = join(ROOT, "policy-embedded")
  const PROJECT = join(ROOT, "policy-project")
  beforeAll(() => {
    mkdirSync(EMB, { recursive: true })
    mkdirSync(PROJECT, { recursive: true })
    const req: ChainProbeOptions = {
      id: "req-policy",
      sidebandKinds: [chainProbeKind("policy")],
    }
    const dir = writeChainProbe(EMB, req)
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...chainProbeManifest(req), required: true }, null, 2),
    )
    writeChainProbe(PROJECT, {
      id: "proj-policy",
      toolName: "ProjPolicyTool",
      sidebandKinds: [chainProbeKind("policy")],
    })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("the first in boot order wins, the second gets sideband.kind-rejected, fail mode does not throw", async () => {
    const events: LogEvent[] = []
    const loader = await PluginLoader.load({
      roots: { embedded: [EMB], project: [PROJECT] },
      diagnostics: createDiagnostics({ emit: (e) => events.push(e) }),
      disabledPluginIds: new Set(),
      contractCheckMode: "fail",
      logger: () => {},
    })
    const order = loader
      .loadedPackages()
      .map((p) => p.id)
      .filter((id) => id === "req-policy" || id === "proj-policy")
    expect(order.length).toBe(2)
    const [first, second] = order
    const kinds = loader
      .sideband()
      .kinds()
      .filter((k) => k.kind === "policy")
    expect(kinds.map((k) => k.owner)).toEqual([first])
    const rejected = events.filter((e) => e.source === "sideband.kind-rejected")
    expect(rejected.map((e) => e.structuredData)).toEqual([
      { pluginId: second, kind: "policy", error: "SidebandKindDuplicateError" },
    ])
    expect(events.filter((e) => e.source === "boot.contract_duplicate")).toEqual([])
  })
})

describe("loadSidebandOnly skips a plugin as the loader does (finding 4)", () => {
  const DIR = join(ROOT, "skip-plugins")
  beforeAll(() => {
    mkdirSync(DIR, { recursive: true })
    writeChainProbe(DIR, {
      id: "keep-a",
      sidebandKinds: [chainProbeKind("kept-kind")],
    })
    // The same tool name: the loader skips the whole plugin.
    writeChainProbe(DIR, {
      id: "keep-b",
      sidebandKinds: [chainProbeKind("skipped-kind")],
    })
  })
  afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

  it("a plugin with a tool collision gives no kind, in the loader and in the sideband-only boot", async () => {
    const roots = { embedded: [DIR], project: [NO_PROJECT] }
    const loader = await PluginLoader.load({
      roots,
      diagnostics: createDiagnostics({ emit: () => {} }),
      disabledPluginIds: new Set(),
      logger: () => {},
    })
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["keep-a"])
    expect(
      loader
        .sideband()
        .kinds()
        .map((k) => k.kind),
    ).toEqual(["kept-kind"])
    const api = await loadSidebandOnly({
      roots,
      diagnostics: createDiagnostics({ emit: () => {} }),
    })
    expect(api.kinds().map((k) => k.kind)).toEqual(["kept-kind"])
  })

  it("a core tool name skips the plugin too", async () => {
    const api = await loadSidebandOnly({
      roots: { embedded: [DIR], project: [NO_PROJECT] },
      diagnostics: createDiagnostics({ emit: () => {} }),
      coreToolNames: new Set(["ProbeTool"]),
    })
    expect(api.kinds()).toEqual([])
  })
})

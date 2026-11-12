import { mkdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"

import { writePackage } from "./loader.fixtures.ts"
import { PluginLoader } from "./loader.ts"

const ROOT = resolve(__dirname, "../../tmp/loader-required-tests")
const EMBEDDED = join(ROOT, "embedded")
const USER = join(ROOT, "user")
const NO_PROJECT = join(ROOT, "nope-project")

function pkg(root: string, id: string, extra: Record<string, unknown> = {}): void {
  writePackage(root, id, { id, name: id, version: "0.1.0", description: "test", ...extra })
}

async function load(opts: {
  disabled?: string[]
  requiredContracts?: string[]
}): Promise<{ loader: PluginLoader; events: LogEvent[] }> {
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  const loader = await PluginLoader.load({
    embeddedDir: EMBEDDED,
    userDir: USER,
    roots: { project: [NO_PROJECT] },
    diagnostics,
    disabledPluginIds: new Set(opts.disabled ?? []),
    ...(opts.requiredContracts ? { requiredContracts: opts.requiredContracts } : {}),
  })
  return { loader, events }
}

const bySource = (events: LogEvent[], source: string): LogEvent[] =>
  events.filter((e) => e.source === source)

describe("required plugin flag (warn mode)", () => {
  beforeAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(EMBEDDED, { recursive: true })
    mkdirSync(USER, { recursive: true })
  })
  afterEach(() => {
    rmSync(join(EMBEDDED, "plugins"), { recursive: true, force: true })
    rmSync(join(USER, "plugins"), { recursive: true, force: true })
  })
  afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true })
  })

  it("refuses to disable a required plugin and records a diagnostic", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(EMBEDDED, "opt-a")
    const { loader, events } = await load({ disabled: ["req-a", "opt-a"] })
    const ids = loader.loadedPackages().map((p) => p.id)
    expect(ids).toContain("req-a")
    expect(ids).not.toContain("opt-a")
    const refused = bySource(events, "plugin.required_disable_refused")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.message).toBe("")
    expect(refused[0]?.structuredData).toEqual({ pluginId: "req-a" })
  })

  it("contract check: 0 providers records boot.contract_missing and still boots", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    const { loader, events } = await load({ requiredContracts: ["c.one", "c.none"] })
    expect(loader.loadedPackages().map((p) => p.id)).toEqual(["req-a"])
    const missing = bySource(events, "boot.contract_missing")
    expect(missing.map((e) => e.structuredData)).toEqual([{ contract: "c.none" }])
    expect(missing[0]?.message).toBe("")
    expect(bySource(events, "boot.contract_duplicate")).toHaveLength(0)
  })

  it("contract check: exactly 1 provider records nothing", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    const { events } = await load({ requiredContracts: ["c.one"] })
    expect(bySource(events, "boot.contract_missing")).toHaveLength(0)
    expect(bySource(events, "boot.contract_duplicate")).toHaveLength(0)
  })

  it("contract check: 2 providers records boot.contract_duplicate and still boots", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(EMBEDDED, "req-b", { required: true, provides: ["c.one"] })
    const { loader, events } = await load({})
    expect(loader.loadedPackages()).toHaveLength(2)
    const dup = bySource(events, "boot.contract_duplicate")
    expect(dup).toHaveLength(1)
    expect(dup[0]?.structuredData).toEqual({ contract: "c.one", providers: "req-a,req-b" })
  })

  it("shadow accept: a required copy that provides every embedded contract wins", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", { required: true, provides: ["c.one", "c.two"] })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(USER, "plugins", "req-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(0)
  })

  it("shadow refuse: a copy that is not required keeps the embedded copy", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", { provides: ["c.one"] })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
    const refused = bySource(events, "plugin.required_shadow_refused")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.structuredData).toMatchObject({
      pluginId: "req-a",
      droppedRoot: "user",
      keptRoot: "embedded",
    })
  })

  it("shadow refuse: a required copy missing a contract keeps the embedded copy", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one", "c.two"] })
    pkg(USER, "req-a", { required: true, provides: ["c.one"] })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(1)
  })

  it("a non-required id shadows as before", async () => {
    pkg(EMBEDDED, "opt-a")
    pkg(USER, "opt-a")
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "opt-a")
    expect(winner?.packageDir).toBe(join(USER, "plugins", "opt-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(0)
  })
  it("shadow refuse: the id never vanishes when the embedded copy is skipped later", async () => {
    pkg(EMBEDDED, "req-a", {
      required: true,
      provides: ["c.one"],
      platforms: [process.platform === "win32" ? "linux" : "windows"],
    })
    pkg(USER, "req-a", { provides: ["c.one"] })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(USER, "plugins", "req-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(0)
  })

  it("shadow refuse: winner without provides is refused when the embedded copy provides", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", { required: true })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(1)
  })

  it("shadow accept: both required with no provides, the higher copy wins", async () => {
    pkg(EMBEDDED, "req-a", { required: true })
    pkg(USER, "req-a", { required: true })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(USER, "plugins", "req-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(0)
  })

  it("a required project copy over a non-required embedded copy wins (R-BOOT-7 is silent)", async () => {
    pkg(EMBEDDED, "opt-a")
    pkg(USER, "opt-a", { required: true })
    const { loader, events } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "opt-a")
    expect(winner?.packageDir).toBe(join(USER, "plugins", "opt-a"))
    expect(bySource(events, "plugin.required_shadow_refused")).toHaveLength(0)
  })
  it("a disabled non-required higher copy does not hide a required lower copy", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", { provides: ["c.one"] })
    const { loader, events } = await load({ disabled: ["req-a"] })
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
    const refused = bySource(events, "plugin.required_disable_refused")
    expect(refused).toHaveLength(1)
    expect(refused[0]?.message).toBe("")
  })

  it("a platform-skipped non-required higher copy does not hide a required lower copy", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", {
      platforms: [process.platform === "win32" ? "linux" : "windows"],
    })
    const { loader } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
  })

  it("a manifest-disabled non-required higher copy does not hide a required lower copy", async () => {
    pkg(EMBEDDED, "req-a", { required: true, provides: ["c.one"] })
    pkg(USER, "req-a", { enabled: false })
    const { loader } = await load({})
    const winner = loader.loadedPackages().find((p) => p.id === "req-a")
    expect(winner?.packageDir).toBe(join(EMBEDDED, "plugins", "req-a"))
  })
})

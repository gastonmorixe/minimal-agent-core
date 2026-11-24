import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../../diagnostics/hub.ts"
import { createSidebandRegistry } from "../../sideband/registry.ts"
import type { SidebandKind } from "../../sideband/types.ts"

import { createDiagnosticsRelay } from "./diagnostics-relay.ts"
import { loadDisplayHandlers } from "./sideband-display-boot.ts"

const ROOT = resolve(__dirname, "../../../tmp/sideband-display-boot-tests")
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

const decl: Omit<SidebandKind, "owner"> = {
  kind: "fake",
  direction: "to-model",
  placement: "inline",
  attrs: {},
  body: "none",
  trust: "untrusted",
  summary: "s",
}

function pkg(id: string, path: string, source?: string) {
  const dir = join(ROOT, id)
  mkdirSync(dir, { recursive: true })
  if (source !== undefined) writeFileSync(join(dir, path), source)
  return {
    packageDir: dir,
    manifest: { id, sideband: [{ ...decl, display: { handler: { type: "module", path } } }] },
  } as never
}

async function boot(plugins: never[], owner: string, timeoutMs?: number) {
  const r = createSidebandRegistry()
  r.register({ ...decl, owner: "" }, owner)
  r.freeze()
  const events: LogEvent[] = []
  const relay = createDiagnosticsRelay(createDiagnostics({ emit: (e) => events.push(e) }))
  const map = await loadDisplayHandlers(plugins, r, relay, timeoutMs)
  const diag: Array<Record<string, unknown>> = events.map((e) => ({
    source: e.source,
    ...e.structuredData,
  }))
  return { map, diag }
}

describe("loadDisplayHandlers", () => {
  it("loads the handler of an owned kind", async () => {
    const p = pkg("own", "d.ts", "export default () => ({ label: 'L' })\n")
    const { map, diag } = await boot([p], "own")
    expect(map.get("fake")?.owner).toBe("own")
    expect(map.get("fake")?.host).toBe(false)
    expect(typeof map.get("fake")?.fn).toBe("function")
    expect(diag).toEqual([])
  })

  it("skips a kind that another plugin owns", async () => {
    const p = pkg("thief", "d.ts", "export default () => ({ label: 'L' })\n")
    const { map, diag } = await boot([p], "real-owner")
    expect(map.size).toBe(0)
    expect(diag).toEqual([
      { source: "sideband.display-not-owner", pluginId: "thief", kind: "fake" },
    ])
  })

  it("path outside the package fails", async () => {
    const p = pkg("outside", "../escape.ts")
    const { map, diag } = await boot([p], "outside")
    expect(map.size).toBe(0)
    expect(diag).toEqual([
      {
        source: "sideband.display-load-failed",
        pluginId: "outside",
        kind: "fake",
        reason: "path-outside",
      },
    ])
  })

  it("non-function export fails", async () => {
    const p = pkg("nofn", "d.ts", "export default 42\n")
    const { map, diag } = await boot([p], "nofn")
    expect(map.size).toBe(0)
    expect(diag.map((d) => (d as { reason?: string }).reason)).toEqual(["not-function"])
  })

  it("a missing module fails", async () => {
    const p = pkg("gone", "none.ts")
    const { diag } = await boot([p], "gone")
    expect(diag.map((d) => (d as { reason?: string }).reason)).toEqual(["module-missing"])
  })

  it("import timeout fails", async () => {
    const p = pkg("hang", "d.ts", "await new Promise(() => {})\nexport default () => undefined\n")
    const started = Date.now()
    const { map, diag } = await boot([p], "hang", 50)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(map.size).toBe(0)
    expect(diag.map((d) => (d as { reason?: string }).reason)).toEqual(["timeout"])
  })
})

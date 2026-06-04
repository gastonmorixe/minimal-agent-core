import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { SetupBinarySpec } from "../plugins/types.ts"

import { inventoryAdapter, provisionSetups, toBinarySpec } from "./provision.ts"
import { BinaryStore } from "./store.ts"

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function fakeFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-length": String(Buffer.byteLength(body)) },
    })) as unknown as typeof fetch
}

describe("toBinarySpec", () => {
  it("maps fields verbatim incl. optional archiveMember", () => {
    const s: SetupBinarySpec = {
      name: "obscura",
      version: "1",
      source: { kind: "url", url: "https://x/o.tar.gz" },
      sha256: "a".repeat(64),
      archiveMember: "obscura",
    }
    expect(toBinarySpec(s)).toEqual(s)
  })
})

describe("inventoryAdapter", () => {
  it("projects store state read-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-prov-inv-"))
    try {
      const store = new BinaryStore(join(dir, "bin"))
      const inv = inventoryAdapter(store)
      expect(inv.dir).toBe(store.dir)
      expect(inv.has("obscura")).toBe(false)
      expect(inv.get("obscura")).toBeUndefined()
      expect(
        inv.status({
          name: "obscura",
          version: "1",
          source: { kind: "url", url: "https://x/o" },
          sha256: "a".repeat(64),
        }),
      ).toBe("missing")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("provisionSetups", () => {
  let dir: string
  let store: BinaryStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ma-prov-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("installs a missing required binary and reports it", async () => {
    const bytes = "binary-bytes"
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(bytes) })
    const summary = await provisionSetups(store, [
      {
        pluginId: "ma-fetch",
        result: {
          requireBinaries: [
            {
              name: "obscura",
              version: "0.1.6",
              source: { kind: "url", url: "https://x/obscura" },
              sha256: sha256(bytes),
            },
          ],
        },
      },
    ])
    expect(summary.installed).toEqual(["obscura"])
    expect(summary.halt).toBeUndefined()
    expect(store.has("obscura")).toBe(true)
    // Version is surfaced for the TUI row (`+obscura (0.1.6)`).
    expect(summary.versions.obscura).toBe("0.1.6")
  })

  it("skips an already-satisfied binary", async () => {
    const bytes = "v1"
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(bytes) })
    const spec: SetupBinarySpec = {
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://x/o" },
      sha256: sha256(bytes),
    }
    await store.install(toBinarySpec(spec))
    const summary = await provisionSetups(store, [
      { pluginId: "ma-fetch", result: { requireBinaries: [spec] } },
    ])
    expect(summary.satisfied).toEqual(["obscura"])
    expect(summary.installed).toEqual([])
  })

  it("records a failure and halts when the binary is mandatory", async () => {
    const bytes = "payload"
    // sha mismatch → install fails → still missing → halt fires.
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(bytes) })
    const summary = await provisionSetups(store, [
      {
        pluginId: "ma-fetch",
        result: {
          requireBinaries: [
            {
              name: "obscura",
              version: "0.1.6",
              source: { kind: "url", url: "https://x/o" },
              sha256: "b".repeat(64),
            },
          ],
          haltIfMissing: ["obscura"],
          haltMessage: "Fetch needs obscura. Set plugins.ma-fetch.obscura.bin or retry online.",
        },
      },
    ])
    expect(summary.failed.length).toBe(1)
    expect(summary.failed[0]?.name).toBe("obscura")
    expect(summary.halt).toBeDefined()
    expect(summary.halt?.missing).toEqual(["obscura"])
    expect(summary.halt?.message).toContain("obscura")
  })

  it("does not halt when a failed binary is not mandatory", async () => {
    const bytes = "payload"
    store = new BinaryStore(join(dir, "bin"), { fetchFn: fakeFetch(bytes) })
    const summary = await provisionSetups(store, [
      {
        pluginId: "ma-fetch",
        result: {
          requireBinaries: [
            {
              name: "obscura",
              version: "0.1.6",
              source: { kind: "url", url: "https://x/o" },
              sha256: "b".repeat(64),
            },
          ],
          // no haltIfMissing
        },
      },
    ])
    expect(summary.failed.length).toBe(1)
    expect(summary.halt).toBeUndefined()
  })

  it("updates an outdated binary", async () => {
    const v1 = "old"
    const v2 = "new-newer"
    const binDir = join(dir, "bin")
    const s1 = new BinaryStore(binDir, { fetchFn: fakeFetch(v1) })
    await s1.install({
      name: "obscura",
      version: "0.1.6",
      source: { kind: "url", url: "https://x/o" },
      sha256: sha256(v1),
    })

    const s2 = new BinaryStore(binDir, { fetchFn: fakeFetch(v2) })
    const summary = await provisionSetups(s2, [
      {
        pluginId: "ma-fetch",
        result: {
          requireBinaries: [
            {
              name: "obscura",
              version: "0.1.7",
              source: { kind: "url", url: "https://x/o2" },
              sha256: sha256(v2),
            },
          ],
        },
      },
    ])
    expect(summary.updated).toEqual(["obscura"])
  })
})

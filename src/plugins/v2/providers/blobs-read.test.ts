import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { createBlobsReadApi } from "./blobs-read.ts"

const dir = mkdtempSync(join(tmpdir(), "blobs-read-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const sid = "sid-blob"
mkdirSync(join(dir, `${sid}.blobs`), { recursive: true })
writeFileSync(join(dir, `${sid}.blobs`, "toolu_small.raw"), "small body")
writeFileSync(join(dir, `${sid}.blobs`, "toolu_big.raw"), "B".repeat(200_000))
writeFileSync(join(dir, `${sid}.blobs`, "not-a-blob.txt"), "ignored")

const api = createBlobsReadApi({ dir })

describe("blobs:read list", () => {
  it("lists only .raw blobs with sizes", async () => {
    const { items, total } = await api.list(sid)
    expect(total).toBe(2)
    const ids = items.map((i) => i.toolUseId).sort()
    expect(ids).toEqual(["toolu_big", "toolu_small"])
    const big = items.find((i) => i.toolUseId === "toolu_big")
    expect(big?.bytes).toBe(200_000)
  })

  it("returns empty for a session without blobs", async () => {
    const { items, total } = await api.list("no-such-sid")
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it("paginates", async () => {
    const page = await api.list(sid, { limit: 1, offset: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBe(2)
  })
})

describe("blobs:read read", () => {
  it("reads a small blob fully", async () => {
    const r = await api.read(sid, "toolu_small")
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.text).toBe("small body")
    expect(r.clipped).toBe(false)
    expect(r.bytes).toBe(10)
    expect(r.path).toContain("toolu_small.raw")
  })

  it("clamps a big blob to maxBytes and reports clipping", async () => {
    const r = await api.read(sid, "toolu_big", { maxBytes: 1000 })
    if (!r) throw new Error("expected blob")
    expect(r.clipped).toBe(true)
    expect(r.text.length).toBe(1000)
    expect(r.bytes).toBe(200_000)
  })

  it("returns null for a missing blob (stale pointer is normal)", async () => {
    expect(await api.read(sid, "toolu_gone")).toBeNull()
  })

  it("rejects path-traversal tool_use_ids", async () => {
    expect(await api.read(sid, "../../../etc/passwd")).toBeNull()
    expect(await api.read(sid, "a/b")).toBeNull()
  })
})

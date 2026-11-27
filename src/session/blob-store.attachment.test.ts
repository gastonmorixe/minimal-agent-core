/**
 * `BlobStore.writeAttachment`: a plugin tool attachment file
 * (`<stem>-<n>.<ext>`) is a blob for `list()`, `stats()` and the LRU caps.
 * The `.raw` form keeps its id and its rules.
 */
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { BlobStore, type BlobStoreConfig } from "./blob-store.ts"

const ROOT = join(import.meta.dirname, "..", "..", "tmp", `blob-attach-${process.pid}`)
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

let seq = 0
function mkStore(config: BlobStoreConfig = {}): BlobStore {
  return new BlobStore({ sid: "sid", dir: join(ROOT, `c${++seq}`, "sid.blobs"), config })
}

/** Set the mtime of a file, so the LRU order does not depend on the clock. */
function age(path: string, secondsAgo: number): void {
  const t = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(path, t, t)
}

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7)

describe("BlobStore.writeAttachment", () => {
  it("writes <id>-<n>.<ext> and gives path, size and hash", async () => {
    const s = mkStore()
    const r = await s.writeAttachment("toolu_1", 2, "png", bytes(10))
    expect(r?.path).toBe(join(s.dir, "toolu_1-2.png"))
    expect(r?.bytes).toBe(10)
    expect(r?.sha256).toHaveLength(16)
    expect([...readFileSync(r?.path ?? "")]).toEqual([...bytes(10)])
  })

  it("list() and stats() count the attachment files and the .raw blobs", async () => {
    const s = mkStore({ minBytesToPersist: 0 })
    s.write("toolu_1", "raw body")
    await s.writeAttachment("toolu_1", 1, "png", bytes(10))
    // Not a blob: other names in the dir.
    writeFileSync(join(s.dir, "_log.jsonl"), "{}\n")
    writeFileSync(join(s.dir, "notes.txt"), "x")
    expect(
      s
        .list()
        .map((b) => b.id)
        .sort(),
    ).toEqual(["toolu_1", "toolu_1-1.png"])
    expect(s.stats()).toEqual({ count: 2, bytes: 8 + 10 })
  })

  it("the count cap evicts the oldest blob, also an attachment, and keeps the new file", async () => {
    const s = mkStore({ minBytesToPersist: 0, maxBlobsPerSession: 2 })
    const a = await s.writeAttachment("toolu_a", 1, "png", bytes(4))
    age(a?.path ?? "", 30)
    s.write("toolu_b", "raw b")
    age(s.pathFor("toolu_b"), 20)
    await s.writeAttachment("toolu_c", 1, "png", bytes(4))
    expect(existsSync(a?.path ?? "")).toBe(false)
    expect(
      s
        .list()
        .map((b) => b.id)
        .sort(),
    ).toEqual(["toolu_b", "toolu_c-1.png"])
  })

  it("the byte cap evicts attachments too", async () => {
    const s = mkStore({ minBytesToPersist: 0, maxBytesPerSession: 25 })
    const a = await s.writeAttachment("toolu_a", 1, "png", bytes(10))
    age(a?.path ?? "", 30)
    const b = await s.writeAttachment("toolu_a", 2, "png", bytes(10))
    age(b?.path ?? "", 20)
    await s.writeAttachment("toolu_a", 3, "png", bytes(10))
    expect(s.list().map((x) => x.id)).toEqual(["toolu_a-2.png", "toolu_a-3.png"])
    expect(s.stats().bytes).toBe(20)
  })

  it("a .raw write also evicts an older attachment", () => {
    const s = mkStore({ minBytesToPersist: 0, maxBlobsPerSession: 1 })
    return s.writeAttachment("toolu_a", 1, "png", bytes(4)).then((a) => {
      age(a?.path ?? "", 30)
      s.write("toolu_b", "raw b")
      expect(s.list().map((x) => x.id)).toEqual(["toolu_b"])
    })
  })

  it("the store off, or empty bytes: no file and null", async () => {
    const off = mkStore({ enabled: false })
    expect(await off.writeAttachment("toolu_1", 1, "png", bytes(4))).toBeNull()
    expect(existsSync(off.dir)).toBe(false)
    const on = mkStore()
    expect(await on.writeAttachment("toolu_1", 1, "png", new Uint8Array(0))).toBeNull()
    expect(existsSync(on.dir)).toBe(false)
  })

  it("minBytesToPersist does not apply to an attachment", async () => {
    const s = mkStore({ minBytesToPersist: 4096 })
    expect(await s.writeAttachment("toolu_1", 1, "png", bytes(4))).not.toBeNull()
  })

  it("a bad extension becomes bin, and a write error gives null and onError", async () => {
    const errors: string[] = []
    const s = mkStore()
    expect((await s.writeAttachment("toolu_1", 1, "../x", bytes(4)))?.path).toBe(
      join(s.dir, "toolu_1-1.bin"),
    )
    // A file where the dir must be: mkdir fails.
    writeFileSync(join(ROOT, "blocked-file"), "x")
    const bad = new BlobStore({
      sid: "sid",
      dir: join(ROOT, "blocked-file", "sid.blobs"),
      onError: (_e, c) => errors.push(c),
    })
    expect(await bad.writeAttachment("toolu_1", 1, "png", bytes(4))).toBeNull()
    expect(errors).toHaveLength(1)
  })
})

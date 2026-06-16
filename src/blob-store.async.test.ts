/**
 * Async blob write: Bug 4 (UI-thread responsiveness).
 *
 * `BlobStore.write` does `writeFileSync` + a synchronous `Bun.CryptoHasher`
 * over the whole body. On the plugin result path the agent persists the
 * FULL (potentially multi-MB) tool body, so that sync fs + hash runs on
 * the same single thread that paints the TUI and processes keystrokes —
 * a visible freeze on a big Fetch.
 *
 * `writeAsync` moves the filesystem write off the synchronous critical
 * section (fs.promises). These tests pin the contract:
 *   1. it returns the same \{path,bytes,sha256\} shape as the sync path,
 *   2. the file is NOT created synchronously (the write is deferred to a
 *      later microtask/tick — proof the hot path didn't block on fs),
 *   3. the persisted bytes + digest match the sync path exactly.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { BlobStore, shortSha256 } from "./blob-store.ts"

function mkStore(): BlobStore {
  const dir = join(mkdtempSync(join(tmpdir(), "ma-blob-async-")), "sid.blobs")
  return new BlobStore({
    sid: "sid",
    dir,
    config: {
      enabled: true,
      minBytesToPersist: 0,
      maxBlobsPerSession: 1000,
      maxBytesPerSession: 256 * 1024 * 1024,
    },
  })
}

describe("BlobStore.writeAsync (Bug 4: off-thread persistence)", () => {
  it("does not touch the filesystem synchronously, then lands the blob after await", async () => {
    const store = mkStore()
    const body = "x".repeat(200_000)

    const promise = store.writeAsync("toolu_async_1", body)
    // Synchronously — immediately after the call returns, BEFORE awaiting —
    // the file must not exist yet. A sync writeFileSync would already have
    // created it here; the async path defers it.
    const existedSynchronously = existsSync(store.pathFor("toolu_async_1"))

    const result = await promise
    expect(existedSynchronously).toBe(false)

    expect(result).not.toBeNull()
    expect(result!.path).toBe(store.pathFor("toolu_async_1"))
    expect(result!.bytes).toBe(Buffer.byteLength(body, "utf-8"))
    expect(result!.sha256).toBe(shortSha256(body))

    // And the file is on disk with the exact bytes after the await.
    expect(existsSync(result!.path)).toBe(true)
    expect(readFileSync(result!.path, "utf-8")).toBe(body)
  })

  it("honors the same eligibility gates as the sync path (disabled, too small, empty)", async () => {
    const store = mkStore()
    // Empty body → null, no file.
    expect(await store.writeAsync("toolu_empty", "")).toBeNull()

    const disabled = new BlobStore({
      sid: "sid",
      dir: join(mkdtempSync(join(tmpdir(), "ma-blob-async-off-")), "sid.blobs"),
      config: { enabled: false },
    })
    expect(await disabled.writeAsync("toolu_off", "hello world")).toBeNull()

    const gated = new BlobStore({
      sid: "sid",
      dir: join(mkdtempSync(join(tmpdir(), "ma-blob-async-min-")), "sid.blobs"),
      config: { enabled: true, minBytesToPersist: 1024 },
    })
    expect(await gated.writeAsync("toolu_small", "tiny")).toBeNull()
  })

  it("matches the sync write byte-for-byte and digest-for-digest", async () => {
    const a = mkStore()
    const b = mkStore()
    const body = JSON.stringify({ k: "v".repeat(5000), n: 42 })

    const sync = a.write("toolu_x", body)
    const async = await b.writeAsync("toolu_x", body)

    expect(sync).not.toBeNull()
    expect(async).not.toBeNull()
    expect(async!.bytes).toBe(sync!.bytes)
    expect(async!.sha256).toBe(sync!.sha256)
    expect(readFileSync(async!.path, "utf-8")).toBe(readFileSync(sync!.path, "utf-8"))
  })
})

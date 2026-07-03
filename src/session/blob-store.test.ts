/**
 * Tests for the per-session blob store.
 *
 * Covers the write/read/has/pathFor surface, the sha256 short-digest, the
 * config gating (disabled, minBytesToPersist), the LRU eviction (count
 * cap + byte cap), the pointer-footer formatter, and the "best-effort"
 * promise that failed writes never throw.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  _resetBlobStoreConfigForTests,
  BlobStore,
  DEFAULT_BLOB_STORE_CONFIG,
  DEFAULT_BLOB_STORE_SKIP_TOOLS,
  defaultBlobsDir,
  defaultSessionsDir,
  formatBytes,
  formatRawOutputFooter,
  loadBlobStoreConfig,
  shortSha256,
} from "./blob-store.ts"

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "ma-blob-store-"))
}

function mkStore(opts: Partial<ConstructorParameters<typeof BlobStore>[0]> = {}): BlobStore {
  const dir = opts.dir ?? join(tmpDir(), "sid.blobs")
  return new BlobStore({
    sid: "sid",
    dir,
    config: {
      enabled: true,
      minBytesToPersist: 0, // by default tests want EVERY write to land
      maxBlobsPerSession: 1000,
      maxBytesPerSession: 256 * 1024 * 1024,
      ...opts.config,
    },
    ...opts,
  })
}

// ---------------------------------------------------------------------------
// path helpers
// ---------------------------------------------------------------------------

describe("defaultSessionsDir / defaultBlobsDir", () => {
  it("returns ~/.minimal-agent/sessions for the sessions root", () => {
    const p = defaultSessionsDir()
    expect(p).toMatch(/\.minimal-agent\/sessions$/)
  })

  it("derives <sid>.blobs/ from sid", () => {
    const p = defaultBlobsDir("abc-123")
    expect(p).toMatch(/\.minimal-agent\/sessions\/abc-123\.blobs$/)
  })

  it("honors an explicit root override", () => {
    const p = defaultBlobsDir("my-sid", "/tmp/x")
    expect(p).toBe("/tmp/x/my-sid.blobs")
  })
})

// ---------------------------------------------------------------------------
// shortSha256
// ---------------------------------------------------------------------------

describe("shortSha256", () => {
  it("returns 16 hex chars", () => {
    const h = shortSha256("hello")
    expect(h).toMatch(/^[0-9a-f]{16}$/)
  })

  it("is deterministic for the same input", () => {
    expect(shortSha256("hello")).toBe(shortSha256("hello"))
  })

  it("differs for different inputs", () => {
    expect(shortSha256("hello")).not.toBe(shortSha256("Hello"))
  })

  it("accepts Uint8Array equivalently to its UTF-8 string form", () => {
    const s = "octopus"
    const a = shortSha256(s)
    const b = shortSha256(Buffer.from(s, "utf-8"))
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// formatBytes / formatRawOutputFooter
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("renders bytes / kB / MB compactly", () => {
    expect(formatBytes(512)).toBe("512B")
    expect(formatBytes(2048)).toBe("2.0kB")
    expect(formatBytes(1024 * 1024 * 5)).toBe("5.00MB")
  })
})

describe("formatRawOutputFooter", () => {
  it("returns a single regex-greppable line", () => {
    const footer = formatRawOutputFooter({
      path: "/tmp/x/sid.blobs/toolu_abc.raw",
      bytes: 85_000,
      sha256: "ab12cd34ef567890",
    })
    expect(footer).toBe(
      '<ma::agent::raw-output path="/tmp/x/sid.blobs/toolu_abc.raw" size="83.0kB" sha256="ab12cd34ef567890" />',
    )
    // Single line, no embedded newlines.
    expect(footer.includes("\n")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BlobStore: pathFor / has
// ---------------------------------------------------------------------------

describe("BlobStore.pathFor / has", () => {
  it("returns the deterministic absolute path", () => {
    const dir = tmpDir()
    const store = mkStore({ dir })
    expect(store.pathFor("toolu_01")).toBe(join(dir, "toolu_01.raw"))
  })

  it("has() is false when the blob doesn't exist", () => {
    const store = mkStore()
    expect(store.has("nope")).toBe(false)
  })

  it("has() is true after a successful write", () => {
    const store = mkStore()
    store.write("toolu_x", "hello world")
    expect(store.has("toolu_x")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// BlobStore: write
// ---------------------------------------------------------------------------

describe("BlobStore.write", () => {
  it("creates the blob directory lazily on first write", () => {
    const root = tmpDir()
    const dir = join(root, "sid.blobs") // intentionally not yet created
    expect(existsSync(dir)).toBe(false)
    const store = mkStore({ dir })
    const r = store.write("toolu_a", "hello")
    expect(r).not.toBeNull()
    expect(existsSync(dir)).toBe(true)
  })

  it("writes string content verbatim and reports the right metadata", () => {
    const store = mkStore()
    const body = "the quick brown fox\n"
    const r = store.write("toolu_b", body)
    expect(r).not.toBeNull()
    expect(r?.bytes).toBe(Buffer.byteLength(body, "utf-8"))
    expect(r?.sha256).toBe(shortSha256(body))
    expect(readFileSync(r?.path ?? "", "utf-8")).toBe(body)
  })

  it("writes Uint8Array content byte-for-byte", () => {
    const store = mkStore()
    const buf = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
    const r = store.write("toolu_bin", buf)
    expect(r?.bytes).toBe(6)
    const round = readFileSync(r?.path ?? "")
    expect(Array.from(round)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff])
  })

  it("returns null when the store is disabled", () => {
    const store = mkStore({ config: { enabled: false } })
    expect(store.write("toolu_x", "hello")).toBeNull()
  })

  it("returns null when body is empty", () => {
    const store = mkStore()
    expect(store.write("toolu_empty", "")).toBeNull()
  })

  it("returns null when body is below minBytesToPersist", () => {
    const store = mkStore({ config: { minBytesToPersist: 10 } })
    expect(store.write("toolu_small", "hi")).toBeNull()
    // boundary: exactly equal to min IS persisted (>= would be ambiguous; we use <)
    expect(store.write("toolu_eq", "0123456789")).not.toBeNull()
  })

  it("survives a permission-denied write (best-effort, no throw, calls onError)", () => {
    const captured: { err: unknown; ctx: string }[] = []
    // Point the store at a path we can't create. /dev/null/nope is reliably
    // ENOTDIR on macOS+Linux.
    const store = new BlobStore({
      sid: "sid",
      dir: "/dev/null/nope",
      config: { ...DEFAULT_BLOB_STORE_CONFIG, minBytesToPersist: 0 },
      onError: (err, ctx) => {
        captured.push({ err, ctx })
      },
    })
    const r = store.write("toolu_fail", "hello")
    expect(r).toBeNull()
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0].ctx).toMatch(/^BlobStore\.write\(toolu_fail/)
  })

  it("handles special characters / utf-8 / newlines verbatim", () => {
    const store = mkStore()
    const body = "octöpus 🐙\n\twith\ntabs\u0000and NUL\nand a trailing \\r\\n\r\n"
    const r = store.write("toolu_u", body)
    expect(r).not.toBeNull()
    const round = readFileSync(r?.path ?? "", "utf-8")
    expect(round).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// BlobStore: read
// ---------------------------------------------------------------------------

describe("BlobStore.read", () => {
  it("returns null when the blob is missing", () => {
    const store = mkStore()
    expect(store.read("never-written")).toBeNull()
  })

  it("round-trips a write/read for arbitrary content", () => {
    const store = mkStore()
    const body = "round-trip ✅\nfoo\n"
    store.write("toolu_rt", body)
    const back = store.read("toolu_rt")
    expect(back).not.toBeNull()
    expect(back?.toString("utf-8")).toBe(body)
  })
})

// ---------------------------------------------------------------------------
// BlobStore: remove
// ---------------------------------------------------------------------------

describe("BlobStore.remove", () => {
  it("returns false when the blob is missing", () => {
    expect(mkStore().remove("nope")).toBe(false)
  })

  it("returns true and unlinks when the blob is present", () => {
    const store = mkStore()
    store.write("toolu_r", "x".repeat(100))
    expect(store.has("toolu_r")).toBe(true)
    expect(store.remove("toolu_r")).toBe(true)
    expect(store.has("toolu_r")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// BlobStore: list / stats
// ---------------------------------------------------------------------------

describe("BlobStore.list / stats", () => {
  it("returns [] for a fresh store", () => {
    const store = mkStore()
    expect(store.list()).toEqual([])
    expect(store.stats()).toEqual({ count: 0, bytes: 0 })
  })

  it("returns sorted oldest-first by mtime", () => {
    const store = mkStore()
    store.write("a", "a".repeat(100))
    // Sleep just enough to force a different mtime on the next file.
    Bun.sleepSync(10)
    store.write("b", "b".repeat(100))
    const items = store.list()
    expect(items.map((i) => i.id)).toEqual(["a", "b"])
  })

  it("ignores non-.raw files and subdirs in the blobs dir", () => {
    const store = mkStore()
    mkdirSync(store.dir, { recursive: true })
    // `Bun.write` is async; we don't need to await it here because the next
    // call (`store.write("real", …)`) sleeps long enough for it to land, and
    // we only assert that the unrelated file is ignored by `.list()`. Mark
    // it void to satisfy oxlint's no-floating-promises.
    void Bun.write(join(store.dir, "_log.jsonl"), `{"ok": true}\n`)
    mkdirSync(join(store.dir, "_misc"), { recursive: true })
    store.write("real", "x".repeat(100))
    const items = store.list()
    expect(items.map((i) => i.id)).toEqual(["real"])
  })

  it("stats() returns count + total bytes", () => {
    const store = mkStore()
    store.write("a", "x".repeat(50))
    Bun.sleepSync(5)
    store.write("b", "y".repeat(200))
    expect(store.stats()).toEqual({ count: 2, bytes: 250 })
  })
})

// ---------------------------------------------------------------------------
// BlobStore: LRU eviction (count + byte cap)
// ---------------------------------------------------------------------------

describe("BlobStore eviction", () => {
  it("evicts oldest blobs when count cap is exceeded", () => {
    const store = mkStore({
      config: { maxBlobsPerSession: 2, maxBytesPerSession: 1024 * 1024, minBytesToPersist: 0 },
    })
    store.write("a", "aa")
    Bun.sleepSync(5)
    store.write("b", "bb")
    Bun.sleepSync(5)
    store.write("c", "cc") // should evict "a"
    const ids = store.list().map((i) => i.id)
    expect(ids).toContain("b")
    expect(ids).toContain("c")
    expect(ids).not.toContain("a")
  })

  it("evicts oldest blobs when byte cap is exceeded", () => {
    const store = mkStore({
      config: { maxBlobsPerSession: 100, maxBytesPerSession: 250, minBytesToPersist: 0 },
    })
    store.write("a", "x".repeat(100))
    Bun.sleepSync(5)
    store.write("b", "y".repeat(100))
    Bun.sleepSync(5)
    store.write("c", "z".repeat(100)) // pushes total to 300 > 250 → evict "a"
    const ids = store.list().map((i) => i.id)
    expect(ids).toContain("b")
    expect(ids).toContain("c")
    expect(ids).not.toContain("a")
    // total live bytes should now be <= cap
    expect(store.stats().bytes).toBeLessThanOrEqual(250)
  })

  it("never evicts the blob it just wrote, even if that blob alone exceeds the cap", () => {
    // The cap is 10B but the new blob is 100B. We evict everything older,
    // but the just-written blob stays even when stats() > cap.
    const store = mkStore({
      config: { maxBlobsPerSession: 100, maxBytesPerSession: 10, minBytesToPersist: 0 },
    })
    store.write("old", "x".repeat(50))
    Bun.sleepSync(5)
    const r = store.write("new", "y".repeat(100))
    expect(r).not.toBeNull()
    const ids = store.list().map((i) => i.id)
    expect(ids).toContain("new")
    expect(ids).not.toContain("old")
  })
})

// ---------------------------------------------------------------------------
// Hardlink-safe fork (parent's blob dir, child's view)
// ---------------------------------------------------------------------------

describe("BlobStore fork-on-resume scenario", () => {
  it("two stores can target the same dir without interfering", () => {
    // Simulates session fork: parent already wrote some blobs, child opens
    // the same dir under a new sid (per the design proposal: leave
    // jsonl's rawPath pointing at parent blob, child reads it via its own
    // BlobStore instance). The store is purely path-driven; the sid is
    // a label and does not affect on-disk layout.
    const dir = join(tmpDir(), "shared.blobs")
    const parent = mkStore({ dir })
    parent.write("toolu_old", "from parent")
    const child = new BlobStore({
      sid: "child-sid",
      dir,
      config: { ...DEFAULT_BLOB_STORE_CONFIG, minBytesToPersist: 0 },
    })
    expect(child.has("toolu_old")).toBe(true)
    expect(child.read("toolu_old")?.toString("utf-8")).toBe("from parent")
  })
})

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

describe("BlobStore tmp dirs", () => {
  it("the helper paths point inside the OS tmpdir (sanity check)", () => {
    const store = mkStore()
    expect(store.dir.startsWith(tmpdir())).toBe(true)
    rmSync(store.dir, { recursive: true, force: true })
    expect(existsSync(store.dir)).toBe(false)
  })

  it("statSync on the dir reports a directory after first write", () => {
    const store = mkStore()
    store.write("toolu_dir", "x".repeat(100))
    expect(statSync(store.dir).isDirectory()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Config loader (reads ~/.minimal-agent/config.jsonc :: plugins["blob-store"])
// ---------------------------------------------------------------------------

describe("loadBlobStoreConfig", () => {
  // We override `MINIMAL_AGENT_CONFIG` (read by `src/config.ts:configPath`)
  // instead of `HOME` because `homedir()` in node is cached at startup on
  // some platforms; the env override is the test-supported seam.
  let prevConfig: string | undefined
  let prevDisabled: string | undefined
  let tmpRoot: string
  let cfgPath: string
  beforeEach(() => {
    _resetBlobStoreConfigForTests()
    prevConfig = process.env.MINIMAL_AGENT_CONFIG
    prevDisabled = process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED
    tmpRoot = mkdtempSync(join(tmpdir(), "ma-blob-cfg-"))
    cfgPath = join(tmpRoot, "config.jsonc")
    process.env.MINIMAL_AGENT_CONFIG = cfgPath
    delete process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED
  })
  afterEach(() => {
    if (prevConfig === undefined) delete process.env.MINIMAL_AGENT_CONFIG
    else process.env.MINIMAL_AGENT_CONFIG = prevConfig
    if (prevDisabled === undefined) delete process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED
    else process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED = prevDisabled
    rmSync(tmpRoot, { recursive: true, force: true })
    _resetBlobStoreConfigForTests()
  })

  it("returns defaults when config file is missing", () => {
    const r = loadBlobStoreConfig()
    expect(r.config).toEqual(DEFAULT_BLOB_STORE_CONFIG)
    expect([...r.skipTools].sort()).toEqual([...DEFAULT_BLOB_STORE_SKIP_TOOLS].sort())
  })

  it("returns defaults when config has no plugins.blob-store block", () => {
    writeFileSync(cfgPath, `{ "plugins": { "file-lock": { "enabled": true } } }`)
    const r = loadBlobStoreConfig()
    expect(r.config).toEqual(DEFAULT_BLOB_STORE_CONFIG)
  })

  it("merges user-config values on top of defaults", () => {
    writeFileSync(
      cfgPath,
      `{
        // user overrides only the threshold + skip list
        "plugins": {
          "blob-store": {
            "minBytesToPersist": 8192,
            "skipTools": ["Task", "Custom"]
          }
        }
      }`,
    )
    const r = loadBlobStoreConfig()
    expect(r.config.minBytesToPersist).toBe(8192)
    expect(r.config.maxBlobsPerSession).toBe(DEFAULT_BLOB_STORE_CONFIG.maxBlobsPerSession)
    expect([...r.skipTools].sort()).toEqual(["Custom", "Task"])
  })

  it("respects `enabled: false` from user config", () => {
    writeFileSync(cfgPath, `{ "plugins": { "blob-store": { "enabled": false } } }`)
    const r = loadBlobStoreConfig()
    expect(r.config.enabled).toBe(false)
  })

  it("env opt-out MINIMAL_AGENT_BLOB_STORE_DISABLED=1 forces enabled=false", () => {
    process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED = "1"
    writeFileSync(
      cfgPath,
      `{ "plugins": { "blob-store": { "enabled": true, "minBytesToPersist": 100 } } }`,
    )
    const r = loadBlobStoreConfig()
    expect(r.config.enabled).toBe(false)
  })

  it("ignores garbage values and falls back to defaults for individual fields", () => {
    writeFileSync(
      cfgPath,
      `{
        "plugins": {
          "blob-store": {
            "minBytesToPersist": "huge",
            "maxBlobsPerSession": -10,
            "maxBytesPerSession": 0,
            "skipTools": "not-an-array"
          }
        }
      }`,
    )
    const r = loadBlobStoreConfig()
    expect(r.config.minBytesToPersist).toBe(DEFAULT_BLOB_STORE_CONFIG.minBytesToPersist)
    expect(r.config.maxBlobsPerSession).toBe(DEFAULT_BLOB_STORE_CONFIG.maxBlobsPerSession)
    expect(r.config.maxBytesPerSession).toBe(DEFAULT_BLOB_STORE_CONFIG.maxBytesPerSession)
    expect([...r.skipTools].sort()).toEqual([...DEFAULT_BLOB_STORE_SKIP_TOOLS].sort())
  })

  it("caches: second call returns the same object even if file changes", () => {
    writeFileSync(cfgPath, `{ "plugins": { "blob-store": { "minBytesToPersist": 100 } } }`)
    const a = loadBlobStoreConfig()
    writeFileSync(cfgPath, `{ "plugins": { "blob-store": { "minBytesToPersist": 999 } } }`)
    const b = loadBlobStoreConfig()
    expect(b.config.minBytesToPersist).toBe(100) // cached value
    expect(a).toBe(b)
  })
})

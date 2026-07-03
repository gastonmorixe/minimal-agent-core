/**
 * Per-session blob store for raw tool outputs.
 *
 * Sits next to `SessionStore` (see `./session-store.ts`): one blob
 * file per tool call, keyed by `tool_use_id`, under
 * `~/.minimal-agent/sessions/<sid>.blobs/`. Captures the pre-clamp,
 * pre-annotation `content` so the agent can later read the FULL output
 * without re-running the tool, even when the model only received a
 * truncated body via the `[truncated: ...]` notice.
 *
 * The convention:
 *
 *   `~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw`
 *
 * Same lifecycle as the session JSONL: created on first write, append-only
 * (each call is a fresh file), cleaned up by deleting the parent folder
 * when the session is purged. Blobs are NEVER modified once written; if a
 * future operation needs versioning, it writes a new blob with a different
 * id.
 *
 * Best-effort: a failed write is logged (via the optional `onError` hook)
 * but never throws. The agent must always succeed at returning a tool
 * result to the model; the blob is a side channel, not the primary one.
 *
 * @module blob-store
 */

// import { createHash } from "node:crypto"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { resolveSessionsDir } from "./agent-paths.ts"
import { configPath as userConfigPath } from "./config.ts"
import { parseJsonc } from "./utils/jsonc.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outcome of a successful blob write. Mirrored into the corresponding
 * `ToolResultRecord.rawPath` / `rawBytes` / `rawSha256` fields and into
 * the model-facing `[raw-output: …]` pointer footer.
 */
export interface BlobWriteResult {
  /** Absolute path to the written blob. Suitable for embedding in the model footer. */
  path: string
  /** Size in bytes of the bytes actually written (post-UTF-8 encoding for strings). */
  bytes: number
  /** sha256 hex digest, truncated to 16 chars (enough for drift detection, no crypto use). */
  sha256: string
}

/**
 * Configuration knobs for {@link BlobStore}. All optional; see
 * {@link DEFAULT_BLOB_STORE_CONFIG} for production defaults.
 */
export interface BlobStoreConfig {
  /** Master switch. When false, every write is a no-op and {@link BlobStore.write} returns null. */
  enabled?: boolean
  /** Bodies smaller than this byte size are skipped (no blob, no footer). */
  minBytesToPersist?: number
  /** Hard cap on live blob count per session. LRU-evicted on overflow. */
  maxBlobsPerSession?: number
  /** Hard cap on total live bytes per session. LRU-evicted on overflow. */
  maxBytesPerSession?: number
}

/** Fully-resolved config used at runtime (no `?` fields). */
export interface ResolvedBlobStoreConfig {
  enabled: boolean
  minBytesToPersist: number
  maxBlobsPerSession: number
  maxBytesPerSession: number
}

/** Production defaults. Conservative on disk, generous on content size. */
export const DEFAULT_BLOB_STORE_CONFIG: ResolvedBlobStoreConfig = {
  enabled: true,
  minBytesToPersist: 4096,
  maxBlobsPerSession: 1000,
  maxBytesPerSession: 256 * 1024 * 1024, // 256 MiB
}

/**
 * Tools the blob store should NOT persist. Built-in defaults: small,
 * structured replies whose `content` is already self-describing and
 * who never benefit from a separate blob (Task summary lines,
 * MemoryTool list output, ShowDiff render, LockStatus tabular).
 * User config under `plugins["blob-store"].skipTools` replaces this
 * list outright.
 */
export const DEFAULT_BLOB_STORE_SKIP_TOOLS: ReadonlyArray<string> = [
  "Task",
  "MemoryTool",
  "ShowDiff",
  "LockStatus",
]

// ---------------------------------------------------------------------------
// Config loader (reads ~/.minimal-agent/config.jsonc :: plugins["blob-store"])
// ---------------------------------------------------------------------------

/**
 * Resolved config + the skipTools set, both used by the agent's
 * capture-point hook. Kept as a single object so callers thread one
 * value, not two.
 */
export interface BlobStoreRuntimeConfig {
  config: ResolvedBlobStoreConfig
  skipTools: ReadonlySet<string>
}

let _runtimeConfig: BlobStoreRuntimeConfig | null = null

/** Test seam: drop the cached config so the next call re-reads file/env. */
export function _resetBlobStoreConfigForTests(): void {
  _runtimeConfig = null
}

/**
 * Load and cache the blob-store config from `~/.minimal-agent/config.jsonc`
 * under `plugins["blob-store"]`, honoring `MINIMAL_AGENT_BLOB_STORE_DISABLED=1`
 * as a hard env opt-out. Defaults are filled in when keys are missing;
 * unknown keys are ignored. Mirrors the pattern in `tools.ts:fileLockConfig`.
 */
export function loadBlobStoreConfig(): BlobStoreRuntimeConfig {
  if (_runtimeConfig !== null) return _runtimeConfig

  // Hard env opt-out for tests / debugging. Doesn't pollute the config file.
  if (process.env.MINIMAL_AGENT_BLOB_STORE_DISABLED === "1") {
    _runtimeConfig = {
      config: { ...DEFAULT_BLOB_STORE_CONFIG, enabled: false },
      skipTools: new Set(DEFAULT_BLOB_STORE_SKIP_TOOLS),
    }
    return _runtimeConfig
  }

  const defaults: BlobStoreRuntimeConfig = {
    config: { ...DEFAULT_BLOB_STORE_CONFIG },
    skipTools: new Set(DEFAULT_BLOB_STORE_SKIP_TOOLS),
  }

  try {
    const path = userConfigPath()
    if (!existsSync(path)) {
      _runtimeConfig = defaults
      return _runtimeConfig
    }
    const raw = readFileSync(path, "utf-8")
    const parsed = parseJsonc(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      _runtimeConfig = defaults
      return _runtimeConfig
    }
    const plugins = (parsed as Record<string, unknown>).plugins as
      | Record<string, unknown>
      | undefined
    const block = plugins?.["blob-store"] as Record<string, unknown> | undefined
    if (!block) {
      _runtimeConfig = defaults
      return _runtimeConfig
    }

    const enabled = block.enabled === false ? false : defaults.config.enabled
    const minBytesToPersist =
      typeof block.minBytesToPersist === "number" && block.minBytesToPersist >= 0
        ? Math.floor(block.minBytesToPersist)
        : defaults.config.minBytesToPersist
    const maxBlobsPerSession =
      typeof block.maxBlobsPerSession === "number" && block.maxBlobsPerSession > 0
        ? Math.floor(block.maxBlobsPerSession)
        : defaults.config.maxBlobsPerSession
    const maxBytesPerSession =
      typeof block.maxBytesPerSession === "number" && block.maxBytesPerSession > 0
        ? Math.floor(block.maxBytesPerSession)
        : defaults.config.maxBytesPerSession

    const skipTools =
      Array.isArray(block.skipTools) && block.skipTools.every((t) => typeof t === "string")
        ? new Set(block.skipTools as string[])
        : new Set(DEFAULT_BLOB_STORE_SKIP_TOOLS)

    _runtimeConfig = {
      config: { enabled, minBytesToPersist, maxBlobsPerSession, maxBytesPerSession },
      skipTools,
    }
    return _runtimeConfig
  } catch {
    _runtimeConfig = defaults
    return _runtimeConfig
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Root directory for all sessions' blobs. Lives next to `<sid>.jsonl`. Honors
 * `MINIMAL_AGENT_HOME` via the single resolver in `src/agent-paths.ts`, so blob
 * storage tracks the same relocated home the host advertises to plugins.
 */
export function defaultSessionsDir(): string {
  return resolveSessionsDir()
}

/**
 * The per-session blob directory: `<sessions>/<sid>.blobs/`. Stays a
 * sibling of the JSONL so cleanup ("delete this session") is a single
 * `rm -rf` of two paths.
 */
export function defaultBlobsDir(sid: string, root: string = defaultSessionsDir()): string {
  return join(root, `${sid}.blobs`)
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * sha256 hex digest truncated to 16 chars. Not used as a primary key
 * (we key by `tool_use_id`); only for drift detection during session
 * resume ("does the file on disk still match what we recorded?"). 16
 * hex chars = 64 bits = collision-safe at the session-blob scale we
 * care about.
 */
export function shortSha256(input: string | Uint8Array): string {
  const h = new Bun.CryptoHasher("sha256")
  h.update(input)
  return h.digest("hex").slice(0, 16)
}

// ---------------------------------------------------------------------------
// BlobStore
// ---------------------------------------------------------------------------

/**
 * Append-only, per-session blob store. One file per tool call, named
 * `<tool_use_id>.raw` under `<sessionsDir>/<sid>.blobs/`. Synchronous fs
 * ops match the `SessionStore` (`./session-store.ts`)
 * discipline: tools.ts is hot-path on every Edit/Write, and the blob
 * write is part of that same critical section.
 *
 * Instantiate once per session in `src/index.ts`, pass into Agent via
 * `AgentOpts.blobStore`.
 */
export class BlobStore {
  /** Session id this store is bound to. */
  readonly sid: string
  /** Absolute path to the blobs directory (`<sid>.blobs/`). */
  readonly dir: string
  /** Resolved config; never null at runtime. */
  readonly config: ResolvedBlobStoreConfig
  /** Optional best-effort error hook (e.g., the agent's diagnostic logger). */
  private readonly onError?: (err: unknown, context: string) => void

  constructor(opts: {
    sid: string
    /** Override the blob dir (mostly for tests). Defaults to {@link defaultBlobsDir}. */
    dir?: string
    /** Override config (mostly for tests). Defaults to {@link DEFAULT_BLOB_STORE_CONFIG}. */
    config?: BlobStoreConfig
    /** Best-effort error hook. */
    onError?: (err: unknown, context: string) => void
  }) {
    this.sid = opts.sid
    this.dir = opts.dir ?? defaultBlobsDir(opts.sid)
    this.config = { ...DEFAULT_BLOB_STORE_CONFIG, ...opts.config }
    this.onError = opts.onError
  }

  /** Absolute path to a blob, regardless of whether it exists. */
  pathFor(toolUseId: string): string {
    return join(this.dir, `${toolUseId}.raw`)
  }

  /** True iff a blob with this id is present on disk. */
  has(toolUseId: string): boolean {
    try {
      return existsSync(this.pathFor(toolUseId))
    } catch {
      return false
    }
  }

  /**
   * Read a blob back. Returns `null` when the file is missing (e.g.,
   * evicted by LRU, manually deleted, store disabled). Caller decides
   * how to handle ENOENT.
   */
  read(toolUseId: string): Buffer | null {
    const path = this.pathFor(toolUseId)
    try {
      if (!existsSync(path)) return null
      return readFileSync(path)
    } catch (err) {
      this.onError?.(err, `BlobStore.read(${toolUseId})`)
      return null
    }
  }

  /**
   * Write a blob. Returns `null` when the write is skipped (store
   * disabled, body too small) or fails (logged via `onError`); returns
   * {@link BlobWriteResult} otherwise. Never throws.
   *
   * Eligibility is decided BEFORE the write so we don't touch the
   * filesystem when there's nothing to persist:
   *
   *   - store disabled → null
   *   - body smaller than minBytes → null
   *   - empty body → null
   *
   * On a successful write, runs LRU eviction (count + bytes).
   */
  write(toolUseId: string, raw: string | Uint8Array): BlobWriteResult | null {
    if (!this.config.enabled) return null
    const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf-8") : raw.byteLength
    if (bytes === 0) return null
    if (bytes < this.config.minBytesToPersist) return null

    try {
      mkdirSync(this.dir, { recursive: true })
      const path = this.pathFor(toolUseId)
      writeFileSync(path, raw)
      const sha256 = shortSha256(raw)
      this.evictIfOverCap(toolUseId)
      return { path, bytes, sha256 }
    } catch (err) {
      this.onError?.(err, `BlobStore.write(${toolUseId}, ${bytes}B)`)
      return null
    }
  }

  /**
   * Async sibling of {@link write}. Same eligibility gates, same
   * {@link BlobWriteResult} shape, same on-disk bytes — but the directory
   * create and the file write go through `fs/promises` so they don't block
   * the event loop. This matters on the plugin result path, where the
   * agent persists the FULL (potentially multi-MB) tool body: a synchronous
   * `writeFileSync` there stalls the single thread that paints the TUI and
   * reads keystrokes (Bug 4). The hash is still computed synchronously
   * (cheap relative to fs, and Node has no async hash without streaming),
   * but it runs AFTER the `await` yields, so the first thing this method
   * does on the hot path is hand control back to the loop.
   *
   * Eligibility is decided BEFORE any await so a skipped write costs nothing
   * and the file is never created. Eviction stays synchronous (it only
   * stats + unlinks small directory entries, never the big body) and runs
   * after the write lands. Never throws.
   */
  async writeAsync(toolUseId: string, raw: string | Uint8Array): Promise<BlobWriteResult | null> {
    if (!this.config.enabled) return null
    const bytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf-8") : raw.byteLength
    if (bytes === 0) return null
    if (bytes < this.config.minBytesToPersist) return null

    try {
      const path = this.pathFor(toolUseId)
      await mkdir(this.dir, { recursive: true })
      await writeFile(path, raw)
      const sha256 = shortSha256(raw)
      this.evictIfOverCap(toolUseId)
      return { path, bytes, sha256 }
    } catch (err) {
      this.onError?.(err, `BlobStore.writeAsync(${toolUseId}, ${bytes}B)`)
      return null
    }
  }

  /**
   * Remove a specific blob (best-effort, never throws). Returns true
   * when the file was present and unlinked.
   */
  remove(toolUseId: string): boolean {
    const path = this.pathFor(toolUseId)
    try {
      if (!existsSync(path)) return false
      unlinkSync(path)
      return true
    } catch (err) {
      this.onError?.(err, `BlobStore.remove(${toolUseId})`)
      return false
    }
  }

  /**
   * List current blobs sorted oldest-first (by mtime). Used by LRU
   * eviction and by tests. Returns `[]` when the dir doesn't exist or
   * is unreadable.
   */
  list(): { id: string; path: string; bytes: number; mtimeMs: number }[] {
    try {
      if (!existsSync(this.dir)) return []
      const entries = readdirSync(this.dir, { withFileTypes: true })
      const out: { id: string; path: string; bytes: number; mtimeMs: number }[] = []
      for (const e of entries) {
        if (!e.isFile()) continue
        if (!e.name.endsWith(".raw")) continue
        const path = join(this.dir, e.name)
        try {
          const st = statSync(path)
          out.push({
            id: e.name.slice(0, -".raw".length),
            path,
            bytes: st.size,
            mtimeMs: st.mtimeMs,
          })
        } catch {
          // race with concurrent unlink; skip
        }
      }
      out.sort((a, b) => a.mtimeMs - b.mtimeMs)
      return out
    } catch (err) {
      this.onError?.(err, "BlobStore.list")
      return []
    }
  }

  /**
   * Aggregate live state: (count, totalBytes). O(n) over the blob dir.
   * Used by tests and the LRU eviction step.
   */
  stats(): { count: number; bytes: number } {
    const all = this.list()
    let bytes = 0
    for (const b of all) bytes += b.bytes
    return { count: all.length, bytes }
  }

  // -------------------------------------------------------------------------
  // LRU eviction (count + bytes caps)
  // -------------------------------------------------------------------------

  /**
   * Drop oldest blobs until we're under both caps. Called from
   * {@link write} after each successful write so we never grow past
   * the configured maxima.
   *
   * `protectedId`, when set, names the blob that MUST NOT be evicted
   * even when the caps can't be satisfied without it (typically the
   * id we just wrote: it would be absurd to evict the very write that
   * triggered this call). The caller's caps may end up exceeded in
   * that case, on purpose. If you want a hard "single blob can never
   * exceed maxBytes" rule, enforce that upstream via the eligibility
   * check in {@link write}, not here.
   *
   * Best-effort: errors during unlink are logged and the loop
   * continues. Visible for tests via {@link _evictIfOverCapForTests}.
   */
  private evictIfOverCap(protectedId?: string): void {
    const { maxBlobsPerSession, maxBytesPerSession } = this.config
    const entries = this.list()
    let count = entries.length
    let bytes = entries.reduce((s, e) => s + e.bytes, 0)
    if (count <= maxBlobsPerSession && bytes <= maxBytesPerSession) return

    // Oldest-first iteration. Stop as soon as both caps are satisfied.
    // Skip the protected id even if it's the oldest entry.
    for (const e of entries) {
      if (count <= maxBlobsPerSession && bytes <= maxBytesPerSession) break
      if (protectedId !== undefined && e.id === protectedId) continue
      try {
        unlinkSync(e.path)
        count--
        bytes -= e.bytes
      } catch (err) {
        this.onError?.(err, `BlobStore.evict(${e.id})`)
      }
    }
  }

  /** Test hook. Externally identical to a write that triggers eviction. */
  _evictIfOverCapForTests(protectedId?: string): void {
    this.evictIfOverCap(protectedId)
  }
}

// ---------------------------------------------------------------------------
// Model-facing pointer footer
// ---------------------------------------------------------------------------

/**
 * Build the `<ma::agent::raw-output … />` line appended to a tool
 * result's `content` when a blob was written. One self-contained line,
 * regex-greppable, so the model can extract the path without parsing
 * JSON. Format is deliberately stable; downstream tooling MAY rely on
 * it.
 *
 * Example:
 *   `<ma::agent::raw-output path="/Users/.../<sid>.blobs/toolu_01abc.raw" size="85kB" sha256="ab12cd34ef567890" />`
 *
 * (Pre-2026-05-28 emit used the bracket form
 * `[raw-output: <path> <size> · sha256=<hex>]`. Replay accepts both.)
 */
export function formatRawOutputFooter(r: BlobWriteResult): string {
  return `<ma::agent::raw-output path="${r.path}" size="${formatBytes(r.bytes)}" sha256="${r.sha256}" />`
}

/** Compact byte formatter: matches the one ma-fetch already uses. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

// ---------------------------------------------------------------------------
// Append-only debug log (optional)
// ---------------------------------------------------------------------------

/**
 * Best-effort write of a one-line debug record to `<dir>/_log.jsonl`.
 * Useful when diagnosing "why didn't this blob land?" in production.
 * Pure side-channel: failures are silently swallowed.
 */
export function appendBlobStoreDiagLine(dir: string, line: Record<string, unknown>): void {
  try {
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, "_log.jsonl"), `${JSON.stringify(line)}\n`)
  } catch {
    // intentional: diag log is purely advisory
  }
}

/** Durable per-session tracking of files touched by tools. */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, normalize, resolve } from "node:path"

export type FileStatus = "present" | "missing" | "changed"

export interface FileMetadata {
  size: number
  dev: number
  ino: number
  mtimeMs: number
  /** Nanosecond mtime when the platform/runtime exposes it. */
  mtimeNs?: string
}

export interface FileTrackingRecord {
  path: string
  metadata: FileMetadata | null
  recordedAt: string
}

export interface TrackedFile {
  path: string
  metadata: FileMetadata | null
  recordedAt: string
}

export interface FileTrackingStoreOptions {
  sid: string
  dir: string
  cwd?: string
}

/** Validate a canonical session id (UUID v4 shape). */
export function isValidSessionId(sid: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)
}

/** Resolve a path against cwd and normalize it to an absolute form. */
export function normalizeTrackedPath(path: string, cwd: string = process.cwd()): string {
  return normalize(isAbsolute(path) ? path : resolve(cwd, path))
}

/**
 * Reject sids that could escape the sessions dir or collide with another
 * session's files (path separators, `..`, absolute segments, NUL). Session
 * ids are server-generated UUIDs, so this only guards against a malformed
 * caller; a hostile value must never turn `<sid>.files.jsonl` into an
 * arbitrary path write.
 */
export function isSafeSid(sid: string): boolean {
  return (
    sid.length > 0 &&
    sid.length <= 128 &&
    !sid.includes("/") &&
    !sid.includes("\\") &&
    !sid.includes("..") &&
    !sid.includes("\0")
  )
}

/** Return the absolute path of the per-session JSONL tracking file. */
export function fileTrackingPath(sid: string, dir: string): string {
  if (!isSafeSid(sid))
    throw new Error(`unsafe session id for file tracking: ${JSON.stringify(sid)}`)
  return resolve(dir, `${sid}.files.jsonl`)
}

/** Return stable, JSON-safe metadata. Missing files return null. */
export function statMetadata(path: string): FileMetadata | null {
  try {
    const stats = statSync(path, { bigint: true }) as unknown as {
      size: bigint
      dev: bigint
      ino: bigint
      mtimeMs: bigint
      mtimeNs?: bigint
    }
    const metadata: FileMetadata = {
      size: Number(stats.size),
      dev: Number(stats.dev),
      ino: Number(stats.ino),
      mtimeMs: Number(stats.mtimeMs),
    }
    if (typeof stats.mtimeNs === "bigint") metadata.mtimeNs = stats.mtimeNs.toString()
    return metadata
  } catch {
    return null
  }
}

function sameMetadata(a: FileMetadata | null, b: FileMetadata | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.size === b.size &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.mtimeNs === b.mtimeNs
  )
}

/** Append-only per-session file tracking sidecar. */
export class FileTrackingStore {
  readonly sid: string
  readonly path: string
  readonly cwd: string
  private readonly records = new Map<string, TrackedFile>()

  constructor(options: FileTrackingStoreOptions) {
    this.sid = options.sid
    this.path = fileTrackingPath(options.sid, options.dir)
    this.cwd = options.cwd ?? process.cwd()
    this.replay()
  }

  /** Re-read all valid JSONL records, retaining the newest record per path. */
  replay(): TrackedFile[] {
    this.records.clear()
    if (!existsSync(this.path)) return []
    const text = readFileSync(this.path, "utf8")
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const value = JSON.parse(line) as Partial<FileTrackingRecord>
        if (typeof value.path !== "string" || typeof value.recordedAt !== "string") continue
        const path = normalizeTrackedPath(value.path, this.cwd)
        const metadata =
          value.metadata === null || typeof value.metadata === "object"
            ? (value.metadata as FileMetadata | null)
            : null
        this.records.set(path, { path, metadata, recordedAt: value.recordedAt })
      } catch {
        // A truncated final line must not make an otherwise usable session unreadable.
      }
    }
    return this.current()
  }

  /** Record the current stat (or missing state) for a path. */
  append(path: string): TrackedFile {
    const normalized = normalizeTrackedPath(path, this.cwd)
    const record: TrackedFile = {
      path: normalized,
      metadata: statMetadata(normalized),
      recordedAt: new Date().toISOString(),
    }
    mkdirSync(dirname(this.path), { recursive: true })
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8")
    this.records.set(normalized, record)
    return record
  }

  /** Alias for append, useful at call sites that describe the operation as tracking. */
  track(path: string): TrackedFile {
    return this.append(path)
  }

  lookup(path: string): TrackedFile | undefined {
    return this.records.get(normalizeTrackedPath(path, this.cwd))
  }

  current(): TrackedFile[] {
    return [...this.records.values()]
  }

  /** Compare the recorded snapshot with the file as it exists now. */
  status(path: string): FileStatus | undefined {
    const tracked = this.lookup(path)
    if (!tracked) return undefined
    const actual = statMetadata(tracked.path)
    if (actual === null) return "missing"
    return sameMetadata(tracked.metadata, actual) ? "present" : "changed"
  }

  /** Return statuses for every currently tracked path. */
  statuses(): Array<TrackedFile & { status: FileStatus }> {
    const files: Array<TrackedFile & { status: FileStatus }> = []
    for (const file of this.current()) {
      files.push({
        path: file.path,
        metadata: file.metadata,
        recordedAt: file.recordedAt,
        status: this.status(file.path) as FileStatus,
      })
    }
    return files
  }
}

export const FileTracking = FileTrackingStore

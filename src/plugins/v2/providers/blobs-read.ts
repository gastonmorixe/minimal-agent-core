/**
 * `blobs:read` capability provider — host-side adapter implementing
 * {@link BlobsReadApi} over the per-session blob directory
 * (`~/.minimal-agent/sessions/<sid>.blobs/<tool_use_id>.raw`, see
 * `src/blob-store.ts` for the write side).
 *
 * Read-only and bounded: `read` clamps to `maxBytes` so a plugin can never
 * pull a 10 MB blob into model context by accident. ENOENT is a normal
 * stale-pointer case (LRU eviction), surfaced as `null`.
 *
 * @module plugins/v2/providers/blobs-read
 */

import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import type { BlobMeta, BlobsReadApi } from "../host-capabilities.ts"

const READ_DEFAULT_MAX_BYTES = 64 * 1024
const READ_HARD_MAX_BYTES = 1024 * 1024
const LIST_DEFAULT_LIMIT = 50

/** Constructor deps — `dir` overrides the sessions root (tests). */
export interface BlobsReadDeps {
  dir?: string
}

function defaultDir(): string {
  return join(homedir(), ".minimal-agent", "sessions")
}

/** Build the host-side `blobs:read` implementation. */
export function createBlobsReadApi(deps: BlobsReadDeps = {}): BlobsReadApi {
  const dir = deps.dir ?? defaultDir()
  const blobDir = (sid: string) => join(dir, `${sid}.blobs`)

  return {
    async list(sid, opts = {}) {
      const limit = Math.min(200, Math.max(1, opts.limit ?? LIST_DEFAULT_LIMIT))
      const offset = Math.max(0, opts.offset ?? 0)
      let names: string[]
      try {
        names = readdirSync(blobDir(sid)).filter((n) => n.endsWith(".raw"))
      } catch {
        return { items: [], total: 0 }
      }
      const metas: BlobMeta[] = []
      for (const name of names) {
        try {
          const st = statSync(join(blobDir(sid), name))
          metas.push({
            toolUseId: name.slice(0, -".raw".length),
            bytes: st.size,
            mtime: st.mtime.toISOString(),
          })
        } catch {
          // raced deletion — skip
        }
      }
      // Newest first (most recently written blob is usually the interesting one).
      metas.sort((a, b) => b.mtime.localeCompare(a.mtime))
      return { items: metas.slice(offset, offset + limit), total: metas.length }
    },

    async read(sid, toolUseId, opts = {}) {
      // Defend against path traversal through a hostile tool_use_id.
      if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) return null
      const path = join(blobDir(sid), `${toolUseId}.raw`)
      let raw: Buffer
      try {
        raw = readFileSync(path)
      } catch {
        return null // ENOENT = stale pointer after LRU eviction — normal
      }
      const max = Math.min(
        READ_HARD_MAX_BYTES,
        Math.max(1, opts.maxBytes ?? READ_DEFAULT_MAX_BYTES),
      )
      const clipped = raw.byteLength > max
      const text = (clipped ? raw.subarray(0, max) : raw).toString("utf-8")
      return { text, bytes: raw.byteLength, clipped, path }
    },
  }
}

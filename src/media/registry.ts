/**
 * In-memory, per-session media registry. Holds the {@link MediaItem}s the user
 * has attached so the TUI can reference them by short id and the submit path can
 * resolve them to canonical blocks.
 *
 * Content-addressing: registering the same bytes twice (same file dropped
 * twice, or a path whose content equals a prior paste) returns the existing
 * item, so an upload/probe happens once. Path-origin items keep only the path
 * and re-read lazily; byte-origin items hold their buffer.
 *
 * @module media/registry
 */

import { readFileSync } from "node:fs"

import { mediaId, sha256Hex } from "./id.ts"
import { imageDimensions, mimeToKind, sniffMime } from "./probe.ts"
import type { MediaItem, MediaOrigin } from "./types.ts"

export interface MediaRegistry {
  /** Register a file by path (drag/drop). Reads + probes once; dedupes by content. */
  registerPath(path: string, origin?: MediaOrigin): Promise<MediaItem>
  /** Register raw bytes (clipboard image, tool output). `mimeHint` aids sniffing. */
  registerBytes(bytes: Uint8Array, origin?: MediaOrigin, mimeHint?: string): Promise<MediaItem>
  /** Synchronous {@link registerPath}, for the editor's sync paste path. */
  registerFileSync(path: string, origin?: MediaOrigin): MediaItem
  /** Synchronous {@link registerBytes}, for the editor's sync clipboard path. */
  registerBytesSync(bytes: Uint8Array, origin?: MediaOrigin, mimeHint?: string): MediaItem
  /** Look up by 8-hex id. */
  get(id: string): MediaItem | undefined
  /** All registered items in insertion order. */
  list(): MediaItem[]
  /** Drop one item (e.g. its token was removed from the prompt). */
  release(id: string): void
  /** Drop everything (session end / reset). */
  clear(): void
}

function buildItem(
  bytes: Uint8Array,
  origin: MediaOrigin,
  path: string | null,
  sha: string,
  mimeHint: string | undefined,
  load: () => Promise<Uint8Array>,
): MediaItem {
  let mime = sniffMime(bytes)
  if (mime === "application/octet-stream" && mimeHint) mime = mimeHint
  const kind = mimeToKind(mime)
  const dims = kind === "image" ? imageDimensions(bytes, mime) : null
  return {
    id: mediaId(bytes),
    kind,
    mimeType: mime,
    origin,
    path,
    sizeBytes: bytes.length,
    sha256: sha,
    dimensions: dims,
    durationSec: null,
    state: "registered",
    bytes: load,
    prepared: {},
    createdAt: Date.now(),
  }
}

/** Create a fresh per-session registry. */
export function createMediaRegistry(): MediaRegistry {
  const items = new Map<string, MediaItem>()

  function intern(item: MediaItem): MediaItem {
    const existing = items.get(item.id)
    if (existing) return existing
    items.set(item.id, item)
    return item
  }

  return {
    async registerPath(path, origin = "drop") {
      const bytes = await Bun.file(path).bytes()
      const sha = sha256Hex(bytes)
      // Path items re-read lazily; we do NOT keep the buffer alive.
      const item = buildItem(bytes, origin, path, sha, undefined, async () => {
        return await Bun.file(path).bytes()
      })
      return intern(item)
    },

    async registerBytes(bytes, origin = "clipboard", mimeHint) {
      const copy = bytes.slice()
      const sha = sha256Hex(copy)
      const item = buildItem(copy, origin, null, sha, mimeHint, async () => copy)
      return intern(item)
    },

    registerFileSync(path, origin = "drop") {
      const bytes = new Uint8Array(readFileSync(path))
      const sha = sha256Hex(bytes)
      const item = buildItem(bytes, origin, path, sha, undefined, async () => {
        return new Uint8Array(readFileSync(path))
      })
      return intern(item)
    },

    registerBytesSync(bytes, origin = "clipboard", mimeHint) {
      const copy = bytes.slice()
      const sha = sha256Hex(copy)
      const item = buildItem(copy, origin, null, sha, mimeHint, async () => copy)
      return intern(item)
    },

    get: (id) => items.get(id),
    list: () => [...items.values()].sort((a, b) => a.createdAt - b.createdAt),
    release: (id) => void items.delete(id),
    clear: () => items.clear(),
  }
}

/** Stat a path's byte size without reading it (cheap pre-check before register). */
export async function fileSize(path: string): Promise<number> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new Error(`ENOENT: ${path}`)
  return file.size
}

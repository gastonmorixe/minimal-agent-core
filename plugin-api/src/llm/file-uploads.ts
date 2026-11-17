/**
 * Provider-neutral Files API contract and upload pass.
 *
 * A provider with a file store (Anthropic Files API today; OpenAI, Grok or
 * Meta later) implements {@link ProviderFileStore}. Before it encodes a
 * request, the adapter calls {@link prepareFileUploads}: each inline base64
 * image, file, audio or video block that the store accepts and that is at
 * least the threshold is uploaded once, and its source becomes
 * `{kind:"file_id"}` in a COPY of the request. The canonical messages (and so
 * the transcript) keep the base64, so a file id is never persisted.
 *
 * Cache: keyed by store id, credential identity and the sha256 of the bytes.
 * The value is the upload promise, so concurrent sends of the same bytes share
 * one upload. Any upload error keeps the inline base64. A 400, 413 or 415 is
 * sticky (the item stays inline for good). A 401, 403 or 404 disables uploads
 * for the credential. Other errors retry on a later call.
 *
 * After a "file not found" answer, {@link evictMissingFiles} drops the cache
 * entries and {@link restoreInline} builds the retry request with only the
 * evicted ids back to base64. How to detect that answer is provider-specific
 * (the store's optional `isMissingFileError`).
 *
 * @module llm/file-uploads
 */

import { createHash } from "node:crypto"

import type {
  CanonicalBlock,
  CanonicalMessage,
  ToolResultContentBlock,
} from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

/** One uploaded file: the provider id and its expiry (epoch ms), when known. */
export interface UploadedFile {
  id: string
  expiresAt?: number
}

/** The input of {@link ProviderFileStore.upload}. */
export interface FileUploadInput {
  bytes: Uint8Array
  filename: string
  /** The MIME type to upload (after {@link ProviderFileStore.uploadMimeType}). */
  mimeType: string
  /** Requested lifetime in seconds. The store may clamp it. */
  expiresInSeconds: number
  signal?: AbortSignal
}

/**
 * A provider file store. Implemented by a provider plugin; the upload pass is
 * shared. An implementation throws {@link FileStoreError} (or any error with
 * a numeric `status`) so the pass can classify the failure.
 */
export interface ProviderFileStore {
  /** Cache namespace, usually the provider id. */
  readonly id: string
  /** True when this store can serve a file of `mime` to `modelId`. */
  accepts(mime: string, modelId: string): boolean
  /**
   * Optional: the MIME type to upload for an accepted type (for example
   * `text/csv` to `text/plain`). Omitted: the type is sent as it is.
   */
  uploadMimeType?(mime: string): string
  /** Upload one file and return its id. */
  upload(input: FileUploadInput): Promise<UploadedFile>
  /** Optional: read the metadata of one file, or null when it is gone. */
  metadata?(id: string, signal?: AbortSignal): Promise<UploadedFile | null>
  /** Delete one file. */
  delete(id: string, signal?: AbortSignal): Promise<void>
  /**
   * Optional: true when a provider error answer means that a file id of the
   * request is gone (for example a 404 that names a file id).
   */
  isMissingFileError?(status: number, body: string, usedIds: Iterable<string>): boolean
}

/** A failed store call. `status` is the HTTP status, or 0 for a transport failure. */
export class FileStoreError extends Error {
  /** HTTP status, or 0. */
  readonly status: number

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "FileStoreError"
    this.status = status
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Upload statuses that will not change on a retry: the item stays inline for good. */
export const STICKY_INLINE_STATUSES: ReadonlySet<number> = new Set([400, 413, 415])

/** Upload statuses that disable the store for the credential. */
const DISABLING_STATUSES: ReadonlySet<number> = new Set([401, 403, 404])

/** Cache value: the uploaded file id, or null when the upload failed for good. */
export type UploadCacheEntry = Promise<string | null>

/** The upload cache of {@link prepareFileUploads}. One per process is the default. */
export interface FileUploadCache {
  /** Key: store id, credential identity, sha256. Value: the upload promise. */
  readonly uploads: Map<string, UploadCacheEntry>
  /** `storeId:credential` pairs for which the store refused auth or is absent. */
  readonly disabled: Set<string>
}

/** A new, empty upload cache. */
export function createFileUploadCache(): FileUploadCache {
  return { uploads: new Map(), disabled: new Set() }
}

const processCache = createFileUploadCache()

/** Test seam: clear the process-wide upload cache. */
export function _resetFileUploadCacheForTest(): void {
  processCache.uploads.clear()
  processCache.disabled.clear()
}

/** Delete a cache entry only when it is still the given promise. */
function deleteIfSame(cache: FileUploadCache, key: string, entry: UploadCacheEntry): void {
  if (cache.uploads.get(key) === entry) cache.uploads.delete(key)
}

// ---------------------------------------------------------------------------
// Upload pass
// ---------------------------------------------------------------------------

/** Default `expiresInSeconds` of an upload: 24 h (the cache lives for the process). */
export const DEFAULT_UPLOAD_EXPIRES_IN_SECONDS = 86_400

/** Options of {@link prepareFileUploads}. */
export interface FileUploadOptions {
  /**
   * A stable identity of the credential that is not the secret (for example a
   * hash of the key). Uploads are cached per credential.
   */
  credential: string
  /** Decoded-size threshold in bytes. Smaller items stay inline. Default 0. */
  thresholdBytes?: number
  /** Upload lifetime. Default {@link DEFAULT_UPLOAD_EXPIRES_IN_SECONDS}. */
  expiresInSeconds?: number
  /** The model id for `accepts`. Default `req.modelId`. */
  modelId?: string
  /** The cache. Default: the process-wide cache. */
  cache?: FileUploadCache
  /** Called once per failed upload (for a debug sink). */
  onError?: (err: unknown) => void
}

/** A file id that the wire request uses: its cache key and the entry that made it. */
export interface UsedFile {
  key: string
  entry: UploadCacheEntry
}

/** The wire copy of the request plus the file ids it uses. */
export interface PreparedFileUploads {
  req: CanonicalRequest
  /** File id to its cache key and entry, for eviction after a missing-file error. */
  used: Map<string, UsedFile>
  /** The cache that holds the entries. */
  cache: FileUploadCache
}

/** One inline item that may be uploaded. */
interface Candidate {
  data: string
  mimeType: string
  filename?: string
}

/** The inline base64 payload of a block, or undefined when it has none. */
function inlineOf(block: CanonicalBlock | ToolResultContentBlock): Candidate | undefined {
  switch (block.type) {
    case "image":
    case "video":
      return block.source.kind === "base64"
        ? { data: block.source.data, mimeType: block.source.mediaType.toLowerCase() }
        : undefined
    case "file":
      return block.source.kind === "base64"
        ? {
            data: block.source.data,
            mimeType: block.source.mediaType.toLowerCase(),
            filename: block.source.filename,
          }
        : undefined
    case "audio": {
      const src = block.source
      if (src.kind !== "base64") return undefined
      const mime = (src.mediaType ?? `audio/${src.format}`).toLowerCase()
      return { data: src.data, mimeType: mime }
    }
    default:
      return undefined
  }
}

/** Decoded byte count of a base64 string, without decoding it. */
function base64DecodedSize(data: string): number {
  const len = data.length
  if (len === 0) return 0
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  return Math.floor((len * 3) / 4) - pad
}

/** File extension for a generated upload filename. */
function extensionFor(mime: string): string {
  const sub = mime.split("/")[1] ?? "bin"
  if (sub === "jpeg") return "jpg"
  if (sub === "plain") return "txt"
  if (sub === "mpeg") return mime.startsWith("audio/") ? "mp3" : "mpeg"
  return sub.replace(/[^a-z0-9]/gi, "") || "bin"
}

/** True when an error (or one of its causes) is an abort. */
function abortErrorOf(err: unknown): unknown {
  for (let e: unknown = err, i = 0; e instanceof Error && i < 4; e = e.cause, i++) {
    if (e.name === "AbortError") return e
  }
  return undefined
}

/** True when the signal is present and aborted (read fresh on each call). */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** The HTTP status of a store error, or 0. */
function statusOf(err: unknown): number {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === "number" ? s : 0
}

/** One upload job. */
interface UploadJob {
  key: string
  cand: Candidate
  sha: string
  bytes: Uint8Array
}

/** Shared per-call state. */
interface CallState {
  store: ProviderFileStore
  cache: FileUploadCache
  disableKey: string
  signal: AbortSignal | undefined
  expiresInSeconds: number
  onError: ((err: unknown) => void) | undefined
}

/**
 * Upload one item (or join an in-flight upload). The entry resolves to the
 * file id, or null for a failure (inline fallback). It rejects only for an
 * abort, and an aborted entry is never left in the cache.
 */
function uploadOnce(job: UploadJob, st: CallState): UploadCacheEntry {
  const cached = st.cache.uploads.get(job.key)
  if (cached) return cached
  const { cand, sha } = job
  const mimeType = st.store.uploadMimeType?.(cand.mimeType) ?? cand.mimeType
  const filename = cand.filename ?? `ma-${sha.slice(0, 16)}.${extensionFor(mimeType)}`
  const p: UploadCacheEntry = st.store
    .upload({
      bytes: job.bytes,
      filename,
      mimeType,
      expiresInSeconds: st.expiresInSeconds,
      signal: st.signal,
    })
    .then(
      (meta) => meta.id,
      (err: unknown) => {
        const abort = abortErrorOf(err)
        if (isAborted(st.signal) || abort !== undefined) {
          deleteIfSame(st.cache, job.key, p)
          throw abort ?? err
        }
        st.onError?.(err)
        const status = statusOf(err)
        if (DISABLING_STATUSES.has(status)) st.cache.disabled.add(st.disableKey)
        if (!STICKY_INLINE_STATUSES.has(status)) deleteIfSame(st.cache, job.key, p)
        return null
      },
    )
  st.cache.uploads.set(job.key, p)
  return p
}

/**
 * Wait for one job. An abort of THIS call rethrows. An abort that came from
 * another caller that owned the shared upload starts one fresh upload.
 */
async function settle(job: UploadJob, entry: UploadCacheEntry, st: CallState): Promise<string | null> {
  try {
    return await entry
  } catch (err) {
    if (isAborted(st.signal)) throw err
    try {
      return await uploadOnce(job, st)
    } catch (again) {
      if (isAborted(st.signal)) throw again
      return null
    }
  }
}

/**
 * Upload qualifying inline media (image, file, audio, video; also images in a
 * `tool_result`) and return a wire copy of the request with `file_id`
 * sources. The input request is never changed. Never throws for an upload
 * failure: the item stays inline. Throws only when `req.signal` aborts.
 *
 * @param req - The canonical request (not mutated).
 * @param store - The provider file store.
 * @param opts - Credential identity, threshold, expiry, cache.
 * @returns The wire request and the file ids it uses.
 */
export async function prepareFileUploads(
  req: CanonicalRequest,
  store: ProviderFileStore,
  opts: FileUploadOptions,
): Promise<PreparedFileUploads> {
  const cache = opts.cache ?? processCache
  const used = new Map<string, UsedFile>()
  const disableKey = `${store.id}:${opts.credential}`
  if (cache.disabled.has(disableKey)) return { req, used, cache }
  const modelId = opts.modelId ?? req.modelId
  const threshold = opts.thresholdBytes ?? 0
  const st: CallState = {
    store,
    cache,
    disableKey,
    signal: req.signal,
    expiresInSeconds: opts.expiresInSeconds ?? DEFAULT_UPLOAD_EXPIRES_IN_SECONDS,
    onError: opts.onError,
  }

  const jobs = new Map<string, { job: UploadJob; entry: UploadCacheEntry }>()
  const keyOf = (block: CanonicalBlock | ToolResultContentBlock): string | undefined => {
    const cand = inlineOf(block)
    if (!cand || !store.accepts(cand.mimeType, modelId)) return undefined
    if (base64DecodedSize(cand.data) < threshold) return undefined
    const bytes = Buffer.from(cand.data, "base64")
    const sha = createHash("sha256").update(bytes).digest("hex")
    const key = `${disableKey}:${sha}`
    if (!jobs.has(key)) {
      const job: UploadJob = { key, cand, sha, bytes }
      jobs.set(key, { job, entry: uploadOnce(job, st) })
    }
    return key
  }

  // Pass 1: start every upload (deduped by key). Pass 2: swap sources.
  const keys = new Map<object, string>()
  for (const msg of req.messages) {
    for (const block of msg.content) {
      const k = keyOf(block)
      if (k) keys.set(block, k)
      if (block.type === "tool_result") {
        for (const inner of block.content) {
          const ik = keyOf(inner)
          if (ik) keys.set(inner, ik)
        }
      }
    }
  }
  if (keys.size === 0) return { req, used, cache }

  const ids = new Map<string, string | null>()
  const settled = await Promise.allSettled(
    [...jobs].map(async ([key, { job, entry }]) => {
      ids.set(key, await settle(job, entry, st))
    }),
  )
  for (const r of settled) if (r.status === "rejected") throw r.reason

  const swap = <B extends CanonicalBlock | ToolResultContentBlock>(block: B): B => {
    const key = keys.get(block)
    const id = key ? ids.get(key) : undefined
    if (!key || !id) return block
    const entry = cache.uploads.get(key)
    if (entry) used.set(id, { key, entry })
    return { ...block, source: { kind: "file_id", fileId: id } }
  }
  const messages: CanonicalMessage[] = req.messages.map((msg) => ({
    ...msg,
    content: msg.content.map((block) =>
      block.type === "tool_result" ? { ...block, content: block.content.map(swap) } : swap(block),
    ),
  }))
  if (used.size === 0) return { req, used, cache }
  return { req: { ...req, messages }, used, cache }
}

// ---------------------------------------------------------------------------
// Missing-file recovery (404 evict and retry)
// ---------------------------------------------------------------------------

/**
 * Drop the cache entries of the file ids named in an error body. When the
 * body names none of them, drop every entry the request used. An entry is
 * dropped only when the cache still holds the same promise (a newer upload is
 * kept).
 *
 * @param prepared - The result of {@link prepareFileUploads}.
 * @param body - The error response body.
 * @returns The evicted file ids.
 */
export function evictMissingFiles(prepared: PreparedFileUploads, body: string): Set<string> {
  const named = [...prepared.used].filter(([id]) => body.includes(id))
  const evicted = named.length > 0 ? named : [...prepared.used]
  for (const [, { key, entry }] of evicted) deleteIfSame(prepared.cache, key, entry)
  return new Set(evicted.map(([id]) => id))
}

/** The file id of a block source, or undefined. */
function fileIdOf(block: CanonicalBlock | ToolResultContentBlock): string | undefined {
  switch (block.type) {
    case "image":
    case "file":
    case "audio":
    case "video":
      return block.source.kind === "file_id" ? block.source.fileId : undefined
    default:
      return undefined
  }
}

/**
 * The retry request after a missing-file error: the wire request with only
 * the evicted file ids put back to their inline base64. Other file ids stay.
 *
 * @param original - The canonical request (base64 sources).
 * @param wire - The wire request from {@link prepareFileUploads}.
 * @param evicted - The evicted file ids, from {@link evictMissingFiles}.
 * @returns The retry request.
 */
export function restoreInline(
  original: CanonicalRequest,
  wire: CanonicalRequest,
  evicted: ReadonlySet<string>,
): CanonicalRequest {
  const pick = <B extends CanonicalBlock | ToolResultContentBlock>(w: B, o: B | undefined): B => {
    const id = fileIdOf(w)
    return o !== undefined && id !== undefined && evicted.has(id) ? o : w
  }
  const messages = wire.messages.map((msg, mi) => {
    const omsg = original.messages[mi]
    return {
      ...msg,
      content: msg.content.map((block, bi) => {
        const ob = omsg?.content[bi]
        if (block.type === "tool_result" && ob?.type === "tool_result") {
          return { ...block, content: block.content.map((inner, ii) => pick(inner, ob.content[ii])) }
        }
        return pick(block, ob)
      }),
    }
  })
  return { ...wire, messages }
}

/**
 * One step of 404 evict-and-retry: when `store.isMissingFileError` says the
 * answer is about a missing file, evict those ids and return the retry
 * request. Else return null (the caller reports the error as it is).
 *
 * @param original - The canonical request (base64 sources).
 * @param prepared - The result of {@link prepareFileUploads}.
 * @param store - The file store (for its missing-file check).
 * @param status - The HTTP status of the failed call.
 * @param body - The error response body.
 * @returns The retry request, or null.
 */
export function retryAfterMissingFile(
  original: CanonicalRequest,
  prepared: PreparedFileUploads,
  store: ProviderFileStore,
  status: number,
  body: string,
): CanonicalRequest | null {
  if (prepared.used.size === 0) return null
  const missing = store.isMissingFileError
    ? store.isMissingFileError(status, body, prepared.used.keys())
    : status === 404
  if (!missing) return null
  return restoreInline(original, prepared.req, evictMissingFiles(prepared, body))
}

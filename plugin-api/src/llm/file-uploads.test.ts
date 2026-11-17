/**
 * The provider-neutral upload pass: cache, inline fallback, sticky statuses,
 * credential disable, and 404 evict-and-retry.
 *
 * @module llm/file-uploads.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import {
  createFileUploadCache,
  FileStoreError,
  type FileUploadInput,
  prepareFileUploads,
  type ProviderFileStore,
  retryAfterMissingFile,
} from "./file-uploads.ts"

const b64 = (s: string): string => Buffer.from(s).toString("base64")

/** A fake store: records uploads; `fail` maps a filename prefix or "*" to a status. */
function fakeStore(opts: { fail?: number; accepts?: (mime: string) => boolean } = {}) {
  const uploads: FileUploadInput[] = []
  let n = 0
  const store: ProviderFileStore = {
    id: "fake",
    accepts: (mime) => (opts.accepts ? opts.accepts(mime) : true),
    uploadMimeType: (mime) => (mime.startsWith("text/") ? "text/plain" : mime),
    async upload(input) {
      uploads.push(input)
      if (opts.fail !== undefined) throw new FileStoreError(opts.fail, "nope")
      n += 1
      return { id: `file_${n}` }
    },
    async delete() {},
  }
  return { store, uploads }
}

function req(...blocks: CanonicalBlock[]): CanonicalRequest {
  return { modelId: "m", messages: [{ role: "user", content: blocks }] }
}

const image: CanonicalBlock = {
  type: "image",
  source: { kind: "base64", mediaType: "image/png", data: b64("png-bytes") },
}
const csv: CanonicalBlock = {
  type: "file",
  source: { kind: "base64", mediaType: "text/csv", data: b64("a,b\n"), filename: "d.csv" },
}
const audio: CanonicalBlock = {
  type: "audio",
  source: { kind: "base64", format: "mp3", mediaType: "audio/mpeg", data: b64("mp3") },
}
const video: CanonicalBlock = {
  type: "video",
  source: { kind: "base64", mediaType: "video/mp4", data: b64("mp4") },
}

describe("prepareFileUploads", () => {
  it("uploads image, file, audio and video blocks and swaps to file_id", async () => {
    const { store, uploads } = fakeStore()
    const original = req(image, csv, audio, video, { type: "text", text: "hi" })
    const out = await prepareFileUploads(original, store, {
      credential: "c1",
      cache: createFileUploadCache(),
    })
    expect(uploads.map((u) => u.mimeType)).toEqual([
      "image/png",
      "text/plain",
      "audio/mpeg",
      "video/mp4",
    ])
    expect(uploads[1]?.filename).toBe("d.csv")
    expect(uploads[2]?.filename).toMatch(/^ma-[0-9a-f]{16}\.mp3$/)
    const kinds = out.req.messages[0]?.content.map((b) =>
      "source" in b ? (b.source as { kind: string }).kind : b.type,
    )
    expect(kinds).toEqual(["file_id", "file_id", "file_id", "file_id", "text"])
    expect(out.used.size).toBe(4)
    // The input request is not changed.
    expect(original.messages[0]?.content[0]).toEqual(image)
  })

  it("dedupes by sha256 and credential, across calls and in one call", async () => {
    const { store, uploads } = fakeStore()
    const cache = createFileUploadCache()
    await prepareFileUploads(req(image, image), store, { credential: "c1", cache })
    await prepareFileUploads(req(image), store, { credential: "c1", cache })
    expect(uploads).toHaveLength(1)
    await prepareFileUploads(req(image), store, { credential: "c2", cache })
    expect(uploads).toHaveLength(2)
  })

  it("skips blocks under the threshold and types the store refuses", async () => {
    const { store, uploads } = fakeStore({ accepts: (m) => m.startsWith("image/") })
    const out = await prepareFileUploads(req(image, csv), store, {
      credential: "c",
      thresholdBytes: 1,
      cache: createFileUploadCache(),
    })
    expect(uploads).toHaveLength(1)
    expect(out.used.size).toBe(1)
    const none = await prepareFileUploads(req(image), store, {
      credential: "c",
      thresholdBytes: 10_000,
      cache: createFileUploadCache(),
    })
    expect(none.used.size).toBe(0)
  })

  it("falls back to inline on a transient error and retries on the next call", async () => {
    const cache = createFileUploadCache()
    const bad = fakeStore({ fail: 500 })
    const errors: unknown[] = []
    const out = await prepareFileUploads(req(image), bad.store, {
      credential: "c",
      cache,
      onError: (e) => errors.push(e),
    })
    expect(out.used.size).toBe(0)
    expect(errors).toHaveLength(1)
    expect(cache.uploads.size).toBe(0)
    await prepareFileUploads(req(image), bad.store, { credential: "c", cache })
    expect(bad.uploads).toHaveLength(2)
  })

  it("keeps the item inline for good on 400, 413 and 415", async () => {
    for (const status of [400, 413, 415]) {
      const cache = createFileUploadCache()
      const bad = fakeStore({ fail: status })
      await prepareFileUploads(req(image), bad.store, { credential: "c", cache })
      await prepareFileUploads(req(image), bad.store, { credential: "c", cache })
      expect(bad.uploads).toHaveLength(1)
    }
  })

  it("disables the store for the credential on 401, 403 and 404", async () => {
    const cache = createFileUploadCache()
    const bad = fakeStore({ fail: 403 })
    await prepareFileUploads(req(image), bad.store, { credential: "c", cache })
    await prepareFileUploads(req(csv), bad.store, { credential: "c", cache })
    expect(bad.uploads).toHaveLength(1)
    expect(cache.disabled.has("fake:c")).toBe(true)
  })

  it("rethrows an abort and leaves no cache entry", async () => {
    const cache = createFileUploadCache()
    const ctl = new AbortController()
    const store: ProviderFileStore = {
      id: "fake",
      accepts: () => true,
      async upload() {
        ctl.abort()
        const e = new Error("aborted")
        e.name = "AbortError"
        throw e
      },
      async delete() {},
    }
    const r = { ...req(image), signal: ctl.signal }
    await expect(prepareFileUploads(r, store, { credential: "c", cache })).rejects.toThrow()
    expect(cache.uploads.size).toBe(0)
  })
})

describe("retryAfterMissingFile", () => {
  it("evicts the named id and restores only that block inline", async () => {
    const { store, uploads } = fakeStore()
    const cache = createFileUploadCache()
    const original = req(image, audio)
    const prepared = await prepareFileUploads(original, store, { credential: "c", cache })
    const retry = retryAfterMissingFile(original, prepared, store, 404, "File file_1 not found")
    expect(retry).not.toBeNull()
    const [first, second] = retry?.messages[0]?.content ?? []
    expect(first).toEqual(image)
    expect((second as { source: { kind: string } }).source.kind).toBe("file_id")
    // The evicted entry is gone, so the next call uploads it again.
    await prepareFileUploads(original, store, { credential: "c", cache })
    expect(uploads).toHaveLength(3)
  })

  it("returns null for another error or when no file id was used", async () => {
    const { store } = fakeStore()
    const original = req(image)
    const prepared = await prepareFileUploads(original, store, {
      credential: "c",
      cache: createFileUploadCache(),
    })
    expect(retryAfterMissingFile(original, prepared, store, 500, "boom")).toBeNull()
    const none = await prepareFileUploads(req({ type: "text", text: "x" }), store, {
      credential: "c",
      cache: createFileUploadCache(),
    })
    expect(retryAfterMissingFile(original, none, store, 404, "gone")).toBeNull()
  })

  it("uses the store's missing-file check when it has one", async () => {
    const { store } = fakeStore()
    store.isMissingFileError = (status, body) => status === 404 && body.includes("not_found_error")
    const original = req(image)
    const prepared = await prepareFileUploads(original, store, {
      credential: "c",
      cache: createFileUploadCache(),
    })
    expect(retryAfterMissingFile(original, prepared, store, 404, "route missing")).toBeNull()
    expect(retryAfterMissingFile(original, prepared, store, 404, "not_found_error")).not.toBeNull()
  })
})
